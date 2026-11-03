import { describe, expect, it } from 'vitest';
import { initialWorkspace, settingsFor, restoreWorkspace, type Conversation } from './domain';
import {
  contextFor,
  creditReading,
  accountLimits,
  estimatePromptTokens,
  isStale,
  recordedUsage,
  resetLabel,
  resetTime,
  snapshotFor,
  visibleLimits,
  type LimitWindow,
  type UsageSnapshot,
} from './usage';
import { automaticModel } from './models';

const settings = settingsFor(initialWorkspace().preferences);
const snapshot: UsageSnapshot = {
  provider: 'claude',
  checkedAt: 1000,
  context: null,
  detail: 'Fixture',
  windows: [
    {
      id: '5h',
      label: '5-hour',
      usedPercent: 0,
      resetsAt: 2000,
      windowMinutes: 300,
      model: null,
      bucket: 'claude',
    },
    {
      id: 'week',
      label: 'Weekly',
      usedPercent: 31,
      resetsAt: 9000,
      windowMinutes: 10080,
      model: null,
      bucket: 'claude',
    },
    {
      id: 'fable',
      label: 'Fable weekly',
      usedPercent: 62,
      resetsAt: 9000,
      windowMinutes: 10080,
      model: 'fable',
      bucket: 'claude',
    },
  ],
};
describe('usage and context semantics', () => {
  it('keeps credits separate from quotas, resets, money and other accounts', () => {
    const codex: UsageSnapshot = {
      ...snapshot,
      provider: 'codex',
      connectionId: 'one',
      credits: { kind: 'codex', balance: 0, hasCredits: false, unlimited: false, resetCredits: 2 },
    };
    expect(creditReading('codex', codex)?.value).toBe('0.00 credits');
    expect(creditReading('codex', codex)?.rows).toEqual([
      { label: 'Estimated value (US$0.04 per credit)', value: '$0.00' },
      { label: 'Usage resets available', value: '2' },
    ]);
    expect(creditReading('claude', codex)?.value).toBe('Not reported');
    expect(creditReading('gemini', codex)).toBeNull();
    expect(creditReading('codex')?.value).toBe('Not reported');
    expect(
      snapshotFor({ 'codex::one': codex }, { provider: 'codex', model: '', connectionId: 'two' }),
    ).toBeUndefined();
    expect(
      creditReading('codex', {
        ...codex,
        credits: {
          kind: 'codex',
          balance: null,
          hasCredits: true,
          unlimited: false,
          resetCredits: null,
        },
      })?.value,
    ).toBe('Available');
    expect(
      creditReading('codex', {
        ...codex,
        credits: {
          kind: 'codex',
          balance: null,
          hasCredits: true,
          unlimited: true,
          resetCredits: null,
        },
      })?.value,
    ).toBe('Unlimited');
    const claude: UsageSnapshot = {
      ...snapshot,
      credits: {
        kind: 'claude',
        used: 12.5,
        limit: 100,
        currency: 'USD',
        usedPercent: 12.5,
        enabled: true,
      },
    };
    const reading = creditReading('claude', claude)!;
    expect(reading.value).toMatch(/USD\s12.50 spent/);
    expect(reading.rows.find((r) => r.label === 'Remaining under cap')?.value).toMatch(
      /USD\s87.50/,
    );
    if (claude.credits?.kind === 'claude') {
      claude.credits.enabled = false;
      claude.credits.limit = null;
    }
    expect(creditReading('claude', claude)?.value).toBe('Disabled');
    expect(
      creditReading('claude', claude)?.rows.find((r) => r.label === 'Remaining under cap'),
    ).toBeUndefined();
  });
  it('estimates credit value from pack prices without inventing unknown or unlimited balances', () => {
    const valueFor = (balance: number | null, unlimited = false) =>
      creditReading('codex', {
        ...snapshot,
        provider: 'codex',
        credits: { kind: 'codex', balance, hasCredits: true, unlimited, resetCredits: 2 },
      });
    for (const [balance, dollars] of [
      [2500, '$100.00'],
      [5000, '$200.00'],
      [25000, '$1,000.00'],
      [4322.4487, '$172.90'],
      [0.01, '<$0.01'],
    ] as const) {
      expect(valueFor(balance)?.rows).toContainEqual({
        label: 'Estimated value (US$0.04 per credit)',
        value: dollars,
      });
    }
    for (const balance of [null, -1, NaN, Infinity]) {
      expect(valueFor(balance)?.rows).not.toContainEqual(
        expect.objectContaining({ label: 'Estimated value (US$0.04 per credit)' }),
      );
    }
    expect(valueFor(5000, true)?.rows).not.toContainEqual(
      expect.objectContaining({ label: 'Estimated value (USD)' }),
    );
    expect(creditReading('codex', snapshot)?.rows).toEqual([]);
  });
  it('keeps account windows and model scopes separate, with missing limits distinct from zero', () => {
    const windows = accountLimits(snapshot, 'claude');
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 0],
      ['Weekly', 31],
      ['Fable weekly', 62],
    ]);
    // Without a reading nothing shows; while the first is under way the account's limits wait,
    // whatever the provider.
    expect(accountLimits(undefined, 'codex')).toEqual([]);
    expect(accountLimits(undefined, 'codex', true).map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', null],
      ['Weekly', null],
    ]);
    const spark = {
      ...snapshot.windows[0],
      id: 'spark',
      bucket: 'spark',
      model: 'Spark',
      usedPercent: 99,
    };
    const codex = {
      ...snapshot,
      provider: 'codex',
      windows: [{ ...snapshot.windows[0], bucket: 'codex' }, spark],
    };
    expect(accountLimits(codex, 'codex').map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 0],
      ['Spark · 5-hour', 99],
    ]);
    const scoped = { ...snapshot, connectionId: 'first-account' };
    expect(
      snapshotFor(
        { 'claude::first-account': scoped },
        {
          provider: 'claude',
          model: '',
          connectionId: 'second-account',
        },
      ),
    ).toBeUndefined();
  });
  it('shares newer account quotas while keeping context capacity tied to the selected model', () => {
    const fable = { ...settings, provider: 'claude' as const, model: 'fable' };
    const fableSnapshot = {
      ...snapshot,
      context: { model: 'claude-fable-5-1', tokens: 1e6, source: 'CLI' },
    };
    const sonnetSnapshot = {
      ...snapshot,
      checkedAt: 1100,
      windows: snapshot.windows.map((w) => ({ ...w, usedPercent: 70 })),
      context: { model: 'claude-sonnet', tokens: 200000, source: 'CLI' },
    };
    const snapshots = { 'claude:fable': fableSnapshot, 'claude:sonnet': sonnetSnapshot };
    const selected = snapshotFor(snapshots, fable);
    expect(selected?.windows[0].usedPercent).toBe(70);
    expect(selected?.context?.tokens).toBe(1e6);
    expect(snapshotFor(snapshots, { ...fable, model: 'haiku' })?.context).toBeNull();
    expect(snapshotFor(snapshots, { ...fable, provider: 'gemini' })).toBeUndefined();
  });
  it('shows Fable only for Fable, including the resolved CLI default', () => {
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'claude', model: 'sonnet' }),
    ).toHaveLength(2);
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'claude', model: 'fable' })[2].usedPercent,
    ).toBe(62);
    expect(
      visibleLimits(
        { ...snapshot, context: { model: 'claude-fable-5-1', tokens: 1e6, source: 'CLI' } },
        { ...settings, provider: 'claude', model: '' },
      ),
    ).toHaveLength(3);
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'gemini', model: 'fable' }),
    ).toHaveLength(2);
  });
  it('does not invent zero usage or attach another Codex bucket to the selected model', () => {
    const codex = {
      ...snapshot,
      provider: 'codex',
      windows: [
        { ...snapshot.windows[1], bucket: 'codex' },
        { ...snapshot.windows[0], bucket: 'spark', model: 'GPT-5.3-Codex-Spark' },
      ],
    };
    expect(visibleLimits(codex, settings).map((w) => w.windowMinutes)).toEqual([10080]);
    const missingShortWindow = {
      ...codex,
      windows: [...codex.windows, { ...snapshot.windows[0], usedPercent: null, bucket: 'codex' }],
    };
    expect(accountLimits(missingShortWindow, 'codex').map((w) => [w.label, w.usedPercent])).toEqual(
      [
        ['Weekly', 31],
        ['GPT-5.3-Codex-Spark · 5-hour', 0],
      ],
    );
    expect(visibleLimits(codex, { ...settings, model: 'gpt-5.3-codex-spark' })[0].usedPercent).toBe(
      0,
    );
    expect(visibleLimits(undefined, settings)).toEqual([]);
  });
  it('shows only the limits a reading reports, whatever the provider and window', () => {
    const sonnet = { ...settings, provider: 'claude' as const, model: 'sonnet' };
    const fable = { ...sonnet, model: 'fable' };
    const [fiveHour, weekly, fableWeekly] = snapshot.windows;
    const labels = (windows: LimitWindow[]) => windows.map((w) => w.label);
    // A Claude plan without a 5-hour limit, as Claude Code now reports some: no 5-hour bar.
    const noFiveHour = { ...snapshot, windows: [weekly, fableWeekly] };
    expect(labels(visibleLimits(noFiveHour, sonnet))).toEqual(['Weekly']);
    expect(labels(visibleLimits(noFiveHour, fable))).toEqual(['Weekly', 'Fable weekly']);
    expect(labels(accountLimits(noFiveHour, 'claude'))).toEqual(['Weekly', 'Fable weekly']);
    // A later reading under way keeps to the limits the last one reported.
    expect(labels(visibleLimits(noFiveHour, sonnet, true))).toEqual(['Weekly']);
    // No weekly limit, or one named without a share used.
    const noWeekly = { ...snapshot, windows: [fiveHour, { ...weekly, usedPercent: null }] };
    expect(labels(visibleLimits(noWeekly, sonnet))).toEqual(['5-hour']);
    expect(labels(accountLimits(noWeekly, 'claude'))).toEqual(['5-hour']);
    // A Fable model whose account reports no Fable limit.
    expect(labels(visibleLimits({ ...snapshot, windows: [fiveHour, weekly] }, fable))).toEqual([
      '5-hour',
      'Weekly',
    ]);
    // Gemini the same way.
    const gemini = { ...snapshot, provider: 'gemini', windows: [{ ...weekly, bucket: 'gemini' }] };
    expect(labels(visibleLimits(gemini, { ...settings, provider: 'gemini' }))).toEqual(['Weekly']);
    // A reading without limits, as an API key's: none at all.
    const none = { ...snapshot, windows: [] };
    expect(visibleLimits(none, sonnet, true)).toEqual([]);
    expect(accountLimits(none, 'claude', true)).toEqual([]);
  });
  it('lets limits wait only for a first reading, which live updates alone do not replace', () => {
    const sonnet = { ...settings, provider: 'claude' as const, model: 'sonnet' };
    const values = (windows: LimitWindow[]) => windows.map((w) => [w.label, w.usedPercent]);
    expect(values(visibleLimits(undefined, sonnet, true))).toEqual([
      ['5-hour', null],
      ['Weekly', null],
    ]);
    expect(
      values(visibleLimits(undefined, { ...sonnet, provider: 'codex', model: '' }, true)),
    ).toEqual([
      ['5-hour', null],
      ['Weekly', null],
    ]);
    expect(visibleLimits(undefined, { ...sonnet, model: 'fable' }, true)).toHaveLength(3);
    // A live update names only the limit it concerns: the others wait for the reading under way
    // and stay hidden without one.
    const live: UsageSnapshot = {
      ...snapshot,
      partial: true,
      windows: [{ ...snapshot.windows[0], usedPercent: 40 }],
    };
    expect(values(visibleLimits(live, sonnet, true))).toEqual([
      ['5-hour', 40],
      ['Weekly', null],
    ]);
    expect(values(visibleLimits(live, sonnet))).toEqual([['5-hour', 40]]);
  });
  it('fills an account’s newer live updates in from its complete reading', () => {
    const settings = { provider: 'claude' as const, model: '', connectionId: 'one' };
    const reading = { ...snapshot, connectionId: 'one', windows: snapshot.windows.slice(0, 2) };
    const live: UsageSnapshot = {
      ...snapshot,
      connectionId: 'one',
      partial: true,
      checkedAt: 1200,
      windows: [{ ...snapshot.windows[0], usedPercent: 40, checkedAt: 1200 }],
    };
    const account = snapshotFor({ 'claude:opus:one': reading, 'claude::one': live }, settings)!;
    expect(account.partial).toBeUndefined();
    // Each limit as old as the reading that reported it.
    expect(account.windows.map((w) => [w.id, w.usedPercent, w.checkedAt])).toEqual([
      ['5h', 40, 1200],
      ['week', 31, 1000],
    ]);
    // Without a complete reading the account's other limits stay unknown.
    expect(snapshotFor({ 'claude::one': live }, settings)?.partial).toBe(true);
    // A newer complete reading is the account's own.
    const newer = { ...reading, checkedAt: 1300 };
    expect(snapshotFor({ 'claude:opus:one': newer, 'claude::one': live }, settings)).toEqual({
      ...newer,
      context: null,
    });
  });
  it('normalizes reset times and marks old or elapsed readings as stale', () => {
    expect(resetTime('2026-09-08T12:00:00Z')).toBe(Date.parse('2026-09-08T12:00:00Z'));
    expect(resetTime(1000)).toBe(1e6);
    expect(resetTime('invalid')).toBeNull();
    expect(resetLabel(null, 1e6)).toBe('Reset time not reported');
    expect(resetLabel(1000, 1e6)).toContain('Reset due');
    expect(isStale(snapshot, snapshot.windows[0], 1100000)).toBe(false);
    expect(isStale(snapshot, snapshot.windows[0], 2000000)).toBe(true);
  });
  it('estimates replayed context rather than summing billing, and accounts for drafts and switches', () => {
    const user = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      blocks: [{ type: 'markdown' as const, text: 'Plan a garden' }],
      createdAt: '',
      status: 'complete' as const,
    };
    const promptTokensEstimate = estimatePromptTokens(settings, [
      { role: 'user', text: 'Plan a garden' },
    ]);
    const chat: Conversation = {
      id: crypto.randomUUID(),
      settings,
      title: 'Garden',
      createdAt: '',
      updatedAt: '',
      messages: [
        user,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          settings,
          createdAt: '',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'Grow basil.' }],
          promptTokensEstimate,
          usage: { input: 10000, contextInput: 1000, output: 500, cachedInput: 8000 },
        },
      ],
    };
    const context = contextFor(chat, settings, '', { ...automaticModel, contextWindow: 2000 });
    expect(context.estimated).toBeGreaterThan(1000);
    expect(context.estimated).toBeLessThan(1100);
    expect(context.reported).toBe(1000);
    expect(context.percent).toBe(50);
    expect(context.estimatedPercent).toBeGreaterThan(50);
    expect(
      contextFor(chat, settings, 'a'.repeat(400), { ...automaticModel, contextWindow: 2000 })
        .percent,
    ).toBe(50);
    expect(contextFor(chat, settings, 'a'.repeat(400), automaticModel).estimated).toBeGreaterThan(
      context.estimated + 90,
    );
    expect(
      contextFor(chat, { ...settings, provider: 'claude' }, '', automaticModel).calibrated,
    ).toBe(false);
    expect(recordedUsage(chat)).toMatchObject({ input: 10000, output: 500, cached: 8000 });
    const workspace = initialWorkspace();
    workspace.conversations = [chat];
    expect(restoreWorkspace(workspace).conversations[0].messages[1].usage?.contextInput).toBe(1000);
    chat.messages[1].usage = { input: null, output: 500 };
    expect(recordedUsage(chat)).toMatchObject({ inputMeasured: 0, outputMeasured: 1, missing: 1 });
  });
  it('uses measured context without requiring a local estimate and preserves the response window', () => {
    const chat = measuredChat();
    const currentCatalog = { ...automaticModel, contextWindow: 1e6 };
    const context = contextFor(chat, settings, '', currentCatalog);
    expect(context.reported).toBe(1200);
    expect(context.capacity).toBe(2000);
    expect(context.percent).toBe(60);
    expect(context.calibrated).toBe(false);
    chat.messages[0].usage!.contextWindow = null;
    expect(contextFor(chat, settings, '', automaticModel)).toMatchObject({
      reported: 1200,
      percent: null,
    });
    chat.messages[0].usage!.contextInput = 0;
    expect(contextFor(chat, settings, '', currentCatalog)).toMatchObject({
      reported: 0,
      percent: 0,
    });
  });
  it('does not call cumulative totals or a mismatched response measured context', () => {
    const chat = measuredChat();
    for (const changed of [
      { ...settings, provider: 'claude' as const },
      { ...settings, model: 'different' },
      { ...settings, reasoning: 'low' as const },
      { ...settings, instructions: 'Different instructions' },
    ])
      expect(contextFor(chat, changed, '', automaticModel).reported).toBeNull();
    chat.messages.push({
      ...chat.messages[0],
      id: crypto.randomUUID(),
      usage: { input: 9000, output: 200 },
    });
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
    chat.messages.at(-1)!.settings = { ...settings, provider: 'gemini' };
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
    expect(contextFor(undefined, settings, 'draft', automaticModel).reported).toBeNull();
  });
  it('keeps the previous measured reading during a reply, then replaces it only with new request data', () => {
    const chat = measuredChat();
    chat.messages.push({
      ...chat.messages[0],
      id: crypto.randomUUID(),
      status: 'running',
      usage: undefined,
    });
    expect(contextFor(chat, settings, 'draft', automaticModel)).toMatchObject({
      reported: 1200,
      streaming: true,
    });
    chat.messages.at(-1)!.usage = { input: 20000, contextInput: 1500, contextWindow: 2000 };
    expect(contextFor(chat, settings, '', automaticModel).percent).toBe(75);
    chat.messages.at(-1)!.status = 'complete';
    chat.messages.at(-1)!.usage = { input: 20000 };
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
  });
  it('measures a first reply while it runs and keeps the reading when it is cut off', () => {
    const chat = measuredChat();
    chat.messages[0] = { ...chat.messages[0], status: 'running', usage: undefined };
    const window = { ...snapshot, context: { model: 'opus', tokens: 1e6, source: 'Fixture' } };
    expect(contextFor(chat, settings, '', automaticModel, window)).toMatchObject({
      reported: null,
      streaming: true,
    });
    // A Claude request reports its input as its response starts; counts and window come with
    // the turn's result.
    chat.messages[0].usage = {
      input: null,
      output: null,
      contextInput: 35200,
      contextWindow: null,
      scope: 'reply',
      revision: 1,
    };
    expect(contextFor(chat, settings, '', automaticModel, window)).toMatchObject({
      reported: 35200,
      capacity: 1e6,
      streaming: true,
    });
    chat.messages[0].status = 'cancelled';
    expect(contextFor(chat, settings, '', automaticModel, window)).toMatchObject({
      reported: 35200,
      streaming: false,
    });
  });
});

function measuredChat(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Fixture',
    settings,
    createdAt: '',
    updatedAt: '',
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: '',
        settings,
        blocks: [{ type: 'markdown', text: 'Grow basil.' }],
        usage: { input: 9000, output: 200, contextInput: 1200, contextWindow: 2000 },
      },
    ],
  };
}
