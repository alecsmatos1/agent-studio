import { z } from 'zod';
import type { Conversation, Message, TokenUsage } from './domain';

const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const pointSchema = z.object({
  checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  windows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      usedPercent: z.number().min(0).max(100).nullable(),
      resetsAt: z.union([z.string(), amount]),
    }),
  ),
  balance: amount,
  extraUsed: amount,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
});
export const accountUsageSchema = z.object({
  version: z.literal(1),
  revision: z.union([z.literal(1), z.literal(2)]),
  runId: z.string().uuid(),
  before: pointSchema.nullable(),
  after: pointSchema.nullable(),
  runDurationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;
export function latestAccountUsage(a?: AccountUsage, b?: AccountUsage) {
  return !a ? b : !b || a.runId !== b.runId || a.revision >= b.revision ? a : b;
}
export function latestTokenUsage(a?: TokenUsage, b?: TokenUsage) {
  return (b?.revision ?? -1) > (a?.revision ?? -1) ? b : a;
}

export function chatSpend(conversation: Conversation) {
  const replies = conversation.messages.filter((m) => m.role === 'assistant');
  const provider = conversation.settings.provider;
  // A fresh Codex process resumes each reply with reset token counters. Only
  // newly scoped readings have verified per-reply semantics; don't sum legacy
  // counters from unknown adapter versions. Billing estimates stay session-wide.
  const measured =
    provider === 'codex' ? replies.filter((m) => m.usage?.scope === 'reply') : replies;
  // Claude replies saved before costs were reply-scoped hold the CLI's running total.
  const priced = replies.filter((m) => m.usage?.scope === 'reply');
  const runningTotals = replies.filter(
    (m) => provider === 'claude' && m.usage?.costUsd != null && m.usage.scope !== 'reply',
  ).length;
  const latest = replies.at(-1)?.usage;
  const sum = (key: 'input' | 'output' | 'costUsd', from = measured) => {
    const values = from.flatMap((m) => (m.usage?.[key] == null ? [] : [m.usage[key]!]));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const missing = replies.filter(
    (m) =>
      m.usage?.input == null ||
      m.usage?.output == null ||
      (provider === 'codex' ? m.usage?.scope !== 'reply' : m.usage?.costUsd == null) ||
      (provider === 'claude' && m.usage?.scope !== 'reply') ||
      m.status === 'running',
  ).length;
  return {
    input: sum('input'),
    output: sum('output'),
    cost:
      provider === 'codex'
        ? (latest?.sessionCostUsd ?? null)
        : sum('costUsd', provider === 'claude' ? priced : measured),
    credits: provider === 'codex' ? (latest?.sessionCredits ?? null) : null,
    // Older Claude replies saved the conversation's running cost total; leaving it out makes the
    // total incomplete too.
    partial: missing > 0 || runningTotals > 0,
  };
}
function resetMs(value: string | number | null) {
  if (value == null) return NaN;
  return typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
}
export function accountChanges(message?: Message) {
  const observation = message?.accountUsage;
  const before = observation?.before,
    after = observation?.after;
  if (!before || !after || after.checkedAt < before.checkedAt) return [];
  // A limit neither reading reports with a share used is not shown, as the usage bars show none
  // (docs/USAGE.md); one reported by only one of them is not comparable.
  const reported = before.windows.filter(
    (w) =>
      w.usedPercent != null ||
      after.windows.some((n) => n.id === w.id && n.usedPercent != null),
  );
  const rows: { label: string; value: string }[] = reported.map((w) => {
    const next = after.windows.find((n) => n.id === w.id);
    const end = resetMs(w.resetsAt);
    const valid =
      next &&
      Number.isFinite(end) &&
      end === resetMs(next.resetsAt) &&
      end > after.checkedAt * 1000 &&
      w.usedPercent != null &&
      next.usedPercent != null &&
      next.usedPercent >= w.usedPercent;
    return {
      label: w.label,
      value: valid
        ? `+${Number((next.usedPercent! - w.usedPercent!).toFixed(3))} percentage points`
        : 'Not comparable (reset or missing reading)',
    };
  });
  if (before.balance != null && after.balance != null)
    rows.push({
      label: 'Account credit balance',
      value: `${Number((after.balance - before.balance).toFixed(6)) >= 0 ? '+' : ''}${Number((after.balance - before.balance).toFixed(6))} credits`,
    });
  if (
    before.extraUsed != null &&
    after.extraUsed != null &&
    before.currency &&
    before.currency === after.currency
  ) {
    // Claude supplies no reset identity for this monthly total. Keep the raw
    // observed change visibly distinct from attributed spend, including resets.
    const delta = after.extraUsed - before.extraUsed;
    rows.push({
      label: 'Account extra usage',
      value: `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta), before.currency)}`,
    });
  }
  return rows;
}
export function money(value: number | null, currency = 'USD'): string {
  if (value != null && value > 0 && value < 0.000001) return `<${money(0.000001, currency)}`;
  return value == null
    ? 'Not reported'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 6,
      }).format(value);
}
