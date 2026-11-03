import { describe, it, expect } from 'vitest';
import {
  AccountUpdateGate,
  accountActionSchema,
  accountUpdateSchema,
  mergeLiveUsage,
  canResetUsage,
  type AccountUpdate,
} from './live-usage';
import type { UsageSnapshot } from './usage';
import { quotaPace } from './pace';
const id = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const window = {
  id: 'codex-primary',
  label: 'Weekly',
  usedPercent: 95,
  resetsAt: 605800,
  windowMinutes: 10080,
  model: null,
  bucket: 'codex',
};
function update(): AccountUpdate {
  return {
    connectionId: id,
    epoch,
    revision: 1,
    accountChanged: 0,
    authMode: null,
    planType: null,
    creditsCheckedAt: null,
    limitStatus: null,
    snapshot: {
      provider: 'codex',
      checkedAt: 2000,
      context: null,
      credits: null,
      detail: 'Live',
      windows: [window],
    },
  };
}
function baseline(): UsageSnapshot {
  return {
    connectionId: id,
    provider: 'codex',
    checkedAt: 1000,
    windows: [window, { ...window, id: 'spark-primary', bucket: 'spark', model: 'Spark' }],
    context: null,
    detail: 'Read',
    credits: { kind: 'codex', balance: 5, hasCredits: true, unlimited: false, resetCredits: 2 },
  };
}
describe('transient account push', () => {
  it('merges only the changed bucket and retains metadata and real measurement timestamps', () => {
    const incoming = update();
    incoming.snapshot.windows[0] = {
      ...window,
      usedPercent: 97,
      resetsAt: null,
      windowMinutes: null,
      label: 'Usage window',
    };
    const merged = mergeLiveUsage(baseline(), incoming);
    expect(merged.windows[0]).toMatchObject({
      usedPercent: 97,
      label: 'Weekly',
      windowMinutes: 10080,
      checkedAt: 2000,
      resetsAt: 605800,
    });
    expect(merged.windows[1].checkedAt).toBe(1000);
    expect(merged.credits).toEqual(baseline().credits);
    expect(quotaPace(merged.windows[1], merged, 2000000).state).toBe('unknown');
    expect(canResetUsage(merged)).toBe(true);
  });
  it('leaves the account’s limits unknown while live updates alone make its snapshot', () => {
    const first = mergeLiveUsage(undefined, update());
    expect(first.partial).toBe(true);
    expect(mergeLiveUsage(first, update()).partial).toBe(true);
    // An update merged into a reading keeps every limit the reading listed.
    const merged = mergeLiveUsage(baseline(), update());
    expect(merged.partial).toBeUndefined();
    expect(merged.windows).toHaveLength(2);
  });
  it('preserves reset credits and sparse credit fields, without reviving an old credit reading', () => {
    const incoming = update();
    incoming.snapshot.credits = {
      kind: 'codex',
      balance: 0,
      hasCredits: false,
      unlimited: null,
      resetCredits: null,
    };
    incoming.creditsCheckedAt = 2000;
    expect(mergeLiveUsage(baseline(), incoming).credits).toEqual({
      kind: 'codex',
      balance: 0,
      hasCredits: false,
      unlimited: false,
      resetCredits: 2,
    });
    incoming.creditsCheckedAt = 500;
    expect(mergeLiveUsage(baseline(), incoming).credits).toEqual(baseline().credits);
  });
  it('rejects duplicate, reversed and foreign-epoch payloads, however large or many', () => {
    const gate = new AccountUpdateGate(),
      first = update();
    expect(gate.accept(first)).toBe(true);
    expect(gate.accept(first)).toBe(false);
    expect(gate.accept({ ...first, revision: 0 })).toBe(false);
    expect(gate.accept({ ...first, epoch: crypto.randomUUID(), revision: 1 })).toBe(true);
    expect(gate.accept({ ...first, revision: 100 })).toBe(false);
    // Any number of connections, and of restarts of one connection.
    for (let i = 0; i < 150; i++)
      expect(gate.accept({ ...update(), connectionId: crypto.randomUUID() })).toBe(true);
    for (let i = 0; i < 40; i++)
      expect(gate.accept({ ...first, epoch: crypto.randomUUID(), revision: 1 })).toBe(true);
    const windows = Array.from({ length: 40 }, (_, i) => ({ ...window, id: `w${i}` }));
    const large = { ...first, snapshot: { ...first.snapshot, detail: 'x'.repeat(5000), windows } };
    expect(accountUpdateSchema.parse(large)).toEqual(large);
    expect(mergeLiveUsage(baseline(), large).windows).toHaveLength(42);
    expect(
      accountActionSchema.safeParse({
        action: 'consumeResetCredit',
        idempotencyKey: crypto.randomUUID(),
        confirmed: false,
      }).success,
    ).toBe(false);
  });
  it('does not mix account snapshots or use Spark eligibility for a core reset', () => {
    const incoming = update();
    incoming.connectionId = crypto.randomUUID();
    expect(mergeLiveUsage(baseline(), incoming).credits).toBeUndefined();
    const data = baseline();
    data.windows[0].usedPercent = 1;
    expect(canResetUsage(data)).toBe(false);
  });
});
