import { getContext, setContext, untrack } from 'svelte';

// What a window recalls of each chat it showed (requested 2026-11-03: "keep the scroll of both
// the chat and artifact saved per session/chat when going to other chats so it doesn't reset to
// bottom/top"): where the reader was reading, what they opened in it and where its side panels
// were scrolled, so that a chat shown again looks as it was left. Each part of a chat keeps its
// own under a scope that names it within the chat, such as a reply's id. Kept in the window's
// memory by conversation, never saved, synced or exported; deleting a chat or changing workspace
// drops it.

/** What a window recalls of one chat: each scope's values, by name. */
export type ChatRecall = Map<string, Map<string, unknown>>;

/** What one part of a chat recalls, such as a reply's footer or an artifact's viewer. */
export type Recalled = {
  get<T>(name: string): T | undefined;
  /** `undefined` forgets the value. */
  set(name: string, value: unknown): void;
  /** Forgets everything the part recalls. */
  clear(): void;
};

const context = Symbol('chat-recall');
const nothing: Recalled = { get: () => undefined, set() {}, clear() {} };

/** Gives the parts of the chat on screen what the window recalls of it, as each one mounts. */
export function provideRecall(shown: () => ChatRecall | undefined) {
  setContext(context, shown);
}

/** What the window recalls of the chat a component mounts in. Call it while it initializes. */
export function shownRecall(): ChatRecall | undefined {
  return getContext<(() => ChatRecall | undefined) | undefined>(context)?.();
}

/** What `scope` recalls in a chat; nothing without a chat or a scope. */
export function recalled(chat: ChatRecall | undefined, scope: string | undefined): Recalled {
  if (!chat || !scope) return nothing;
  return {
    get: <T>(name: string) => chat.get(scope)?.get(name) as T | undefined,
    set(name, value) {
      const values = chat.get(scope);
      if (value !== undefined) {
        if (values) values.set(name, value);
        else chat.set(scope, new Map([[name, value]]));
      } else if (values?.delete(name) && !values.size) chat.delete(scope);
    },
    clear: () => void chat.delete(scope),
  };
}

/**
 * What a part recalls in the chat a component mounts in, under the scope it names as it mounts.
 * Call it while the component initializes.
 */
export const recall = (scope: () => string | undefined) => recalled(shownRecall(), untrack(scope));
