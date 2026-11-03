import type { Artifact } from './artifacts';
import type { PublishedArtifact } from './published-artifacts';

// What each chat shows beside its conversation, by conversation (requested 2026-10-14): an
// artifact, in the modal or the side panel, and the sub-agent whose conversation the side panel
// shows. A side panel belongs to its chat: another chat, Connections or Settings hides it, and it
// is open again when its chat returns. These stay in the window's memory, never saved or synced.

/** An artifact a chat shows. */
export type ArtifactView = {
  artifact: Artifact;
  mode: 'modal' | 'panel';
  /** Whether it takes focus when it opens: only when the reader opened it in the chat. */
  focus: boolean;
};

/**
 * A claude.ai artifact a chat shows inside the window (requested 2026-10-29), in the claude.ai
 * session of the account that published it (`src-tauri/src/claude_pages.rs`).
 */
export type PageView = {
  page: PublishedArtifact;
  /** Which card of the chat it last loaded (`newestPage`). */
  version: string;
  /** The Claude account whose session shows it. */
  account: string;
  /** Which loading of the artifact it shows: Reload and a newer publish load it again. */
  load: string;
  mode: 'modal' | 'panel';
  focus: boolean;
};

/**
 * The newest card of a claude.ai artifact in a chat, and what names it. Each reply counts its own
 * revisions from one, so a later reply's card is newer whatever its revision says: a chat that
 * publishes a page and changes it in later replies reads revision 1 again each time.
 */
export function newestPage(
  messages: readonly { id: string; publishedArtifacts?: PublishedArtifact[] }[],
  id: string,
): { page: PublishedArtifact; version: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const page = messages[index].publishedArtifacts?.find((card) => card.id === id);
    if (page) return { page, version: `${messages[index].id}:${page.revision}` };
  }
}

/** What a chat shows in the modal or beside it: a page of a reply, or a claude.ai artifact. */
export type ShownArtifact = ArtifactView | PageView;

/** The sub-agent whose conversation a chat's side panel shows, by the reply that started it. */
export type SubagentView = { messageId: string; agentId: string; focus: boolean };

/**
 * Leaves every chat but the one shown: its modal closes, and its side panel, shown again with
 * its chat, leaves focus where it is.
 */
export function leaveChats(
  artifacts: Record<string, ShownArtifact>,
  subagents: Record<string, SubagentView>,
  shown: string | null,
) {
  for (const [id, view] of Object.entries(artifacts)) {
    if (id === shown) continue;
    if (view.mode === 'modal') delete artifacts[id];
    else view.focus = false;
  }
  for (const [id, view] of Object.entries(subagents)) if (id !== shown) view.focus = false;
}

/**
 * The width a docked side panel and the chat beside it share: the workspace's, without the padding
 * and the gap between them that chats shown as cards leave (requested 2026-10-19).
 */
export function panelRoom(workspace: HTMLElement) {
  const style = getComputedStyle(workspace);
  const spaced = (value: string) => parseFloat(value) || 0;
  return (
    workspace.getBoundingClientRect().width -
    spaced(style.paddingLeft) -
    spaced(style.paddingRight) -
    spaced(style.columnGap)
  );
}

/**
 * Shows a panel's dialog beside the chat when docked, and otherwise as a drawer over it, which
 * takes focus as any modal does. Opening it moves focus to `control`; a docked panel shown again
 * with its chat puts focus back where it was, since the browser moves focus into any dialog it
 * shows.
 */
export function showPanel(
  dialog: HTMLDialogElement,
  docked: boolean,
  control: string,
  keepFocus = false,
) {
  const kept = keepFocus && docked ? document.activeElement : null;
  dialog.close();
  if (docked) dialog.show();
  else dialog.showModal();
  if (!kept) dialog.querySelector<HTMLElement>(control)?.focus();
  else if (
    (kept instanceof HTMLElement || kept instanceof SVGElement) &&
    kept !== document.body &&
    kept.isConnected
  )
    kept.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement))
    document.activeElement.blur();
}
