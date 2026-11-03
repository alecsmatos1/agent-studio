import {
  historyFor,
  messageText,
  type ProviderId,
  type ChatSettings,
  type Conversation,
  type RunRequest,
} from './domain';
import type { ModelInfo } from './models';
import { syntheticModel } from './usage-limits';

// User-provided pack prices (2026-09-14): USD 100/2,500, 200/5,000, 1,000/25,000.
// This is a displayed-price estimate; the screenshot does not establish checkout discounts.
const CODEX_CREDIT_USD_RATE = 0.04;

export type LimitWindow = {
  checkedAt?: number;
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | number | null;
  windowMinutes: number | null;
  model: string | null;
  bucket: string;
};
export type UsageSnapshot = {
  creditsCheckedAt?: number;
  /**
   * Made from live account updates alone, which name only the limits they concern, so it does
   * not say which limits its account has. A read-only reading lists them all.
   */
  partial?: boolean;
  live?: {
    accountChanged: string;
    authMode: string | null;
    planType: string | null;
    limitStatus: {
      status: string;
      limitType: string | null;
      resetsAt: number | null;
      usingOverage: boolean | null;
      checkedAt: number;
    } | null;
  };
  connectionId?: string;
  provider: string;
  checkedAt: number;
  windows: LimitWindow[];
  context: { model: string; tokens: number; source: string } | null;
  credits?: CreditUsage | null;
  detail: string;
};
export type CreditUsage =
  | {
      kind: 'codex';
      balance: number | null;
      hasCredits: boolean | null;
      unlimited: boolean | null;
      resetCredits: number | null;
    }
  | {
      kind: 'claude';
      enabled: boolean | null;
      used: number | null;
      limit: number | null;
      currency: string | null;
      usedPercent: number | null;
    };

