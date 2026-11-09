import { z } from 'zod';

// The order the reader gave the sidebar by moving its chats, folders and computers. Each list
// keeps a rank per item. An item without one was never placed and comes first, in the order it
// has without any (the most recently used first), so a new chat or folder shows at the top until
// it is placed. Ranks are fractions written in base 62, so a move writes only the moved item and
// the items of its list that had no rank yet, and two devices merge their moves item by item.

/**
 * The lists the sidebar orders: a folder's chats (the same order in Active and in every History
 * session), the pinned chats, the folders (in Active under their computer and in History under
 * their session) and the computers of the Active tab.
 */
export const orderSpaces = ['chats', 'pinned', 'folders', 'computers'] as const;
export type OrderSpace = (typeof orderSpaces)[number];

// Digits in ASCII order, so ranks compare as plain strings.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// The digits of a fraction after its point, never ending in a zero, so each has one spelling.
const RANK = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export const rankSchema = z.object({
  // A chat's id, a folder group's id (its location key) or a computer section's id.
  id: z.string().min(1),
  rank: z.string().regex(RANK),
  // When it was placed: of two places given to one item, the later stands.
  at: z.iso.datetime(),
});
export type Rank = z.infer<typeof rankSchema>;
const ranksSchema = z
  .array(rankSchema)
  .refine(
    (ranks) => new Set(ranks.map((r) => r.id)).size === ranks.length,
    'Each item has one rank.',
  );
export const sidebarOrderSchema = z.object({
  chats: ranksSchema.optional(),
  pinned: ranksSchema.optional(),
  folders: ranksSchema.optional(),
  computers: ranksSchema.optional(),
});
export type SidebarOrder = z.infer<typeof sidebarOrderSchema>;

/** Each list's ranks by item, so a sidebar of many chats looks each one up at once. */
export type OrderIndex = { readonly [S in OrderSpace]: ReadonlyMap<string, string> };
export const orderIndex = (order?: SidebarOrder): OrderIndex =>
  Object.fromEntries(
    orderSpaces.map((space) => [space, new Map((order?.[space] ?? []).map((r) => [r.id, r.rank]))]),
  ) as unknown as OrderIndex;

const byRank = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * `items` as the sidebar lists them: those without a rank first, in the order given, then the
 * ranked ones by rank, items of equal rank by id so every device shows the same.
 */
export function arranged<T>(
  items: readonly T[],
  ranks: ReadonlyMap<string, string>,
  id: (item: T) => string,
): T[] {
  if (!ranks.size) return [...items];
  const unranked: T[] = [];
  const ranked: { rank: string; key: string; item: T }[] = [];
  for (const item of items) {
    const key = id(item);
    const rank = ranks.get(key);
    if (rank === undefined) unranked.push(item);
    else ranked.push({ rank, key, item });
  }
  ranked.sort((a, b) => byRank(a.rank, b.rank) || byRank(a.key, b.key));
  return [...unranked, ...ranked.map((entry) => entry.item)];
}

// A rank between `low` and `high` (low < high), an empty `low` standing for zero and an absent
// `high` for one: the midpoint of the digits they differ in, one digit longer only when they are
// adjacent (David Greenspan's fractional indexing).
function between(low: string, high: string | undefined): string {
  if (high !== undefined) {
    // The digits both share stay; a missing digit of `low` reads as zero.
    let shared = 0;
    while ((low[shared] ?? '0') === high[shared]) shared++;
    if (shared > 0) return high.slice(0, shared) + between(low.slice(shared), high.slice(shared));
  }
  const first = low ? DIGITS.indexOf(low[0]) : 0;
  const last = high !== undefined ? DIGITS.indexOf(high[0]) : DIGITS.length;
  // Beside an end, a step of one digit rather than half the room left, so items moved to the top
  // or the bottom again and again lengthen their ranks by a digit every thirty moves, not six.
  if (high === undefined && low && first + 1 < last) return DIGITS[first + 1];
  if (high !== undefined && !low && last > 1) return DIGITS[last - 1];
  if (last - first > 1) return DIGITS[Math.round((first + last) / 2)];
  if (high !== undefined && high.length > 1) return high.slice(0, 1);
  return DIGITS[first] + between(low.slice(1), undefined);
}
/** `count` ascending ranks between `low` and `high`, spread so later moves stay short. */
export function ranksBetween(
  low: string | undefined,
  high: string | undefined,
  count: number,
): string[] {
  if (count <= 0) return [];
  const middle = between(low ?? '', high);
  const before = Math.floor((count - 1) / 2);
  return [
    ...ranksBetween(low, middle, before),
    middle,
    ...ranksBetween(middle, high, count - 1 - before),
  ];
}

/** The order every device stores ranks in, by item, so equal lists compare equal as text. */
const stored = (ranks: Rank[]) => ranks.sort((a, b) => byRank(a.id, b.id));

