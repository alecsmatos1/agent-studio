import { describe, expect, it } from 'vitest';
import { accountChanges, accountUsageSchema, chatSpend, money, type AccountUsage } from './spend';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';

const reply = (usage?: Message['usage']): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'complete',
  blocks: [{ type: 'markdown', text: 'Done' }],
  createdAt: '2026-09-14',
  usage,
});
const chat = (provider: 'claude' | 'codex', messages: Message[]): Conversation => ({
  id: crypto.randomUUID(),
  title: 'Spend',
  createdAt: '2026-09-14',
  updatedAt: '2026-09-14',
  settings: { ...settingsFor(initialWorkspace().preferences), provider },
  messages,
});
const observed = (runId: string): AccountUsage => ({
  version: 1,
  revision: 2,
  runId,
  before: {
    checkedAt: 100,
    windows: [{ id: 'weekly', label: 'Weekly', resetsAt: 1000, usedPercent: 10 }],
    balance: 25,
    extraUsed: null,
    currency: null,
  },
  after: {
    checkedAt: 110,
    windows: [{ id: 'weekly', label: 'Weekly', resetsAt: 1000, usedPercent: 12 }],
    balance: 24.75,
    extraUsed: null,
    currency: null,
  },
});
describe('chat spend tracking', () => {
  it('sums Claude reply costs once, retaining zero and incomplete stopped replies', () => {
    const c = chat('claude', [
      reply({ input: 10, output: 2, costUsd: 0, scope: 'reply' }),
      reply({ input: 20, output: 4, costUsd: 0.5, scope: 'reply' }),
      { ...reply(), status: 'cancelled' },
    ]);
    expect(chatSpend(c)).toMatchObject({ input: 30, output: 6, cost: 0.5, partial: true });
    expect(chatSpend(chat('claude', [reply()]))).toMatchObject({ input: null, cost: null });
    // Older replies saved the session's running total: their tokens count, not their cost.
    const older = chatSpend(
      chat('claude', [
        reply({ input: 10, output: 2, costUsd: 0.2 }),
        reply({ input: 20, output: 4, costUsd: 0.5 }),
        reply({ input: 5, output: 1, costUsd: 0.1, scope: 'reply' }),
      ]),
    );
    expect(older).toMatchObject({ input: 35, output: 7, cost: 0.1, partial: true });
    expect(money(0)).toBe('$0.00');
    expect(money(0.0000001)).toBe('<$0.000001');
    expect(money(null)).toBe('Not reported');
  });
  it('sums scoped Codex reply counters but uses only the latest cumulative credit estimate', () => {
    const c = chat('codex', [
      reply({ input: 9999, output: 99 }),
      reply({ input: 10, output: 2, scope: 'reply', sessionCredits: 0.25 }),
      reply({ input: 25, output: 4, scope: 'reply', sessionCredits: 0.5, sessionCostUsd: 0 }),
    ]);
    expect(chatSpend(c)).toMatchObject({
      input: 35,
      output: 6,
      credits: 0.5,
      cost: 0,
      partial: true,
    });
    c.messages.push(reply());
    expect(chatSpend(c)).toMatchObject({ input: 35, credits: null, partial: true });
    expect(chatSpend(chat('codex', [reply({ input: 9999 })])).input).toBeNull();
  });
  it('keeps shared account movements signed and rejects resets, missing and backwards readings', () => {
    const m = reply();
    m.accountUsage = observed(m.runId!);
    expect(accountChanges(m)).toEqual([
      { label: 'Weekly', value: '+2 percentage points' },
      { label: 'Account credit balance', value: '-0.25 credits' },
    ]);
    m.accountUsage.after!.windows[0].resetsAt = 2000;
    expect(accountChanges(m)[0].value).toContain('Not comparable');
    m.accountUsage.after!.windows[0].resetsAt = 1000;
    m.accountUsage.after!.checkedAt = 1001;
    expect(accountChanges(m)[0].value).toContain('Not comparable');
    m.accountUsage.after!.checkedAt = 99;
    expect(accountChanges(m)).toEqual([]);
    m.accountUsage.after = null;
    expect(accountChanges(m)).toEqual([]);
  });
  it('leaves out a limit neither reading reports with a share used', () => {
    const m = reply();
    m.accountUsage = observed(m.runId!);
    const fiveHour = { id: 'five-hour', label: '5-hour', resetsAt: 1000, usedPercent: null };
    m.accountUsage.before!.windows.push(fiveHour);
    m.accountUsage.after!.windows.push({ ...fiveHour });
    expect(accountChanges(m).map((row) => row.label)).toEqual(['Weekly', 'Account credit balance']);
    // Reported by one reading alone, it cannot be compared.
    m.accountUsage.after!.windows[1].usedPercent = 4;
    expect(accountChanges(m)[1]).toEqual({
      label: '5-hour',
      value: 'Not comparable (reset or missing reading)',
    });
  });
  it('accepts only bounded, current-run observations and retains the final revision', () => {
    const m = reply();
    const final = observed(m.runId!);
    applyRunEvent(m, { kind: 'accountusage', accountUsage: final });
    applyRunEvent(m, {
      kind: 'accountusage',
      accountUsage: { ...final, revision: 1, after: null },
    });
    applyRunEvent(m, { kind: 'accountusage', accountUsage: observed(crypto.randomUUID()) });
    expect(m.accountUsage).toEqual(final);
    const events: RunEvent[] = [];
    retainRunEvent(events, { kind: 'accountusage', accountUsage: final });
    retainRunEvent(events, { kind: 'accountusage', accountUsage: { ...final, revision: 1 } });
    expect(events).toHaveLength(1);
    expect(events[0].accountUsage).toEqual(final);
    expect(
      accountUsageSchema.safeParse({ ...final, before: { ...final.before, balance: Infinity } })
        .success,
    ).toBe(false);
  });
  it('preserves observations and estimates through save, export and stale relay checkpoints, outside prompts', () => {
    const m = reply({ revision: 3, scope: 'reply', input: 500, sessionCredits: 0.25 });
    m.accountUsage = observed(m.runId!);
    const c = chat('codex', [m]);
    const workspace = initialWorkspace();
    workspace.conversations = [c];
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.conversations[0].messages[0].accountUsage).toEqual(m.accountUsage);
    expect(JSON.stringify(historyFor(c))).not.toContain('accountUsage');
    expect(JSON.stringify(historyFor(c))).not.toContain('sessionCredits');
    const base = emptyShared();
    const local = sharedWorkspace(workspace),
      remote = structuredClone(local);
    remote.conversations[0].messages[0].accountUsage = {
      ...m.accountUsage,
      revision: 1,
      after: null,
    };
    remote.conversations[0].messages[0].usage = { revision: 1, input: 100 };
    expect(mergeShared(base, local, remote).conversations[0].messages[0].accountUsage).toEqual(
      m.accountUsage,
    );
    expect(mergeShared(base, remote, local).conversations[0].messages[0].usage).toEqual(m.usage);
    applyRunEvent(m, { kind: 'usage', revision: 2, input: 200 });
    expect(m.usage?.sessionCredits).toBe(0.25);
    remote.conversations[0].messages[0].runId = crypto.randomUUID();
    expect(() => restoreWorkspace({ ...workspace, conversations: remote.conversations })).toThrow();
  });
});
