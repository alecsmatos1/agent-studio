import { z } from 'zod';
import type { UsageSnapshot, CreditUsage } from './usage';

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const short = z.string();
const amount = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const accountUpdateSchema = z.object({
  connectionId: z.string().uuid(),
  epoch: z.string().uuid(),
  revision: time,
  accountChanged: time,
  authMode: short.nullable(),
  planType: short.nullable(),
  creditsCheckedAt: time.nullable(),
  limitStatus: z
    .object({
      status: z.enum(['allowed', 'allowed_warning', 'rejected']),
      limitType: short.nullable(),
      resetsAt: time.nullable(),
      usingOverage: z.boolean().nullable(),
      checkedAt: time,
    })
    .nullable(),
  snapshot: z.object({
    provider: z.enum(['claude', 'codex']),
    checkedAt: time,
    windows: z.array(
      z.object({
        id: z.string(),
        label: short,
        usedPercent: z.number().min(0).max(100).nullable(),
        resetsAt: z.union([time, z.string(), z.null()]),
        windowMinutes: time.nullable(),
        model: short.nullable(),
        bucket: short,
        checkedAt: time.optional(),
      }),
    ),
    credits: z
      .object({
        kind: z.literal('codex'),
        balance: amount,
        hasCredits: z.boolean().nullable(),
        unlimited: z.boolean().nullable(),
        resetCredits: time.nullable(),
      })
      .nullable(),
    context: z.null(),
    detail: z.string(),
  }),
});
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export const accountActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('workspaceMessages') }).strict(),
  z
    .object({
      action: z.literal('consumeResetCredit'),
      idempotencyKey: z.string().uuid(),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type AccountAction = z.infer<typeof accountActionSchema>;
export const workspaceMessagesSchema = z.object({
  featureEnabled: z.boolean(),
  messages: z.array(z.object({ messageId: z.string(), messageBody: z.string() })),
});
export type WorkspaceMessages = z.infer<typeof workspaceMessagesSchema>;

// Connection IDs belong to one execution host. The transport additionally checks that host
// against the authenticated workspace before passing an update to this sequence gate.
export class AccountUpdateGate {
  private latest = new Map<string, AccountUpdate>();
  private retired = new Map<string, Set<string>>();
  clear() {
    this.latest.clear();
    this.retired.clear();
  }
  get(connection: string) {
    return this.latest.get(connection);
  }
  accept(update: AccountUpdate) {
    const previous = this.latest.get(update.connectionId);
    if (previous?.epoch === update.epoch && previous.revision >= update.revision) return false;
    if (this.retired.get(update.connectionId)?.has(update.epoch)) return false;
    if (previous && previous.epoch !== update.epoch) {
      if (update.snapshot.checkedAt < previous.snapshot.checkedAt) return false;
      const epochs = this.retired.get(update.connectionId) ?? new Set<string>();
      epochs.add(previous.epoch);
      this.retired.set(update.connectionId, epochs);
    }
    this.latest.set(update.connectionId, update);
    return true;
  }
}
function credits(previous: CreditUsage | null | undefined, next: CreditUsage | null | undefined) {
  if (!next) return previous;
  if (!previous || previous.kind !== next.kind) return next;
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      value ?? (previous as unknown as Record<string, unknown>)[key],
    ]),
  ) as CreditUsage;
}
export function mergeLiveUsage(
  previous: UsageSnapshot | undefined,
  update: AccountUpdate,
): UsageSnapshot {
  if (
    previous?.connectionId !== update.connectionId ||
    previous?.provider !== update.snapshot.provider
  )
    previous = undefined;
  const windows = new Map(
    (previous?.windows ?? []).map((w) => [
      w.id,
      { ...w, checkedAt: w.checkedAt ?? previous!.checkedAt },
    ]),
  );
  for (const w of update.snapshot.windows) {
    const old = windows.get(w.id);
    const at = w.checkedAt ?? update.snapshot.checkedAt;
    if (old && at < old.checkedAt) continue;
    windows.set(w.id, {
      ...w,
      checkedAt: w.usedPercent == null ? (old?.checkedAt ?? at) : at,
      label: w.windowMinutes == null ? (old?.label ?? w.label) : w.label,
      model: w.model ?? old?.model ?? null,
      usedPercent: w.usedPercent ?? old?.usedPercent ?? null,
      resetsAt: w.resetsAt ?? old?.resetsAt ?? null,
      windowMinutes: w.windowMinutes ?? old?.windowMinutes ?? null,
    });
  }
  const useCredits =
    update.creditsCheckedAt != null &&
    update.creditsCheckedAt >= (previous?.creditsCheckedAt ?? previous?.checkedAt ?? 0);
  return {
    ...previous,
    ...update.snapshot,
    // An update names only the limits it concerns: without an earlier reading, which limits the
    // account has stays unknown until a read-only reading lists them.
    ...(previous ? {} : { partial: true }),
    connectionId: update.connectionId,
    checkedAt: Math.max(previous?.checkedAt ?? 0, update.snapshot.checkedAt),
    windows: [...windows.values()],
    context: previous?.context ?? null,
    credits: useCredits ? credits(previous?.credits, update.snapshot.credits) : previous?.credits,
    creditsCheckedAt: useCredits ? update.creditsCheckedAt! : previous?.creditsCheckedAt,
    live: {
      accountChanged: `${update.epoch}:${update.accountChanged}`,
      authMode: update.authMode,
      planType: update.planType,
      limitStatus: update.limitStatus,
    },
  };
}
export function canResetUsage(snapshot?: UsageSnapshot) {
  return (
    snapshot?.provider === 'codex' &&
    snapshot.credits?.kind === 'codex' &&
    (snapshot.credits.resetCredits ?? 0) > 0 &&
    snapshot.windows.some(
      (w) =>
        w.bucket === 'codex' &&
        [300, 10080].includes(w.windowMinutes ?? 0) &&
        (w.usedPercent ?? 0) >= 90,
    )
  );
}
