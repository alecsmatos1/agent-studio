import { describe, expect, it } from 'vitest';
import {
  arranged,
  mergeSidebarOrder,
  orderIndex,
  ranksBetween,
  sameSidebarOrder,
  sidebarOrderSchema,
  withMove,
  withoutRanks,
  type OrderSpace,
  type Rank,
  type SidebarOrder,
} from './sidebar-order';

const RANK = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const at = (time: string) => new Date(time);
// The list as the sidebar shows it: items without a rank first, as given, then by rank.
const shown = (order: SidebarOrder | undefined, space: OrderSpace, ids: string[]) =>
  arranged(ids, orderIndex(order)[space], (id) => id);
// Moves `id` to `to` in the list as shown and returns the order with the list it now shows.
function move(order: SidebarOrder | undefined, ids: string[], id: string, to: number) {
  const before = shown(order, 'chats', ids);
  const next = withMove(order, 'chats', before, id, to, at('2026-11-09T10:00Z'));
  const expected = before.filter((other) => other !== id);
  expected.splice(to, 0, id);
  return { next, expected };
}
// A small seeded generator, so a failing sequence of moves can be replayed.
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe('sidebar order', () => {
  it('spreads ranks between any two, each a valid fraction in order', () => {
    for (const [low, high] of [
      [undefined, undefined],
      [undefined, 'V'],
      ['V', undefined],
      ['1', '2'],
      ['V', 'V1'],
      ['0V', '1'],
      ['zz', undefined],
      [undefined, '01'],
    ] as const)
      for (const count of [1, 2, 3, 10, 61, 200]) {
        const ranks = ranksBetween(low, high, count);
        expect(ranks).toHaveLength(count);
        for (const [i, rank] of ranks.entries()) {
          expect(rank).toMatch(RANK);
          if (low !== undefined) expect(rank > low).toBe(true);
          if (high !== undefined) expect(rank < high).toBe(true);
          if (i) expect(rank > ranks[i - 1]).toBe(true);
        }
      }
    expect(ranksBetween(undefined, undefined, 0)).toEqual([]);
    // Placing an item first again and again lengthens ranks slowly, and so does placing last.
    let first = ranksBetween(undefined, undefined, 1)[0];
    let last = first;
    for (let i = 0; i < 300; i++) {
      const before = ranksBetween(undefined, first, 1)[0];
      const after = ranksBetween(last, undefined, 1)[0];
      expect(before < first && after > last).toBe(true);
      first = before;
      last = after;
    }
    expect(first.length).toBeLessThan(15);
    expect(last.length).toBeLessThan(15);
  });

  it('lists items without a rank first, as given, then the ranked by rank', () => {
    const ranks = new Map([
      ['c', 'V'],
      ['a', 'G'],
      ['d', 'V'],
    ]);
    expect(arranged(['a', 'x', 'c', 'y', 'd'], ranks, (id) => id)).toEqual([
      'x',
      'y',
      'a',
      'c',
      'd',
    ]);
    expect(arranged(['b', 'a'], new Map(), (id) => id)).toEqual(['b', 'a']);
  });

  it('keeps the order a move shows, ranking the moved item and the rest of its list', () => {
    const ids = ['a', 'b', 'c', 'd'];
    // Nothing moves when an item is dropped where it was.
    expect(withMove(undefined, 'chats', ids, 'b', 1)).toBeUndefined();
    const order: SidebarOrder = {};
    expect(withMove(order, 'chats', ids, 'b', 1)).toBe(order);
    expect(withMove(order, 'chats', ids, 'missing', 0)).toBe(order);
    // The first move ranks the whole list as it now shows.
    const { next, expected } = move(undefined, ids, 'd', 0);
    expect(expected).toEqual(['d', 'a', 'b', 'c']);
    expect(shown(next, 'chats', ids)).toEqual(expected);
    expect(next?.chats?.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next?.chats?.every((r) => r.at === '2026-11-09T10:00:00.000Z')).toBe(true);
    expect(sidebarOrderSchema.safeParse(next).success).toBe(true);
    // A new item without a rank comes first; moving another ranks it too, where it shows.
    const { next: later, expected: then } = move(next, ['e', ...ids], 'b', 4);
    expect(then).toEqual(['e', 'd', 'a', 'c', 'b']);
    expect(shown(later, 'chats', ['e', ...ids])).toEqual(then);
    expect(orderIndex(later).chats.has('e')).toBe(true);
    // Only the moved item and the new one took new places.
    const changed = later!.chats!.filter(
      (r) => !next!.chats!.some((o) => o.id === r.id && o.rank === r.rank),
    );
    expect(changed.map((r) => r.id).sort()).toEqual(['b', 'e']);
    // Moves keep the other lists as they were.
    const folders = withMove({ ...later, pinned: [] }, 'folders', ['f', 'g'], 'g', 0);
    expect(folders?.chats).toBe(later?.chats);
    expect(folders?.pinned).toEqual([]);
    expect(shown(folders, 'folders', ['f', 'g'])).toEqual(['g', 'f']);
  });

  it('ranks items without a rank wherever the list shows them', () => {
    // Folders holding only unsent drafts stay after the others while they have no rank.
    const order = withMove(undefined, 'folders', ['a', 'b', 'c'], 'c', 0, at('2026-11-09T10:00Z'));
    const index = orderIndex(order).folders;
    expect(['c', 'a', 'b'].map((id) => index.get(id)!)).toEqual(
      [...['c', 'a', 'b'].map((id) => index.get(id)!)].sort(),
    );
    const next = withMove(order, 'folders', ['c', 'a', 'b', 'draft'], 'a', 0);
    const ranks = orderIndex(next).folders;
    const listed = ['a', 'c', 'b', 'draft'];
    expect(listed.map((id) => ranks.get(id)!)).toEqual(
      [...listed.map((id) => ranks.get(id)!)].sort(),
    );
    expect(new Set(listed.map((id) => ranks.get(id))).size).toBe(4);
  });

  it('ranks a list again whole when its ranks are out of order', () => {
    const tied: SidebarOrder = {
      chats: [
        { id: 'a', rank: 'V', at: '2026-11-09T09:00:00.000Z' },
        { id: 'b', rank: 'V', at: '2026-11-09T09:00:00.000Z' },
        { id: 'c', rank: 'V', at: '2026-11-09T09:00:00.000Z' },
        { id: 'elsewhere', rank: 'G', at: '2026-11-09T09:00:00.000Z' },
      ],
    };
    const { next, expected } = move(tied, ['a', 'b', 'c'], 'c', 1);
    expect(expected).toEqual(['a', 'c', 'b']);
    expect(shown(next, 'chats', ['a', 'b', 'c'])).toEqual(expected);
    // Another list's item keeps its place.
    expect(next?.chats?.find((r) => r.id === 'elsewhere')).toEqual(tied.chats![3]);
  });

  it('shows every move as made, however many follow one another', () => {
    const next = random(7);
    let order: SidebarOrder | undefined;
    let ids = Array.from({ length: 8 }, (_, i) => `chat-${i}`);
    for (let step = 0; step < 600; step++) {
      // From time to time a new chat arrives without a rank, or one goes.
      if (step % 37 === 5) ids = [`new-${step}`, ...ids];
      if (step % 53 === 11) {
        const gone = ids[Math.floor(next() * ids.length)];
        ids = ids.filter((id) => id !== gone);
        order = withoutRanks(order, 'chats', [gone]);
      }
      const list = shown(order, 'chats', ids);
      const id = list[Math.floor(next() * list.length)];
      const to = Math.floor(next() * list.length);
      const { next: moved, expected } = move(order, ids, id, to);
      expect(shown(moved, 'chats', ids)).toEqual(expected);
      expect(sidebarOrderSchema.safeParse(moved ?? {}).success).toBe(true);
      order = moved;
    }
    expect(Math.max(...order!.chats!.map((r) => r.rank.length))).toBeLessThan(40);
  });

  it('forgets places, keeping the same order when there is nothing to forget', () => {
    const order = withMove(undefined, 'pinned', ['a', 'b'], 'b', 0);
    const forgot = withoutRanks(order, 'pinned', ['b']);
    expect(forgot?.pinned?.map((r) => r.id)).toEqual(['a']);
    expect(withoutRanks(order, 'pinned', ['x'])).toBe(order);
    expect(withoutRanks(order, 'chats', ['a'])).toBe(order);
    expect(withoutRanks(undefined, 'chats', ['a'])).toBeUndefined();
  });

  it('accepts only well-formed places, one per item', () => {
    const rank: Rank = { id: 'a', rank: 'V', at: '2026-11-09T10:00:00.000Z' };
    expect(sidebarOrderSchema.safeParse({ chats: [rank] }).success).toBe(true);
    expect(sidebarOrderSchema.safeParse({}).success).toBe(true);
    expect(sidebarOrderSchema.safeParse({ chats: [rank, { ...rank, rank: 'W' }] }).success).toBe(
      false,
    );
    for (const bad of ['', 'V0', 'a-b', 'é'])
      expect(sidebarOrderSchema.safeParse({ chats: [{ ...rank, rank: bad }] }).success).toBe(false);
    expect(sidebarOrderSchema.safeParse({ chats: [{ ...rank, at: 'soon' }] }).success).toBe(false);
    expect(sidebarOrderSchema.safeParse({ folders: [{ ...rank, id: '' }] }).success).toBe(false);
  });

  it('merges places item by item and keeps them when a side predates them', () => {
    const place = (id: string, rank: string, time: string): Rank => ({
      id,
      rank,
      at: new Date(time).toISOString(),
    });
    const kept = place('kept', 'G', '2026-11-08T10:00Z');
    const base: SidebarOrder = { chats: [kept] };
    const local: SidebarOrder = { chats: [kept, place('ours', 'V', '2026-11-09T10:00Z')] };
    const remote: SidebarOrder = {
      chats: [kept, place('theirs', 'k', '2026-11-09T10:05Z')],
      folders: [place('folder', 'V', '2026-11-09T10:05Z')],
    };
    const merged = mergeSidebarOrder(base, local, remote)!;
    expect(merged.chats?.map((r) => r.id)).toEqual(['kept', 'ours', 'theirs']);
    expect(merged.folders).toEqual(remote.folders);
    expect(sidebarOrderSchema.safeParse(merged).success).toBe(true);
    // An older relay or app drops the order, or one of its lists: this device keeps its own.
    expect(mergeSidebarOrder(base, local, undefined)).toBe(local);
    expect(mergeSidebarOrder(base, undefined, remote)).toBe(remote);
    expect(mergeSidebarOrder(undefined, undefined, undefined)).toBeUndefined();
    expect(mergeSidebarOrder(base, { chats: [kept], pinned: [] }, base)?.pinned).toEqual([]);
    // Both placed one item: the later place, the same on both devices.
    const earlier = place('kept', 'a', '2026-11-09T09:00Z');
    const latest = place('kept', 'b', '2026-11-09T11:00Z');
    expect(mergeSidebarOrder(base, { chats: [earlier] }, { chats: [latest] })?.chats).toEqual([
      latest,
    ]);
    expect(mergeSidebarOrder(base, { chats: [latest] }, { chats: [earlier] })?.chats).toEqual([
      latest,
    ]);
    // Forgotten on one side and kept on the other, it goes; placed again on the other, it stays.
    expect(mergeSidebarOrder(base, { chats: [] }, base)?.chats).toEqual([]);
    expect(mergeSidebarOrder(base, base, { chats: [] })?.chats).toEqual([]);
    expect(mergeSidebarOrder(base, { chats: [] }, { chats: [latest] })?.chats).toEqual([latest]);
  });

  it('compares orders whatever the order of their lists', () => {
    const a: Rank = { id: 'a', rank: 'G', at: '2026-11-09T10:00:00.000Z' };
    const b: Rank = { id: 'b', rank: 'V', at: '2026-11-09T10:00:00.000Z' };
    expect(sameSidebarOrder({ chats: [a, b] }, { chats: [b, a] })).toBe(true);
    expect(sameSidebarOrder(undefined, { chats: [] })).toBe(true);
    expect(sameSidebarOrder({ chats: [a] }, { chats: [a], folders: [b] })).toBe(false);
    expect(sameSidebarOrder({ chats: [a] }, { chats: [{ ...a, rank: 'H' }] })).toBe(false);
  });
});
