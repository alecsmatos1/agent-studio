import { limitedReply } from './auto-continue';
import type { Conversation } from './domain';

/**
 * Shut down when chats finish (requested 2026-11-03: "Create a button that watches when enabled,
 * wait for all chats to finish then turn off the PC automatically", to leave the computer working
 * through the night; docs/BACKGROUND.md). While the watch is on, the window looks at the work this
 * computer still has to do; once none is left it counts down for a minute, which new work or
 * Cancel ends, then saves and asks the app to turn the computer off (src-tauri/src/shutdown.rs),
 * which refuses while a reply runs here.
 */

/** How long the window counts down before the computer turns off; the desktop alert says so. */
export const countdownMs = 60_000;
/** How often the window looks at the work left while it waits, and while it counts down. */
export const watchEvery = 2_000;
export const countEvery = 1_000;
/** A computer still on this long after it began to turn off did not. */
export const shutdownWait = 120_000;

/** What the watch waits for. */
export type Waiting = { chats: number; workflows: number };

export type WatchState =
  | { phase: 'off' }
  | { phase: 'watching' }
  | { phase: 'counting'; until: number }
  // Saving, then asking the app; `asked` once the computer is turning off.
  | { phase: 'shutting'; asked: boolean };

/**
 * The chats this computer still has work for: the replies it runs, for this window or another
 * device, the messages queued behind a running reply, which this window sends when it ends, and
 * the chats a usage limit stopped that it goes on with once the limit resets. Messages held after a
 * stopped or failed reply wait for the reader, and hold nothing.
 */
export function unfinishedChats(
  conversations: readonly Conversation[],
  work: {
    /** Chats with a reply running on this computer, or starting there. */
    running: Iterable<string>;
    /** The messages waiting for each chat's running reply. */
    queued: Readonly<Record<string, readonly unknown[] | undefined>>;
    /** Whether a reply of the chat runs, here or on another computer. */
    replying: (conversation: Conversation) => boolean;
    /** Whether this computer sends the chat's next message once its usage limit resets. */
    continuesHere: (conversation: Conversation) => boolean;
  },
): Set<string> {
  const chats = new Set(work.running);
  for (const conversation of conversations) {
    if (chats.has(conversation.id)) continue;
    if (work.queued[conversation.id]?.length) {
      if (work.replying(conversation)) chats.add(conversation.id);
      continue;
    }
    const plan = limitedReply(conversation)?.autoContinue;
    if (plan && !plan.off && work.continuesHere(conversation)) chats.add(conversation.id);
  }
  return chats;
}

/** What the button says the watch waits for, or nothing. */
export function waitingText({ chats, workflows }: Waiting): string {
  const parts = [
    ...(chats ? [`${chats} ${chats === 1 ? 'chat' : 'chats'}`] : []),
    ...(workflows ? [`${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}`] : []),
  ];
  return parts.length ? `Waiting for ${parts.join(' and ')}` : '';
}

/**
 * The watch's next state: it counts down once no work is left, and any work, as a reply that
 * begins during the countdown, takes it back to waiting. Shutting down goes on by itself.
 */
export function watchStep(
  state: WatchState,
  { armed, busy, now }: { armed: boolean; busy: boolean; now: number },
): WatchState {
  if (state.phase === 'shutting') return state;
  if (!armed) return state.phase === 'off' ? state : { phase: 'off' };
  if (busy) return state.phase === 'watching' ? state : { phase: 'watching' };
  if (state.phase === 'counting') return state;
  return { phase: 'counting', until: now + countdownMs };
}

/** Whether the countdown ran out. */
export const countdownOver = (state: WatchState, now: number) =>
  state.phase === 'counting' && now >= state.until;

/** The time a countdown has left, as it shows: 1:00, 0:42. */
export function timeLeft(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
