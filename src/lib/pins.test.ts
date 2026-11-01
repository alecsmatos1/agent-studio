import { describe, expect, it } from 'vitest';
import { mergePins, pinIndex, pinsSchema, samePins, withPin, withoutPin, type Pin } from './pins';

const id = () => crypto.randomUUID() as string;
const pin = (conversationId: string, at: string): Pin => ({
  conversationId,
  at: new Date(at).toISOString(),
});

describe('pins', () => {
  it('pins and unpins chats, keeping a pinned chat in its place', () => {
    const [a, b, gone] = [id(), id(), id()];
    const at = new Date('2026-11-01T10:00Z');
    const once = withPin(undefined, a, at);
    expect(once).toEqual([{ conversationId: a, at: at.toISOString() }]);
    // Pinned again, a chat keeps the time it was first pinned, so it keeps its place.
    expect(withPin(once, a, new Date('2026-11-01T12:00Z'))).toEqual(once);
    // Every device stores them by chat.
    const both = withPin(once, b, new Date('2026-11-01T11:00Z'));
    expect(both.map((p) => p.conversationId)).toEqual([a, b].sort());
    expect(pinIndex(both).get(b)!.at).toBe('2026-11-01T11:00:00.000Z');
    expect(pinsSchema.safeParse(both).success).toBe(true);
    // Unpinning leaves the other pins, one whose chat has not arrived here yet included.
    const elsewhere = pin(gone, '2026-11-01T09:00Z');
    const left = withoutPin([...both, elsewhere], a);
    expect(samePins(left, [pinIndex(both).get(b)!, elsewhere])).toBe(true);
    expect(left.map((p) => p.conversationId)).toEqual([b, gone].sort());
    expect(withoutPin(undefined, a)).toEqual([]);
  });

  it('accepts only one well-formed pin per chat', () => {
    const entry = pin(id(), '2026-11-01T10:00Z');
    expect(pinsSchema.safeParse([entry]).success).toBe(true);
    expect(
      pinsSchema.safeParse([entry, { ...entry, at: '2026-11-01T11:00:00.000Z' }]).success,
    ).toBe(false);
    expect(pinsSchema.safeParse([{ ...entry, at: 'tomorrow' }]).success).toBe(false);
    expect(pinsSchema.safeParse([{ ...entry, conversationId: 'chat' }]).success).toBe(false);
  });

  it('merges pins from both sides and keeps them when a side predates them', () => {
    const [kept, ours, theirs] = [id(), id(), id()];
    const shared = pin(kept, '2026-10-31T09:00Z');
    const base = [shared];
    const local = withPin(base, ours, new Date('2026-11-01T09:00Z'));
    const remote = withPin(base, theirs, new Date('2026-11-01T09:05Z'));
    const merged = mergePins(base, local, remote)!;
    expect(samePins(merged, [...remote, pinIndex(local).get(ours)!])).toBe(true);
    // Stored by chat, so equal lists compare equal as text on every device.
    expect(merged.map((p) => p.conversationId)).toEqual([kept, ours, theirs].sort());
    // An older relay or app drops the list: this device keeps its own.
    expect(mergePins(base, local, undefined)).toBe(local);
    expect(mergePins(base, undefined, remote)).toBe(remote);
    expect(mergePins(undefined, undefined, undefined)).toBeUndefined();
    // Unpinned on one side and kept on the other, it goes; pinned again on the other, it stays.
    const again = pin(kept, '2026-11-01T18:00Z');
    expect(mergePins(base, [], base)).toEqual([]);
    expect(mergePins(base, base, [])).toEqual([]);
    expect(mergePins(base, [], [again])).toEqual([again]);
    expect(mergePins(base, [again], [])).toEqual([again]);
    // Both pinned it: the later pin, the same on both devices.
    const earlier = pin(kept, '2026-11-01T17:00Z');
    expect(mergePins(base, [earlier], [again])).toEqual([again]);
    expect(mergePins(base, [again], [earlier])).toEqual([again]);
    expect(mergePins([], [earlier], [again])).toEqual([again]);
  });

  it('compares lists whatever their order', () => {
    const list = [pin(id(), '2026-11-01T09:00Z'), pin(id(), '2026-11-01T10:00Z')];
    expect(samePins(list, [...list].reverse())).toBe(true);
    expect(samePins(list, list.slice(1))).toBe(false);
    expect(samePins(list, [list[0], { ...list[1], at: '2026-11-01T11:00:00.000Z' }])).toBe(false);
    expect(samePins(undefined, [])).toBe(true);
  });
});
