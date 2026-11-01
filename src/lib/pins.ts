import { z } from 'zod';

// A chat pinned to the top of its tab: pinned Active chats lead the Active tab and pinned History
// chats lead History, so pinning never moves a chat between them. The workspace keeps one per chat,
// so every device shows it.
export const pinSchema = z.object({
  conversationId: z.string().uuid(),
  // When it was pinned: the most recently pinned chat leads its tab's pinned chats.
  at: z.iso.datetime(),
});
export const pinsSchema = z
  .array(pinSchema)
  .refine(
    (pins) => new Set(pins.map((p) => p.conversationId)).size === pins.length,
    'Each chat has one pin.',
  );
export type Pin = z.infer<typeof pinSchema>;

/** Pins by chat, so a sidebar of many chats looks each one up at once. */
export const pinIndex = (pins: readonly Pin[] = []) =>
  new Map(pins.map((pin) => [pin.conversationId, pin]));

/** The order every device stores pins in, by chat, so equal lists compare equal as text. */
const stored = (pins: Pin[]) =>
  pins.sort((a, b) =>
    a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0,
  );
/** Pins a chat from `now`; a chat pinned already keeps its place. */
export function withPin(
  pins: readonly Pin[] | undefined,
  conversationId: string,
  now = new Date(),
): Pin[] {
  if (pins?.some((pin) => pin.conversationId === conversationId)) return stored([...pins]);
  return stored([...(pins ?? []), { conversationId, at: now.toISOString() }]);
}
/** Unpins a chat. */
export const withoutPin = (pins: readonly Pin[] | undefined, conversationId: string): Pin[] =>
  stored((pins ?? []).filter((pin) => pin.conversationId !== conversationId));

const samePin = (a: Pin | undefined, b: Pin | undefined) =>
  a === b || (!!a && !!b && a.conversationId === b.conversationId && a.at === b.at);
// The later of two pins of one chat, the same one on every device.
function later(a: Pin, b: Pin) {
  const difference = Date.parse(a.at) - Date.parse(b.at);
  if (difference) return difference > 0 ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}
/** Whether two lists hold the same pins, whatever their order. */
export function samePins(a: readonly Pin[] = [], b: readonly Pin[] = []) {
  if (a.length !== b.length) return false;
  const other = pinIndex(b);
  return a.every((pin) => samePin(pin, other.get(pin.conversationId)));
}

/**
 * Keeps each side's changes since the shared base. When both sides pinned the same chat, the later
 * pin wins, and an unpinned chat stays pinned when the other side pinned it again. A side without
 * the list predates pins (an older relay or app drops them), so its absence removes nothing.
 */
export function mergePins(
  base: readonly Pin[] | undefined,
  local: Pin[] | undefined,
  remote: Pin[] | undefined,
): Pin[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = pinIndex(base);
  const ours = pinIndex(local);
  const theirs = pinIndex(remote);
  const merged: Pin[] = [];
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    let pin: Pin | undefined;
    if (samePin(left, right) || samePin(original, right)) pin = left;
    else if (samePin(original, left)) pin = right;
    else pin = left && right ? later(left, right) : (left ?? right);
    if (pin) merged.push(pin);
  }
  return stored(merged);
}