/**
 * The order after the reader moved `id` to position `to` of a list the sidebar shows as `ids`,
 * `to` counting the positions of the list without it. The moved item takes a rank between its new
 * neighbours and every other item of the list without a rank takes one around them, so the list
 * keeps the order it now shows wherever its items are listed. A list whose ranks are out of order,
 * as moves of one list on two devices at once can leave it, is ranked again whole.
 */
export function withMove(
  order: SidebarOrder | undefined,
  space: OrderSpace,
  ids: readonly string[],
  id: string,
  to: number,
  now = new Date(),
): SidebarOrder | undefined {
  const from = ids.indexOf(id);
  const others = ids.filter((other) => other !== id);
  const target = Math.max(0, Math.min(others.length, Math.trunc(to)));
  if (from < 0 || target === from) return order;
  const shown = [...others.slice(0, target), id, ...others.slice(target)];
  const ranks = new Map((order?.[space] ?? []).map((r) => [r.id, r.rank]));
  const keeps = (item: string) => item !== id && ranks.has(item);
  let ordered = true;
  let previous: string | undefined;
  for (const item of shown) {
    if (!keeps(item)) continue;
    const rank = ranks.get(item)!;
    if (previous !== undefined && rank <= previous) ordered = false;
    previous = rank;
  }
  const placed = new Map<string, string>();
  if (!ordered)
    ranksBetween(undefined, undefined, shown.length).forEach((rank, i) =>
      placed.set(shown[i], rank),
    );
  else
    for (let start = 0; start < shown.length;) {
      if (keeps(shown[start])) {
        start++;
        continue;
      }
      // A run of items without a rank of their own takes ranks between the ranked items around it.
      let end = start;
      while (end < shown.length && !keeps(shown[end])) end++;
      ranksBetween(
        start > 0 ? ranks.get(shown[start - 1]) : undefined,
        end < shown.length ? ranks.get(shown[end]) : undefined,
        end - start,
      ).forEach((rank, i) => placed.set(shown[start + i], rank));
      start = end;
    }
  const at = now.toISOString();
  const entries = (order?.[space] ?? []).filter((r) => !placed.has(r.id));
  for (const [item, rank] of placed) entries.push({ id: item, rank, at });
  return { ...order, [space]: stored(entries) };
}

/**
 * Forgets the places of items in one list: a deleted chat's, or a chat's among the pinned chats
 * once it is pinned again or unpinned, so a chat pinned anew leads the pinned chats. The same
 * order comes back when there is nothing to forget, so callers can tell that nothing changed.
 */
export function withoutRanks(
  order: SidebarOrder | undefined,
  space: OrderSpace,
  ids: Iterable<string>,
): SidebarOrder | undefined {
  const gone = new Set(ids);
  const list = order?.[space];
  if (!list?.some((r) => gone.has(r.id))) return order;
  return { ...order, [space]: list.filter((r) => !gone.has(r.id)) };
}

const sameRank = (a: Rank | undefined, b: Rank | undefined) =>
  a === b || (!!a && !!b && a.id === b.id && a.rank === b.rank && a.at === b.at);
// The later of two places of one item, the same one on every device.
function later(a: Rank, b: Rank) {
  const difference = Date.parse(a.at) - Date.parse(b.at);
  if (difference) return difference > 0 ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}
const rankIndex = (ranks: readonly Rank[] = []) => new Map(ranks.map((r) => [r.id, r]));
function sameList(a: readonly Rank[] = [], b: readonly Rank[] = []) {
  if (a.length !== b.length) return false;
  const other = rankIndex(b);
  return a.every((rank) => sameRank(rank, other.get(rank.id)));
}
/** Whether two orders hold the same places, whatever the order of their lists. */
export const sameSidebarOrder = (a?: SidebarOrder, b?: SidebarOrder) =>
  orderSpaces.every((space) => sameList(a?.[space], b?.[space]));

// Each side's changes since the base: an item both placed takes the later place, and a place one
// side forgot goes unless the other placed the item again. A side without the list predates it,
// so its absence forgets nothing.
function mergeList(
  base: readonly Rank[] | undefined,
  local: Rank[] | undefined,
  remote: Rank[] | undefined,
): Rank[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = rankIndex(base);
  const ours = rankIndex(local);
  const theirs = rankIndex(remote);
  const merged: Rank[] = [];
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    let rank: Rank | undefined;
    if (sameRank(left, right) || sameRank(original, right)) rank = left;
    else if (sameRank(original, left)) rank = right;
    else rank = left && right ? later(left, right) : (left ?? right);
    if (rank) merged.push(rank);
  }
  return stored(merged);
}
/**
 * Merges the sidebar's order list by list and item by item. A side without the order, or without
 * one of its lists, predates it (an older relay or app drops it), so its absence removes nothing.
 */
export function mergeSidebarOrder(
  base: SidebarOrder | undefined,
  local: SidebarOrder | undefined,
  remote: SidebarOrder | undefined,
): SidebarOrder | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const merged: SidebarOrder = {};
  for (const space of orderSpaces) {
    const list = mergeList(base?.[space], local[space], remote[space]);
    if (list) merged[space] = list;
  }
  return merged;
}