export function creditReading(provider: ProviderId, snapshot?: UsageSnapshot) {
  if (provider !== 'claude' && provider !== 'codex') return null;
  const credits =
    snapshot?.provider === provider && snapshot.credits?.kind === provider
      ? snapshot.credits
      : null;
  const numeric = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const rows: { label: string; value: string }[] = [];
  let value = 'Not reported';
  if (credits?.kind === 'codex') {
    value =
      credits.unlimited === true
        ? 'Unlimited'
        : numeric(credits.balance)
          ? `${new Intl.NumberFormat('en', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
              roundingMode: 'trunc',
            }).format(credits.balance)} credits`
          : credits.hasCredits === true
            ? 'Available'
            : credits.hasCredits === false
              ? 'No credits'
              : 'Not reported';
    if (credits.unlimited !== true && numeric(credits.balance)) {
      const usd = credits.balance * CODEX_CREDIT_USD_RATE;
      rows.push({
        label: `Estimated value (US$${CODEX_CREDIT_USD_RATE.toFixed(2)} per credit)`,
        value:
          credits.balance > 0 && usd < 0.01
            ? '<$0.01'
            : new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'USD',
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }).format(usd),
      });
    }
    if (numeric(credits.resetCredits))
      rows.push({ label: 'Usage resets available', value: String(credits.resetCredits) });
  } else if (credits?.kind === 'claude') {
    const money = (n: number | null) => {
      if (!numeric(n) || !credits.currency || !/^[A-Z]{3}$/.test(credits.currency))
        return 'Not reported';
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: credits.currency,
        currencyDisplay: 'code',
        maximumFractionDigits: 6,
      }).format(n);
    };
    const spent = money(credits.used);
    value =
      credits.enabled === false
        ? 'Disabled'
        : spent !== 'Not reported'
          ? `${spent} spent`
          : credits.enabled === true
            ? 'Enabled'
            : 'Not reported';
    rows.push({
      label: 'Extra usage',
      value:
        credits.enabled === true
          ? 'Enabled'
          : credits.enabled === false
            ? 'Disabled'
            : 'Not reported',
    });
    rows.push({ label: 'Spent this month', value: spent });
    rows.push({ label: 'Monthly spending cap', value: money(credits.limit) });
    if (numeric(credits.used) && numeric(credits.limit))
      rows.push({
        label: 'Remaining under cap',
        value: money(Math.max(0, credits.limit - credits.used)),
      });
    if (numeric(credits.usedPercent))
      rows.push({ label: 'Spending cap used', value: percentage(credits.usedPercent) });
  }
  return { value, rows };
}
export const usageKey = (settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'>) =>
  `${settings.provider}:${settings.model}${settings.connectionId ? `:${settings.connectionId}` : ''}`;
export function snapshotFor(
  snapshots: Record<string, UsageSnapshot>,
  settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'>,
): UsageSnapshot | undefined {
  const exact = snapshots[usageKey(settings)];
  let latest = exact;
  // The newest reading that lists every limit of the account.
  let complete = exact?.partial ? undefined : exact;
  for (const snapshot of Object.values(snapshots)) {
    if (snapshot.provider !== settings.provider || snapshot.connectionId !== settings.connectionId)
      continue;
    if (!latest || snapshot.checkedAt > latest.checkedAt) latest = snapshot;
    if (!snapshot.partial && (!complete || snapshot.checkedAt > complete.checkedAt))
      complete = snapshot;
  }
  if (!latest) return undefined;
  // Account quotas belong to the provider; context capacities belong to the selected model.
  const account = { ...latest, context: exact?.context ?? null };
  // Newer live updates name only the limits they concern; the account's other limits are those
  // its newest complete reading lists, each as old as that reading.
  const reading = complete;
  if (account.partial && reading) {
    const newer = new Set(account.windows.map((window) => window.id));
    account.windows = [
      ...account.windows,
      ...reading.windows
        .filter((window) => !newer.has(window.id))
        .map((window) => ({ ...window, checkedAt: window.checkedAt ?? reading.checkedAt })),
    ];
    delete account.partial;
  }
  return account;
}
export const compactTokens = (n: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const percentage = (n: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n)}%`;
export function resetTime(value: LimitWindow['resetsAt']): number | null {
  const time = typeof value === 'number' ? value * 1000 : value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}
export function resetLabel(value: LimitWindow['resetsAt'], now: number): string {
  const time = resetTime(value);
  if (!time) return 'Reset time not reported';
  if (time <= now) return 'Reset due · awaiting update';
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (date.toDateString() === new Date(now).toDateString()) return `Resets ${clock}`;
  const weekday = date.toLocaleDateString([], { weekday: 'long' });
  return `Resets ${weekday}, ${clock}`;
}
export function isFable(settings: ChatSettings, snapshot?: UsageSnapshot) {
  return (
    settings.provider === 'claude' &&
    /fable/i.test(settings.model || snapshot?.context?.model || '')
  );
}
/** Whether a reading reports a limit, with the share of it used. */
const reported = (window: LimitWindow) => window.usedPercent != null;
/**
 * The limits a chat's usage bars show: its account's 5-hour and weekly limits, and Fable weekly
 * for a Fable model, each only as the account's reading reports it. A limit the reading leaves
 * out, or names without a share used, is not shown, whatever the provider and window: Claude
 * dropped the 5-hour limit from some plans, and most Codex accounts report none. Only while a
 * first reading of the account is under way or due (`checking`), and none it has lists all its
 * limits, do the limits it may have wait in their places, unmeasured.
 */
export function visibleLimits(
  snapshot: UsageSnapshot | undefined,
  settings: ChatSettings,
  checking = false,
): LimitWindow[] {
  let windows = snapshot?.windows ?? [];
  if (settings.provider === 'codex') {
    const scoped = windows.filter(
      (w) =>
        w.model &&
        settings.model.toLowerCase().includes('spark') &&
        w.model.toLowerCase().includes('spark'),
    );
    windows = scoped.length ? scoped : windows.filter((w) => w.bucket === 'codex');
  }
  const expected = [
    { id: 'five-hour', label: '5-hour', minutes: 300, model: null },
    { id: 'weekly', label: 'Weekly', minutes: 10080, model: null },
    ...(isFable(settings, snapshot)
      ? [{ id: 'fable-weekly', label: 'Fable weekly', minutes: 10080, model: 'fable' }]
      : []),
  ];
  const waiting = checking && (!snapshot || !!snapshot.partial);
  return expected.flatMap((e): LimitWindow[] => {
    const window = windows.find(
      (w) =>
        reported(w) &&
        w.windowMinutes === e.minutes &&
        (e.model ? w.model?.toLowerCase() === e.model : !w.model || settings.provider === 'codex'),
    );
    if (window) return [window];
    return waiting
      ? [
          {
            id: e.id,
            label: e.label,
            windowMinutes: e.minutes,
            model: e.model,
            usedPercent: null,
            resetsAt: null,
            bucket: settings.provider,
          },
        ]
      : [];
  });
}
export function isStale(snapshot: UsageSnapshot | undefined, window: LimitWindow, now: number) {
  if (!snapshot) return false;
  const reset = resetTime(window.resetsAt);
  return (
    now - (window.checkedAt ?? snapshot.checkedAt) * 1000 > 180_000 ||
    (reset != null && now >= reset && (window.checkedAt ?? snapshot.checkedAt) * 1000 < reset)
  );
}
// An account view has no selected chat model. Keep model-specific quotas explicitly labelled,
// and like the chat's bars, only those the reading reports.
export function accountLimits(
  snapshot: UsageSnapshot | undefined,
  provider: ProviderId,
  checking = false,
): LimitWindow[] {
  const primary = visibleLimits(
    snapshot,
    { provider, model: '', reasoning: '', instructions: '' },
    checking,
  );
  return [
    ...primary,
    ...(snapshot?.windows ?? [])
      .filter((window) => reported(window) && !primary.some((p) => p.id === window.id))
      .map((window) => ({
        ...window,
        label:
          window.model && !window.label.toLowerCase().includes(window.model.toLowerCase())
            ? `${window.model} · ${window.label}`
            : window.label,
      })),
  ];
}
export function estimatePromptTokens(
  settings: ChatSettings,
  messages: RunRequest['messages'],
): number {
  // Explicit estimate, not a tokenizer. UTF-8 handles non-Latin text better than JS length.
  const body = JSON.stringify({
    agent_instructions: settings.instructions,
    // Image encoding is not text usage. Only provider-reported counts measure vision input.
    conversation: messages.map(({ role, text }) => ({ role, text })),
  });
  return 85 + Math.ceil(new TextEncoder().encode(body).length / 4);
}
export function contextFor(
  conversation: Conversation | undefined,
  settings: ChatSettings,
  draft: string,
  model: ModelInfo,
  snapshot?: UsageSnapshot,
) {
  const streaming = conversation?.messages.findLast(
    (m) => m.role === 'assistant' && m.status === 'running',
  );
  // The estimate of the next request reads the text of every message, so it is worked out only
  // when asked for. The usage panel shows measured counts alone, and with the estimate made on
  // every reading, each streamed event of a reply read a long conversation whole: 8 ms an event
  // in a 9.8 MB chat (docs/PERFORMANCE.md).
  let forecast: { withoutDraft: number; withDraft: number } | undefined;
  const estimates = () => {
    if (forecast) return forecast;
    const history = conversation ? historyFor(conversation) : [];
    if (streaming && messageText(streaming))
      history.push({ role: 'assistant', text: messageText(streaming) });
    const withoutDraft = estimatePromptTokens(settings, history);
    if (draft.trim()) history.push({ role: 'user', text: draft.trim() });
    return (forecast = { withoutDraft, withDraft: estimatePromptTokens(settings, history) });
  };
  const sameSettings = (other?: ChatSettings) =>
    other?.provider === settings.provider &&
    other.model === settings.model &&
    other.reasoning === settings.reasoning &&
    other.instructions === settings.instructions;
  // A pending reply keeps the last reading until it supplies a new one. A later
  // finished reply with missing usage must not silently revive an older reading.
  const latest = conversation?.messages.findLast(
    (m) =>
      m.role === 'assistant' &&
      (m.status !== 'running' ||
        m.usage?.contextInput != null ||
        m.compact ||
        m.compactions?.some((c) => c.status === 'complete')),
  );
  const compatible = sameSettings(latest?.settings);
  const compacted = latest?.compactions?.some(
    (c) => c.status === 'complete' && (c.usageRevision ?? 0) >= (latest.usage?.revision ?? 0),
  );
  // A reply saved before 2026-09-30 whose last message was Claude Code's own, such as its line
  // about a usage limit, reported that message's zero request as its context.
  const reported =
    compatible && !compacted && !latest?.compact && latest?.usage?.model !== syntheticModel
      ? (latest?.usage?.contextInput ?? null)
      : null;
  const measuredCapacity = reported != null ? latest?.usage?.contextWindow : null;
  const previous = conversation?.messages.findLast(
    (m) =>
      m.role === 'assistant' &&
      sameSettings(m.settings) &&
      m.promptTokensEstimate != null &&
      (m.usage?.contextInput != null || m.usage?.input != null),
  );
  const lastInput = previous?.usage?.contextInput ?? previous?.usage?.input ?? null;
  const overhead = lastInput != null ? Math.max(0, lastInput - previous!.promptTokensEstimate!) : 0;
  const estimated = () => estimates().withDraft + overhead;
  const nextCapacity =
    snapshot?.context?.tokens ?? model.contextWindow ?? previous?.usage?.contextWindow ?? null;
  const capacity = measuredCapacity ?? nextCapacity;
  const source = measuredCapacity
    ? 'Window reported with this response'
    : (snapshot?.context?.source ??
      model.contextSource ??
      (previous?.usage?.contextWindow ? 'Last provider response' : 'Capacity not reported'));
  return {
    reported,
    reportedModel: reported != null ? (latest?.usage?.model ?? settings.model) : null,
    unavailableReason: !latest
      ? 'Send a message to get the first provider reading.'
      : !compatible
        ? 'Send a message with these settings to measure its context.'
        : 'This reply did not include a request-level context reading.',
    get estimated() {
      return estimated();
    },
    nextCapacity,
    get estimatedPercent() {
      return nextCapacity && nextCapacity > 0 ? (estimated() / nextCapacity) * 100 : null;
    },
    get draftTokens() {
      return Math.max(0, estimates().withDraft - estimates().withoutDraft);
    },
    capacity,
    source,
    percent: reported != null && capacity && capacity > 0 ? (reported / capacity) * 100 : null,
    calibrated: lastInput != null,
    lastInput,
    draftIncluded: !!draft.trim(),
    streaming: !!streaming,
  };
}
export function recordedUsage(conversation?: Conversation) {
  let input = 0,
    output = 0,
    cached = 0,
    reasoning = 0,
    inputMeasured = 0,
    outputMeasured = 0,
    measured = 0,
    missing = 0;
  for (const message of conversation?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const u = message.usage;
    if (u?.input == null || u?.output == null) missing++;
    if (u?.input == null && u?.output == null) continue;
    measured++;
    if (u.input != null) inputMeasured++;
    if (u.output != null) outputMeasured++;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cached += u.cachedInput ?? 0;
    reasoning += u.reasoningOutput ?? 0;
  }
  return { input, output, cached, reasoning, measured, inputMeasured, outputMeasured, missing };
}
