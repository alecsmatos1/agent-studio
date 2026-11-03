import { SvelteSet } from 'svelte/reactivity';
import type { Recalled } from './chat-recall';

/**
 * Tracks which `<details>` disclosures have rendered their contents. Contents render when a
 * disclosure is first expanded and then stay, keeping nested expansion. Collapsed history
 * stays out of the page, which keeps long conversations quick to open and to select text in:
 * a selection walks every element it crosses.
 *
 * With `recalled`, the disclosures the reader opened or closed are recalled with their chat
 * (`src/lib/chat-recall.ts`), so a chat shown again mounts them as they were left, their
 * contents rendered at once. Each `view` the part shows, such as a running reply's live activity
 * and the Work history it becomes, recalls its own, so the Work history of a finished reply
 * starts collapsed as it always did.
 */
export function revealedDisclosures(recalled?: Recalled, view: () => string = () => '') {
  // Whether each disclosure was left open, by view and key, shared with every later mount.
  let views = recalled?.get<Map<string, Map<string, boolean>>>('disclosures');
  if (recalled && !views) recalled.set('disclosures', (views = new Map()));
  const toggled = () => {
    const name = view();
    let keys = views?.get(name);
    if (views && !keys) views.set(name, (keys = new Map()));
    return keys;
  };
  const revealed = new SvelteSet<string>();
  for (const [key, open] of views?.get(view()) ?? []) if (open) revealed.add(key);
  return {
    has: (key: string) => revealed.has(key),
    /**
     * A summary click handler. It renders the contents before the disclosure opens, so the
     * reading position held by virtual-space.ts measures them. The toggle event is queued and
     * can arrive after the next frame.
     */
    reveal: (key: string) => () => {
      revealed.add(key);
    },
    /**
     * A toggle handler for any other way of opening. `recall` false leaves a disclosure that
     * shows only for a moment, such as a running call's row, out of what its chat recalls.
     */
    opened:
      (key: string, recall = true) =>
      (event: Event) => {
        const open = (event.currentTarget as HTMLDetailsElement).open;
        if (open) revealed.add(key);
        if (recall) toggled()?.set(key, open);
      },
    /** Whether a disclosure mounts open: as its chat recalls it, otherwise `initial`. */
    open: (key: string, initial = false) => views?.get(view())?.get(key) ?? initial,
  };
}
