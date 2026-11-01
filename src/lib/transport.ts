import { z } from 'zod';
import { Channel, convertFileSrc, isTauri } from '@tauri-apps/api/core';
// Tauri's invoke, naming each call and remembering the calls the app has not answered yet.
import {
  answerBytes,
  callsUsePostMessage,
  invoke,
  type IpcFallback,
  type WindowStall,
} from './window-answers';
import { mentionRequestSchema, mentionResultSchema, type MentionResult } from './mentions';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { version as packageVersion } from '../../package.json';

import { appUpdateStatusSchema, type AppUpdateStatus } from './app-updates';
import { signInViewSchema, type SignInView } from './sign-in';
import { cliUpdatesSchema, type CliUpdates, type UpdatedCli } from './cli-updates';
import { windowBehaviorSchema, type WindowBehavior } from './window-behavior';
import { createDesktopNotificationTracker } from './desktop-notifications';
import {
  applyAppBadge,
  asksTheUser,
  closeNotifications,
  pendingChatCount,
  readSince,
  staleAlerts,
} from './notifications';
import { fallbackModels, type ModelCatalog } from './models';
import type { FolderEntry, FolderPlace } from './folders';
import { folderIconContext } from './folder-icons';
import type { SavedDrafts } from './drafts';
import type { UsageSnapshot } from './usage';
import {
  AccountUpdateGate,
  accountUpdateSchema,
  accountActionSchema,
  type AccountUpdate,
  type AccountAction,
} from './live-usage';
import { retainRunEvent } from './activity';
import {
  blobBase64,
  imageByteLength,
  imageHash,
  imageHashes,
  imageLists,
  inlineBytes,
  isInline,
  storedImage,
  type ChatImage,
  type DraftImage,
  type InlineImage,
  type StoredImage,
} from './images';
import {
  createFetchCache,
  keptModelViewsSchema,
  modelBytes,
  modelViewCount,
  modelViewsRenderer,
  modelViewsSchema,
  toolOutputImageSchema,
  toolOutputModelSchema,
  toolOutputSchema,
  tablePageSchema,
  documentTextSchema,
  toolOutputFileSchema,
  base64Bytes,
  type TablePage,
  type DocumentText,
  type ModelViews,
  type ToolOutput,
  type ToolOutputImage,
} from './tool-output';
import { renderModelViews, type ModelFormat } from './model-scene';
import { backgroundWorkEventSchema, type BackgroundWorkEvent } from './background-work';
import { answerSchema, type QuestionAnswer } from './questions';
import { elicitationInputSchema, type ElicitationInput } from './elicitations';
import { steeringInputSchema, type SteeringInput } from './steering';
import type { ConsoleShell } from './code-blocks';
import {
  screenDetailSchema,
  screenJobSchema,
  screenOutcomeSchema,
  screenOutputSchema,
  screenServersSchema,
  screenSummarySchema,
  screenToolResultSchema,
  type ScreenCommand,
  type ScreenDetail,
  type ScreenJob,
  type ScreenOutcome,
  type ScreenOutput,
  type ScreenRequest,
  type ScreenServers,
  type ScreenSummary,
  type ScreenToolResult,
} from './screens';
import { createContextCache, type ContextSnapshot, type NativeInstructions } from './context';
import {
  importedChatSchema,
  importSourceSchema,
  sourceChatsSchema,
  type ImportedChat,
  type ImportSource,
  type SourceChats,
} from './imports';
import { mcpActionSchema, type McpAction, type McpResult } from './mcp';
import { pluginActionSchema, type PluginAction, type PluginResult } from './plugins';
import {
  adoptBrowserStorage,
  browserScopeKey,
  browserSessionSignal,
  browserWorkspaceFromServer,
  clearBrowserWorkspace,
  discardOtherBrowserWorkspaces,
  readBrowserWorkspace,
  saveBrowserWorkspace,
  type BrowserWorkspaceScope,
  type Unpublished,
} from './browser-workspace';
import { browserWorkspaceStore } from './browser-store';
import {
  executionHost,
  sharedContextChoice,
  type Fleet,
  type Installation,
  type WslDiscovery,
  type CliInstallation,
} from './fleet';
import {
  emptyShared,
  mergeShared,
  metaOf,
  onlyRepliesMoved,
  sameShared,
  sharedChatSchema,
  sharedSchema,
  sharedWorkspace,
  type MergeOptions,
  type SharedMeta,
  type SharedWorkspace,
  type Presence,
  type RelayJob,
} from './sync';
import {
  chatsAnswerSchema,
  involvedChats,
  manifestSchema,
  mergeInvolved,
  metaAnswerSchema,
  nextBaselineChats,
  syncPlan,
  uploadBatches,
  type Manifest,
} from './incremental-sync';
import type { ChangeSet } from './change-marks';
import { chatList, joinBytes, jsonWith } from './chat-bytes';
import { jsonEqual } from './json-equal';
import {
  holdsWork,
  lightChat,
  messageIds,
  messagesById,
  restoreChat,
  workIds,
} from './light-chats';
import {
  initialWorkspace,
  providerIds,
  restoreWorkspace,
  type ProviderStatus,
  type ProviderId,
  type RunEvent,
  type RunRequest,
  type Workspace,
  type ChatSettings,
  type ChatLocation,
  type Conversation,
  type Message,
} from './domain';

export const desktop = () => isTauri();

/** The version this frontend was built from. */
export const buildVersion: string = packageVersion;
/** The running app's version: the desktop app's native version, or this build's in the Viewer. */
export async function appVersion(): Promise<string> {
  if (!desktop()) return buildVersion;
  try {
    const version: unknown = await getVersion();
    if (typeof version === 'string' && /^\d+\.\d+\.\d+\S*$/.test(version)) return version;
  } catch {
    // The desktop app bundles this frontend, so the build's version describes it too.
  }
  return buildVersion;
}

export async function desktopInstallerAvailable(): Promise<boolean> {
  const response = await fetch('/downloads/manifest.json', {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Unable to check desktop downloads.');
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('windows' in value) ||
    typeof value.windows !== 'boolean'
  )
    throw new Error('Unable to check desktop downloads.');
  return value.windows;
}
export { BrowserWorkspaceStorageError } from './browser-workspace';

export type DesktopNotificationSettings = {
  enabled: boolean;
  sound: boolean;
  lastError?: string;
  lastSent?: number;
};
export const desktopNotificationSettings = (): Promise<DesktopNotificationSettings> =>
  invoke('desktop_notification_settings');
export const setDesktopNotifications = (
  enabled: boolean,
  sound: boolean,
): Promise<DesktopNotificationSettings> => invoke('set_desktop_notifications', { enabled, sound });
export const testDesktopNotification = (): Promise<void> =>
  invoke('desktop_notification', { notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` } });
export async function watchDesktopNotifications(
  open: (conversationId: string) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  return listen<string>('studio-notification-open', ({ payload }) => open(payload));
}
export type { AppUpdateStatus } from './app-updates';
export const checkForAppUpdate = async (): Promise<AppUpdateStatus> =>
  appUpdateStatusSchema.parse(await invoke('check_app_update'));
/** Replaces this app with the downloaded update; the installer closes and reopens it. */
export const installAppUpdate = (): Promise<void> => invoke('install_app_update');
export async function watchAppUpdates(
  onChange: (status: AppUpdateStatus) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  let latest: AppUpdateStatus | undefined;
  let revision = 0;
  const apply = (value: unknown) => {
    const status = appUpdateStatusSchema.safeParse(value);
    if (!status.success) return;
    latest = status.data;
    onChange(status.data);
  };
  const refresh = async () => {
    const current = ++revision;
    try {
      const value = await invoke<unknown>('app_update_status');
      // A native event that arrived meanwhile is newer than this reading.
      if (current === revision) apply(value);
    } catch {
      // Update status is informational; chat and saving continue without it.
    }
  };
  const unlisten = await listen<unknown>('studio-app-update', ({ payload }) => {
    ++revision;
    apply(payload);
  });
  await refresh();
  // Running replies change without an update event; keep Restart to update accurate.
  const timer = setInterval(() => {
    if (latest?.phase === 'ready') void refresh();
  }, 5000);
  return () => {
    clearInterval(timer);
    unlisten();
  };
}
export type { CliUpdates, CliUpdateStatus } from './cli-updates';
/** Turns this computer's automatic updates of one CLI on or off. */
export const setCliAutoUpdate = async (
  provider: UpdatedCli,
  automatic: boolean,
): Promise<CliUpdates> =>
  cliUpdatesSchema.parse(await invoke('set_cli_auto_update', { provider, automatic }));
/** Checks every Claude Code and Codex installation on this computer for an update now. */
export const checkCliUpdates = async (): Promise<CliUpdates> =>
  cliUpdatesSchema.parse(await invoke('check_cli_updates'));
/**
 * Installs Claude Code or Codex inside one of this computer's WSL distributions with its
 * provider's own installer, and returns the version it installed.
 */
export async function installCli(provider: UpdatedCli, environmentId: string): Promise<string> {
  if (!desktop()) throw new Error('Install CLIs from Agent Studio on the computer that runs them.');
  return z.string().parse(await invoke('install_cli', { provider, environmentId }));
}
/**
 * Asks Windows once to let this computer's separate Claude accounts share settings.json and
 * CLAUDE.md with the Claude app (`linking.rs`). Agent Studio itself keeps running as the user.
 */
export async function shareClaudeFiles(): Promise<void> {
  if (!desktop()) throw new Error('Allow this from Agent Studio on the computer of these accounts.');
  await invoke('share_claude_files');
}
export async function watchCliUpdates(
  onChange: (updates: CliUpdates) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  let revision = 0;
  const apply = (value: unknown) => {
    const updates = cliUpdatesSchema.safeParse(value);
    if (updates.success) onChange(updates.data);
  };
  const unlisten = await listen<unknown>('studio-cli-update', ({ payload }) => {
    ++revision;
    apply(payload);
  });
  const current = ++revision;
  try {
    const value = await invoke<unknown>('cli_update_status');
    // A native event that arrived meanwhile is newer than this reading.
    if (current === revision) apply(value);
  } catch {
    // Update status is informational; chats keep using the installed CLI without it.
  }
  return unlisten;
}
export type { WindowBehavior } from './window-behavior';
/** Whether closing this computer's window keeps Agent Studio running in the tray. */
export const windowBehavior = async (): Promise<WindowBehavior> =>
  windowBehaviorSchema.parse(await invoke('window_behavior'));
/** Keeps Agent Studio running in the tray when its window closes, or quits on close. */
export const setCloseToTray = async (enabled: boolean): Promise<WindowBehavior> =>
  windowBehaviorSchema.parse(await invoke('set_close_to_tray', { enabled }));
// An alert waiting for its question asks for another look once the wait is over, taken at
// the workspace this window last saved.
let noticeWorkspace: Pick<Workspace, 'conversations'> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const desktopNotices = createDesktopNotificationTracker(Date.now, (delay) => {
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (noticeWorkspace) notifyDesktop(noticeWorkspace);
  }, delay);
});
function notifyDesktop(workspace: Pick<Workspace, 'conversations'>) {
  // No one sits at a server's screen; its replies reach phones through the relay instead.
  if (serverHost()) return;
  noticeWorkspace = workspace;
  for (const notice of desktopNotices(workspace)) {
    // Consume all lifecycle events, including suppressed ones, so switching
    // chats later cannot replay an alert the reader already saw.
    if (notice.conversationId === foregroundConversation()) continue;
    // A workflow's chats end quietly, and the chats of its runs ask nothing of their own: the
    // workflow alerts for what matters (docs/WORKFLOWS.md).
    if (
      notice.conversationId &&
      (isolatedChats().has(notice.conversationId) ||
        (notice.kind !== 'attention' && quietChats().has(notice.conversationId)))
    )
      continue;
    // Notification/audio failure must never fail saving or interrupt a CLI run.
    // Native delivery retains an actionable error in Connections.
    void invoke('desktop_notification', { notice }).catch(() => {});
  }
}
let notificationConversationId: () => string | undefined = () => undefined;
let notificationViewId = '';
let notificationViewRevision = 0;
/** This desktop app runs as a server, with no one at its window (`src-tauri/src/server.rs`). */
const serverHost = () => !!runtime?.installation.server;
function foregroundConversation(): string | undefined {
  // A server's window is never read: a chat it shows must not hold back or close phone alerts.
  if (serverHost()) return undefined;
  return typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    windowFocused()
    ? notificationConversationId()
    : undefined;
}
let shownConversation: string | null = null;
// Closes this browser's phone alerts that `stale` picks. Desktop alerts are native.
async function closeAlerts(stale: Parameters<typeof closeNotifications>[1]) {
  if (desktop() || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (registration) await closeNotifications(registration, stale);
  } catch {
    // An alert left showing is harmless; reading the chat goes on.
  }
}
// A short, transient lease lets the relay suppress a push before it reaches a
// userVisibleOnly service worker. Each tab has its own revisioned identity.
export async function publishNotificationView(hidden = false): Promise<void> {
  const conversationId = hidden ? null : (foregroundConversation() ?? null);
  // The chat on screen is read here, so its alerts on this device are stale.
  if (conversationId !== shownConversation) {
    shownConversation = conversationId;
    if (conversationId)
      void closeAlerts(
        (alert) =>
          (alert.data as { conversationId?: unknown } | null)?.conversationId === conversationId,
      );
  }
  if (!relayConnected) return;
  notificationViewId ||= crypto.randomUUID();
  try {
    const result = await relayApi<{ close?: unknown } | undefined>('POST', 'v1/notification-view', {
      viewId: notificationViewId,
      revision: ++notificationViewRevision,
      conversationId,
    });
    // This device's alerts for chats read on another device since they arrived.
    const stale = staleAlerts(result?.close);
    if (stale.length) void closeAlerts((alert) => readSince(alert, stale));
  } catch {
    // Older/offline relays keep delivering normally; never block chat or saving.
  }
}
export function watchNotificationView(current: () => string | undefined): () => void {
  notificationConversationId = current;
  const refresh = () => {
    void publishNotificationView();
  };
  const hide = () => {
    void publishNotificationView(true);
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  document.addEventListener('visibilitychange', refresh);
  const heartbeat = setInterval(refresh, 5000);
  const stopRelay = watchRelayConnection((ready) => {
    if (ready) refresh();
  });
  return () => {
    notificationConversationId = () => undefined;
    hide();
    stopRelay();
    clearInterval(heartbeat);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('blur', hide);
    window.removeEventListener('pagehide', hide);
    document.removeEventListener('visibilitychange', refresh);
  };
}
/** Tells the desktop app this window still calls it, and whether it is shown (watchdog.rs). */
export async function windowHeartbeat(shown: boolean): Promise<void> {
  if (desktop()) await invoke('window_heartbeat', { visible: shown });
}
/** Keeps this window's record of a time the app did not answer it with the app's diagnostics. */
export async function recordWindowStall(stall: WindowStall): Promise<void> {
  if (desktop()) await invoke('record_window_stall', { stall });
}
/** Keeps the moment Tauri moved this window's calls to `postMessage` with the app's diagnostics. */
export async function recordIpcFallback(fallback: IpcFallback): Promise<void> {
  if (desktop()) await invoke('record_ipc_fallback', { fallback });
}
let badgeQueue = Promise.resolve();
let lastBadgeCount: number | undefined;
function updatePendingBadge(count: number) {
  if (serverHost()) return;
  // Serialize writes so an older count cannot land after a newer checkpoint.
  badgeQueue = badgeQueue
    .catch(() => {})
    .then(async () => {
      // A background service worker can also change a PWA's badge. Reapply the
      // current workspace count when it syncs, even if this page's value is unchanged.
      if (desktop() && lastBadgeCount === count) return;
      if (desktop()) await invoke('set_pending_chat_badge', { count });
      else await applyAppBadge(navigator, count);
      lastBadgeCount = count;
    });
  // Badge failures are independent of workspace persistence and agent execution.
  void badgeQueue.catch(() => {});
}

/**
 * The sandboxed renderer: offline (`frame`) for visualizations and screens, and with pinned
 * CDNs and Google Fonts (`page`) for artifact pages.
 */
export async function artifactPreviewUrl(kind: 'frame' | 'page' = 'frame'): Promise<string> {
  if (!desktop()) return kind === 'page' ? '/artifact-page' : '/artifact-preview';
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return convertFileSrc(kind === 'page' ? 'page' : '', 'studio-artifact');
}

export async function downloadArtifact(source: string, filename: string, language: 'html' | 'svg') {
  if (desktop()) return await invoke<string>('save_artifact', { source, filename, language });
  const url = URL.createObjectURL(
    new Blob([source], { type: language === 'svg' ? 'image/svg+xml' : 'text/html' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export async function controlWindow(action: WindowAction): Promise<void> {
  if (!desktop()) return;
  await getCurrentWindow()[action]();
}

export async function watchWindowMaximized(
  onChange: (maximized: boolean) => void,
  onError: (error: unknown) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  const appWindow = getCurrentWindow();
  let disposed = false;
  let revision = 0;
  const refresh = async () => {
    const current = ++revision;
    try {
      const maximized = await appWindow.isMaximized();
      if (!disposed && current === revision) onChange(maximized);
    } catch (error) {
      if (!disposed && current === revision) onError(error);
    }
  };
  const unlisten = await appWindow.onResized(refresh);
  await refresh();
  return () => {
    disposed = true;
    unlisten();
  };
}

type RuntimeContext = {
  installation: Installation;
  /** A copy of the whole workspace, which is slow for a large one. */
  workspace: () => Workspace;
  /**
   * The replicated part of the workspace alone. Validating the live data already detaches it,
   * so this costs about half of a whole-workspace copy followed by the same validation.
   */
  shared: () => SharedWorkspace;
  /** The replicated form of one conversation, or undefined when this device no longer holds it. */
  chat: (id: string) => Conversation | undefined;
  /** Every conversation id this device holds, in its own order. */
  chatIds: () => string[];
  /** The replicated fields other than the conversations, which move together. */
  meta: () => SharedMeta;
  /**
   * Takes what changed here since the last call, so a sync publishes it while changes made during
   * it wait for the next one: the conversations (all of them when undefined) and the settings.
   */
  takeUnsynced: () => ChangeSet;
  /** Returns them unpublished, so the next sync tries again. */
  restoreUnsynced: (changes: ChangeSet) => void;
  /**
   * The sync that took changes ended, having published them or handed them back. Called after
   * each one, so what counts as changed here (`pendingChanges`) leaves out what it published.
   */
  settleUnsynced?: () => void;
  /**
   * What changed here that the relay may not hold yet: the conversations, `undefined` while that
   * is not known, and whether the replicated settings changed.
   */
  pendingChanges?: () => { chats: Set<string> | undefined; meta: boolean };
  /**
   * Writes every unsaved change to this device's storage. A sync checkpoint must never hold data
   * the saved workspace lacks: after a crash, the older saved copy would win the next merge.
   */
  flush?: () => Promise<void>;
  /**
   * Applies conversations and replicated settings that arrived for part of the workspace. A light
   * connection also hands over the whole copies it read, such as the open chat's, to show.
   */
  applyChats: (
    upsert: Conversation[],
    remove: string[],
    meta?: SharedMeta,
    wholes?: Map<string, Conversation>,
  ) => Promise<void>;
  /** The conversation shown, which a light connection reads whole. */
  openChat?: () => string | undefined;
  /** A copy of the computer and account registry alone, for routing and ownership checks. */
  fleet: () => Fleet;
  /**
   * Counts changes made on this device to the shared workspace, excluding what `apply`
   * receives from the relay. Without it, every poll syncs the whole workspace.
   */
  revision?: () => number;
  statuses: () => Record<string, ProviderStatus>;
  localRuns: () => string[];
  apply: (value: SharedWorkspace) => Promise<void>;
  /**
   * Replaces the Viewer's workspace. `unpublished` names what it changed and had not published,
   * saved with its copy; without it, every conversation counts as changed.
   */
  replaceBrowserWorkspace?: (
    value: Workspace,
    reason?: string,
    preserveInitialNotification?: boolean,
    unpublished?: Unpublished,
  ) => Promise<void>;
  checkpointRun: (
    request: RunRequest,
    event?: RunEvent,
    status?: 'complete' | 'cancelled' | 'error',
    error?: string,
  ) => Promise<void>;
  /**
   * Follows a reply this computer runs for another device whose request the relay no longer
   * holds, after this window reloaded: it ends here, like a reply of this window's own.
   */
  followReply?: (runId: string) => void;
};
type RelayState = { instanceId: string; revision: number; workspace: SharedWorkspace };
let runtime: RuntimeContext | undefined;
let relayUrl = '';
let relayInstance = '';
let baseline = emptyShared();
// The relay revision `baseline` came from, and the local revision whose data it matched when
// a poll left both sides equal. Later polls then only ask whether the relay moved.
let baselineRevision: number | undefined;
let settledRevision: number | undefined;
// The relay's revision for each conversation and for the rest of the workspace at the baseline,
// and whether this relay answers the incremental routes. Without them, or until the first whole
// sync of a connection has run, polls take the whole-state path below.
let baselineChats: Record<string, number> = {};
let baselineMetaRevision = 0;
// Whether those are the relay's own revisions at `baselineRevision`, so a poll that finds the
// relay still there knows its manifest without asking for it.
let baselineManifest = false;
let manifestEndpoint = true;
// Whether the relay reads and keeps chats light (src/lib/light-chats.ts), as its revision answer
// says, and whether this connection holds them so: the Viewer does from its first read on, since
// a phone cannot hold every reply's recorded work. A light connection never syncs with a relay
// that stops keeping that work, which would store its light chats as they are.
let relayLight = false;
let lightSession = false;
const lightRelayGone = 'The relay no longer keeps chats light. Reload this page to continue.';
// The messages the relay holds, those of the baseline. A light connection leaves their recorded
// work out of what it syncs and stores, as the relay keeps it; a message only this device holds,
// such as a new fork's, goes out whole.
let relayHeld = new Set<string>();
const noteBaseline = () => {
  relayHeld = lightSession ? messageIds(baseline.conversations) : new Set();
};
/** A conversation as this device syncs and stores it. */
function syncedChat(conversation: Conversation): Conversation {
  return lightSession ? lightChat(conversation, (m) => !relayHeld.has(m.id)) : conversation;
}
/** What this device changed and has not published, as the Viewer saves it, while that is known. */
function unpublishedHere(): Unpublished | undefined {
  const pending = runtime?.pendingChanges?.();
  return pending?.chats ? { chats: [...pending.chats], meta: pending.meta } : undefined;
}
/** Whether this Viewer holds chats light, and reads a chat whole to show it. */
export const holdsLightChats = () => lightSession;
/** Whether the relay holds this message, so this device may leave its recorded work out. */
export const relayHolds = (messageId: string) => relayHeld.has(messageId);
const checkpointRevisionsSchema = z.object({
  revision: z.number().int().nonnegative(),
  chats: z.record(z.string(), z.number().int().nonnegative()),
  metaRevision: z.number().int().nonnegative(),
});
export type CheckpointRevisions = z.infer<typeof checkpointRevisionsSchema>;
/** A checkpoint written before these revisions existed resumes with a whole sync instead. */
const checkpointRevisions = (value: unknown): CheckpointRevisions | undefined =>
  checkpointRevisionsSchema.safeParse(value).data;
// The relay revision the saved checkpoint holds, so an unchanged poll skips rewriting it without
// serializing it to compare, and when it was written. Writing it serializes the whole baseline,
// and only the next start of the app reads it, so while anything changes, on this device or on
// another one it follows, it is rewritten at most once per interval; an older checkpoint merges
// conservatively. The baseline is always the relay's own state at that revision.
let checkpointRevision: number | undefined;
let checkpointSavedAt = 0;
const CHECKPOINT_INTERVAL = 60_000;
// The conversations of the baseline that changed since the checkpoint was last written. A write
// sends those, with the order of them all, and this computer's app completes the file from the
// one it replaces (src-tauri/src/sync_state.rs): the checkpoint holds every conversation, and
// sending all 86 MB of it blocked the page for half a second or more once a minute while a
// reply ran (docs/PERFORMANCE.md). `undefined` when the file is not known to hold the others,
// so the next write sends everything.
let checkpointStale: Set<string> | undefined;
const needsWholeCheckpoint = 'The whole sync checkpoint is needed to save this change.';
// Relays before v1/state/revision answer it with 404; they get the full state each poll.
let revisionEndpoint = true;
// How much one upload carries before the rest goes in the next, in bytes of JSON; a
// conversation larger than that goes in one of its own. Relays before 2026-10-10 refuse uploads
// over 64 MB, with 413.
const uploadBudget = 48_000_000;
// A conversation goes to the relay whole, and a long one takes seconds to upload and for the
// relay to store. Published again with every poll while its reply ran, a 9.8 MB chat kept the
// link and the relay busy with it alone, 118 MB in half a minute (docs/PERFORMANCE.md). So each
// conversation waits its turn, by this page's clock: its uploads take at most a third of the
// time (the next comes `publishShare` times as long after one as that one took) and average at
// most `publishRate` bytes a second, and a poll within `turnSlack` of a turn takes it. A chat
// under a megabyte or so still goes out with every poll, and a change the reader waits for (a
// reply's end, a question) goes out at once (`urgent`). Nothing is left out: what waits is
// published with the conversation's next turn.
const publishTurns = new Map<string, number>();
const publishedAt = new Map<string, number>();
const publishShare = 2;
const publishRate = 512_000;
const turnSlack = 1_000;
// How often a conversation is published when only a running call's elapsed time moved on.
const quietInterval = 15_000;
const tooLarge = 'This workspace change is too large to sync.';
// A problem the last sync met that did not stop it, such as images the relay does not have yet.
let syncNotice = '';
/** What the last sync could not do while still syncing everything else, or an empty string. */
export const relaySyncNotice = () => syncNotice;
const relayReplaced =
  'Relay data was replaced. Restore the original relay data, or use a separate installation for a new private workspace.';
let relayBusy = false;
let relayConnected = false;
let relayGeneration = 0;
let browserSessionCheckedAt = 0;
let browserWorkspaceId = '';
let browserScope: BrowserWorkspaceScope | undefined;
let browserSessionBlocked = false;
const relayConnectionListeners = new Set<(ready: boolean) => void>();
const remoteRuns = new Map<string, boolean>();
const workerRuns = new Map<string, RelayJob>();
// The runs this computer's CLIs are answering for this window, those of replies a queued message
// took over included, until each ends.
const ownRuns = new Set<string>();
// Replies another device asked for that ran on while this window reloaded, until the relay answers
// and their requests go on publishing them (`resumeJob`).
const jobsToResume = new Set<string>();
/** Whether this computer is running work another device asked of it. */
export const workingForOthers = () => workerRuns.size > 0;
// Optional reads never keep this device from disconnecting; late results are discarded.
function workspaceNoticeRead(method: RelayJob['method'], args: Record<string, unknown>) {
  return (
    method === 'toolOutput' ||
    method === 'toolOutputImage' ||
    method === 'toolOutputModel' ||
    method === 'toolOutputModelViews' ||
    method === 'toolOutputTable' ||
    method === 'toolOutputDocument' ||
    method === 'toolOutputFile' ||
    // A screen's request ends with its page; a disconnect drops its answer.
    method === 'screens' ||
    // A sign-in waits on its computer until it ends there, however this device leaves it.
    method === 'signIn' ||
    method === 'signInCode' ||
    (method === 'account' && (args.input as AccountAction)?.action === 'workspaceMessages')
  );
}
function hasBlockingRemoteWork() {
  return (
    [...remoteRuns.values()].some(Boolean) ||
    [...workerRuns.values()].some((job) => !workspaceNoticeRead(job.method, job.args))
  );
}
export function configureRuntime(context: RuntimeContext) {
  runtime = context;
  void startAccountUpdates();
}
/**
 * A new or restored relay connection starts from its checkpoint. With the revisions that
 * checkpoint was written at, the first poll is already incremental; without them it syncs the
 * whole workspace once and learns them from the answer.
 */
function resetBaseline(
  next: SharedWorkspace,
  revisions?: CheckpointRevisions,
  // Whether `next` is what this computer's checkpoint file holds.
  saved = false,
) {
  baseline = next;
  noteBaseline();
  baselineRevision = revisions?.revision;
  settledRevision = undefined;
  checkpointRevision = revisions?.revision;
  checkpointSavedAt = 0;
  checkpointStale = saved ? new Set() : undefined;
  publishTurns.clear();
  publishedAt.clear();
  revisionEndpoint = true;
  baselineChats = revisions?.chats ?? {};
  baselineMetaRevision = revisions?.metaRevision ?? 0;
  // A light connection never syncs the whole state, which would compare its light chats with
  // whole ones. Without the revisions, it asks for the manifest and reads every conversation once.
  if (lightSession && !revisions) {
    baselineRevision = -1;
    baselineChats = Object.fromEntries(next.conversations.map((c) => [c.id, -1]));
  }
  // Revisions that do not name exactly the baseline's conversations came from a checkpoint
  // written without the relay's own; the first poll then asks for the manifest.
  const named = Object.keys(baselineChats);
  syncNotice = '';
  baselineManifest =
    !!revisions &&
    named.length === next.conversations.length &&
    next.conversations.every((c) => c.id in baselineChats);
  manifestEndpoint = true;
}
const accountUpdateGate = new AccountUpdateGate();
const localAccountUpdates = new Map<string, AccountUpdate>();
const accountUpdateListeners = new Set<(update: AccountUpdate, accountChanged: boolean) => void>();
const usageRefreshListeners = new Set<(connectionId: string) => void>();
const resetAttempts = new Map<string, string>();
export const watchUsageRefresh = (listener: (connectionId: string) => void) => {
  usageRefreshListeners.add(listener);
  return () => {
    usageRefreshListeners.delete(listener);
  };
};
export const requestUsageRefresh = (connectionId: string) => {
  for (const listener of usageRefreshListeners) listener(connectionId);
};
const resetScope = (connectionId: string) => `${workspaceStorageScope()}:${connectionId}`;
export const hasPendingReset = (connectionId: string) =>
  resetAttempts.has(resetScope(connectionId));
export async function redeemResetCredit(connectionId: string) {
  const scope = resetScope(connectionId);
  const key = resetAttempts.get(scope) ?? crypto.randomUUID();
  resetAttempts.set(scope, key);
  const result = (await manageAccount(connectionId, {
    action: 'consumeResetCredit',
    idempotencyKey: key,
    confirmed: true,
  })) as { outcome?: string };
  if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome ?? ''))
    throw new Error('Reset outcome is unconfirmed. Retry this same attempt.');
  resetAttempts.delete(scope);
  requestUsageRefresh(connectionId);
  return result.outcome!;
}
// Background work this computer's chat processes keep running, including after their
// replies ended. Viewers have no host process of their own and see saved outcomes only.
export function watchBackgroundWork(listener: (event: BackgroundWorkEvent) => void) {
  if (!desktop()) return () => {};
  let stopped = false;
  let unlisten = () => {};
  const receive = (value: unknown) => {
    const parsed = backgroundWorkEventSchema.safeParse(value);
    if (parsed.success && !stopped) listener(parsed.data);
  };
  void (async () => {
    try {
      const stop = await listen<unknown>('studio-background-work', ({ payload }) =>
        receive(payload),
      );
      if (stopped) stop();
      else unlisten = stop;
      for (const snapshot of await invoke<unknown[]>('background_work'))
        receive({ ...(snapshot as object), kind: 'snapshot' });
    } catch {
      /* Older hosts report background work only while its reply runs. */
    }
  })();
  return () => {
    stopped = true;
    unlisten();
  };
}
let accountUpdatesStarted = false;
export const accountUsageRevision = (connection?: string) =>
  connection ? accountUpdateGate.get(connection) : undefined;
export function watchAccountUpdates(
  listener: (update: AccountUpdate, accountChanged: boolean) => void,
) {
  accountUpdateListeners.add(listener);
  return () => {
    accountUpdateListeners.delete(listener);
  };
}
function receiveAccountUpdate(value: unknown, host: string, local = false) {
  const parsed = accountUpdateSchema.safeParse(value);
  if (!parsed.success || !runtime) return;
  const update = parsed.data;
  const fleet = runtime.fleet();
  const connection = fleet.connections.find((c) => c.id === update.connectionId);
  const account = fleet.accounts.find((a) => a.id === connection?.accountId);
  if (
    !connection ||
    account?.provider !== update.snapshot.provider ||
    executionHost(fleet, connection.environmentId) !== host
  )
    return;
  if (
    Date.now() - update.snapshot.checkedAt * 1000 > 180_000 ||
    update.snapshot.checkedAt * 1000 > Date.now() + 60_000
  )
    return;
  const previous = accountUpdateGate.get(update.connectionId);
  if (!accountUpdateGate.accept(update)) return;
  if (local) localAccountUpdates.set(update.connectionId, update);
  const changed =
    update.accountChanged > 0 &&
    (previous?.epoch !== update.epoch || previous?.accountChanged !== update.accountChanged);
  for (const listener of accountUpdateListeners) listener(update, changed);
}
async function startAccountUpdates() {
  if (!desktop() || accountUpdatesStarted || !runtime) return;
  accountUpdatesStarted = true;
  try {
    await listen<unknown>('studio-account-update', ({ payload }) => {
      if (runtime) receiveAccountUpdate(payload, runtime.installation.id, true);
    });
    for (const update of await invoke<unknown[]>('live_account_updates')) {
      if (runtime) receiveAccountUpdate(update, runtime.installation.id, true);
    }
  } catch {
    /* Older hosts keep the read-only polling fallback. */
  }
}
function accountHeartbeat() {
  if (!desktop() || !runtime) return [];
  const updates: AccountUpdate[] = [];
  const fleet = runtime.fleet();
  for (const update of [...localAccountUpdates.values()].sort(
    (a, b) => b.snapshot.checkedAt - a.snapshot.checkedAt,
  )) {
    const connection = fleet.connections.find((c) => c.id === update.connectionId);
    if (
      !connection ||
      executionHost(fleet, connection.environmentId) !== runtime.installation.id ||
      Date.now() - update.snapshot.checkedAt * 1000 > 180_000
    )
      continue;
    updates.push(update);
  }
  return updates;
}
export const workspaceStorageScope = () =>
  desktop() ? 'desktop' : browserScope ? browserScopeKey(browserScope) : null;
let browserStorageAdopted: Promise<void> | undefined;
// Earlier releases saved the Viewer's cache in localStorage; move it once per page.
async function workspaceStore() {
  browserStorageAdopted ??= adoptBrowserStorage(browserWorkspaceStore, localStorage).catch(
    (error) => {
      browserStorageAdopted = undefined;
      throw error;
    },
  );
  await browserStorageAdopted;
  return browserWorkspaceStore;
}
export const relayConnectionGeneration = () => (relayConnected ? relayGeneration : null);
export function watchRelayConnection(listener: (ready: boolean) => void): () => void {
  relayConnectionListeners.add(listener);
  return () => {
    relayConnectionListeners.delete(listener);
  };
}
function notifyRelayConnection(ready: boolean) {
  if (!ready) accountUpdateGate.clear();
  if (!ready) noteWorkflows(undefined);
  for (const listener of relayConnectionListeners) listener(ready);
}

function announceBrowserSession(workspaceId: string) {
  localStorage.setItem(
    browserSessionSignal,
    JSON.stringify({ workspaceId, nonce: crypto.randomUUID() }),
  );
}
async function endBrowserSession(reason: string) {
  ++relayGeneration;
  relayConnected = false;
  browserSessionBlocked = true;
  browserWorkspaceId = '';
  const previousScope = browserScope;
  browserScope = undefined;
  notifyRelayConnection(false);
  lightSession = false;
  resetBaseline(emptyShared());
  contextCache = makeContextCache();
  updatePendingBadge(0);
  await runtime?.replaceBrowserWorkspace?.(initialWorkspace(), reason);
  if (previousScope)
    await clearBrowserWorkspace(await workspaceStore(), localStorage, previousScope);
}
export function watchBrowserSession(): () => void {
  if (desktop()) return () => {};
  const changed = (event: StorageEvent) => {
    if (event.key !== browserSessionSignal) return;
    let workspaceId: unknown;
    try {
      workspaceId = JSON.parse(event.newValue ?? 'null')?.workspaceId;
    } catch {
      /* clear safely */
    }
    if (workspaceId === browserWorkspaceId) return;
    // The other tab's sign-in discards this workspace's cache if clearing it fails here.
    void endBrowserSession(
      'This browser’s workspace changed in another tab. Reload or pair again to continue.',
    ).catch(() => {});
  };
  window.addEventListener('storage', changed);
  return () => window.removeEventListener('storage', changed);
}
export async function getInstallation(): Promise<Installation> {
  if (desktop()) return invoke('get_installation');
  const stored = localStorage.getItem('agent-studio.installation');
  if (stored) return JSON.parse(stored);
  const installation: Installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'This browser',
    platform: 'preview',
  };
  localStorage.setItem('agent-studio.installation', JSON.stringify(installation));
  return installation;
}
export async function detectConnection(
  provider: ProviderId,
  connectionId: string,
): Promise<ProviderStatus> {
  return invoke('detect_connection', { provider, connectionId });
}
// Read-only login check for an environment's existing CLI login before any connection is saved.
export async function detectEnvironmentLogin(
  environmentId: string,
  provider: ProviderId,
): Promise<ProviderStatus> {
  if (!desktop())
    return {
      id: provider,
      installed: false,
      version: null,
      auth: 'unknown',
      detail: 'Open the desktop app to use installed CLIs.',
    };
  return invoke('detect_environment_login', { provider, environmentId });
}
export async function discoverWsl(): Promise<WslDiscovery> {
  return desktop() ? invoke('discover_wsl') : { distributions: [], warning: null };
}
export async function inspectEnvironmentClis(environmentId: string): Promise<CliInstallation[]> {
  return invoke('inspect_environment_clis', { environmentId });
}
function remoteTarget(connectionId?: string, environmentId?: string) {
  if (environmentId) {
    const fleet = runtime?.fleet();
    if (!fleet?.environments.some((e) => e.id === environmentId))
      throw new Error('This environment no longer exists.');
    const host = executionHost(fleet, environmentId);
    return host === runtime?.installation.id ? undefined : host;
  }
  if (!connectionId) return undefined;
  const fleet = runtime?.fleet();
  const connection = fleet?.connections.find((c) => c.id === connectionId);
  if (!fleet || !connection)
    throw new Error('This connection no longer exists. Choose an account in Connections.');
  const host = executionHost(fleet, connection.environmentId);
  return host === runtime?.installation.id ? undefined : host;
}
// Only the execution host can declare a run dead. After it restarts, an unfinished reply it
// owns can never finish; a viewer or another computer must keep following the live host.
/** Whether the computer `host` runs this reply, through its account's environment or the chat's. */
function runsOn(fleet: Fleet, conversation: Conversation, message: Message, host: string) {
  const connection = fleet.connections.find((c) => c.id === message.settings?.connectionId);
  const environmentId =
    connection?.environmentId ??
    conversation.location?.executionEnvironmentId ??
    conversation.location?.environmentId;
  if (!environmentId || !fleet.environments.some((e) => e.id === environmentId)) return false;
  return executionHost(fleet, environmentId) === host;
}
function deadRunHere(fleet: Fleet, conversation: Conversation, message: Message): boolean {
  if (!runtime || !message.runId) return false;
  if (!runsOn(fleet, conversation, message, runtime.installation.id)) return false;
  return (
    !runtime.localRuns().includes(message.runId) &&
    !workerRuns.has(message.runId) &&
    !ownRuns.has(message.runId) &&
    !jobsToResume.has(message.runId)
  );
}
// Replies this computer runs without holding a run for them, by run, from when a check first found
// them so (`abandonedReplies`).
const unownedRuns = new Map<string, number>();
// How long a reply stays so before it counts as abandoned. Another device publishes its chat before
// it sends this computer the request for it, which then waits on the relay for a poll to take it.
const abandonGrace = 20_000;
/**
 * Replies saved as running that this computer runs but holds no run for, which nothing would ever
 * end: a conflict copy's from a release that left it running (its run went on in the original), or
 * one whose end never reached this window. A reply counts once two checks at least `abandonGrace`
 * apart, or one check when `now` names its conversation, found it so, each with the relay holding
 * no request for it that a computer still has to take or finish.
 */
export async function abandonedReplies(
  conversations: Conversation[],
  now?: string,
): Promise<{ conversationId: string; messageId: string }[]> {
  if (!desktop() || !runtime || !relayConnected) return [];
  const generation = relayGeneration;
  let fleet: Fleet | undefined;
  const found: { conversation: Conversation; message: Message }[] = [];
  for (const conversation of conversations)
    // Running replies end a conversation: messages queued for them come after.
    for (let index = conversation.messages.length - 1; index >= 0; index--) {
      const message = conversation.messages[index];
      if (message.role !== 'assistant') continue;
      if (message.status !== 'running') break;
      if (deadRunHere((fleet ??= runtime.fleet()), conversation, message))
        found.push({ conversation, message });
    }
  const checked = new Set<string>();
  const abandoned: { conversationId: string; messageId: string }[] = [];
  for (const { conversation, message } of found) {
    const runId = message.runId!;
    checked.add(runId);
    const job = await relayRaw('GET', `v1/jobs/${runId}`);
    if (generation !== relayGeneration) return [];
    if (
      job.status === 200
        ? !['complete', 'cancelled', 'error'].includes(job.body?.status)
        : job.status !== 404
    ) {
      unownedRuns.delete(runId);
      continue;
    }
    const since = unownedRuns.get(runId) ?? Date.now();
    unownedRuns.set(runId, since);
    if (conversation.id !== now && Date.now() - since < abandonGrace) continue;
    // A run may have started here while the relay answered.
    if (!deadRunHere(runtime.fleet(), conversation, message)) continue;
    abandoned.push({ conversationId: conversation.id, messageId: message.id });
  }
  for (const runId of unownedRuns.keys()) if (!checked.has(runId)) unownedRuns.delete(runId);
  return abandoned;
}
async function relayRaw(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  if (desktop()) return invoke('relay_request', { method, path, body: body ?? null });
  if (!runtime) throw new Error('This device is still loading.');
  const generation = relayGeneration;
  const sessionRequest = path === 'v1/browser-session';
  if (!sessionRequest && !browserWorkspaceId)
    throw new Error('Pair this device with your private workspace first.');
  const text = body === undefined ? undefined : JSON.stringify(body);
  // A request takes as long as it needs to send and for the relay to answer; once the answer
  // comes, it may not stall for 30 seconds, and the clock restarts with each part that arrives.
  const controller = new AbortController();
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const allow = (ms: number) => {
    clearTimeout(stalled);
    stalled = setTimeout(
      () => controller.abort(new DOMException('The relay stopped answering.', 'TimeoutError')),
      ms,
    );
  };
  let result: { status: number; body: any };
  try {
    const response = await fetch(`/${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Environment-Id': runtime.installation.id,
        // This app keeps chat images as references to the relay's image store.
        'X-Studio-Images': '1',
        ...(browserWorkspaceId && !(sessionRequest && method === 'POST')
          ? { 'X-Workspace-Id': browserWorkspaceId }
          : {}),
      },
      body: text,
      cache: 'no-store',
      keepalive: path === 'v1/notification-view',
      redirect: 'error',
      signal: controller.signal,
    });
    allow(30_000);
    result = {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await answer(response, () => allow(30_000))
        : { error: 'Open the PWA on your Agent Studio server.' },
    };
  } finally {
    clearTimeout(stalled);
  }
  if (generation !== relayGeneration)
    throw new Error('The private workspace connection changed. Try again after pairing.');
  if (
    (result.status === 401 && !(sessionRequest && method === 'POST')) ||
    result.body?.code === 'workspace_changed'
  ) {
    const reason =
      result.body?.code === 'workspace_changed'
        ? 'This browser is paired with a different private workspace. Reload or pair again to continue.'
        : sessionRequest && method === 'GET' && !browserWorkspaceId
          ? ''
          : 'Your workspace session ended. Sign in again to continue.';
    await endBrowserSession(reason);
  }
  return result;
}
/** A JSON answer read part by part, telling `moving` of each part that arrives. */
async function answer(response: Response, moving: () => void): Promise<unknown> {
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    moving();
  }
  return JSON.parse(await new Blob(parts as BlobPart[]).text());
}
export class OfflineHostError extends Error {}
/** A relay answer other than success, with its status. */
class RelayResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export type PushStatus = {
  publicKey: string;
  enabled: boolean;
  unavailable: boolean;
  deliveryFailed: boolean;
  lastSent?: number;
};
export async function pushSettings(): Promise<PushStatus> {
  return relayApi('GET', 'v1/push');
}
export async function savePushSubscription(subscription: PushSubscription): Promise<PushStatus> {
  return relayApi('PUT', 'v1/push', subscription.toJSON());
}
export async function disablePushNotifications(): Promise<void> {
  await relayApi('DELETE', 'v1/push');
}
export async function testPushNotification(): Promise<void> {
  await relayApi('POST', 'v1/push/test');
}

export type WorkspaceRole = 'admin' | 'member';
export type ManagedWorkspace = {
  id: string;
  name: string;
  role: WorkspaceRole;
  enabled: boolean;
  createdAt: number | null;
};
export type WorkspaceAdministration = {
  workspaceId: string;
  role: WorkspaceRole;
  workspaces?: ManagedWorkspace[];
};
export class WorkspaceAdministrationError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'WorkspaceAdministrationError';
  }
}
async function workspaceAdministrationRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const generation = relayGeneration;
  if (!relayConnected)
    throw new WorkspaceAdministrationError('Connect to your workspace first.', 401);
  const response = await relayRaw(method, path, body);
  // Native requests also need a generation check: an old response must never
  // reveal an issued key after the renderer has changed relay connections.
  if (generation !== relayGeneration || !relayConnected)
    throw new WorkspaceAdministrationError('The private workspace connection changed.', 401);
  if (method === 'GET' && response.status === 404) return null;
  if (response.status >= 300)
    throw new WorkspaceAdministrationError(
      response.body?.error ?? 'Workspace administration failed.',
      response.status,
      response.body?.code,
    );
  return response.body as T;
}
export const readWorkspaceAdministration = () =>
  workspaceAdministrationRequest<WorkspaceAdministration>('GET', 'v1/workspace-admin');
export const createManagedWorkspace = (name: string, role: WorkspaceRole) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace; token: string }>(
    'POST',
    'v1/workspace-admin/workspaces',
    { name, role },
  );
export const updateManagedWorkspace = (id: string, name: string, role: WorkspaceRole) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace }>(
    'PUT',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}`,
    { name, role },
  );
export const rotateManagedWorkspaceKey = (id: string) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace; token: string }>(
    'POST',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}/rotate`,
  );
export const disableManagedWorkspace = (id: string) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace }>(
    'POST',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}/disable`,
  );

type StatePatch = {
  revision: number;
  meta?: SharedMeta;
  upsert?: Conversation[];
  remove?: string[];
};
/**
 * Sends the relay conversations and settings that changed here. The desktop app takes the
 * request as bytes, in which the parts of each conversation that did not change since the last
 * upload are copied rather than written again (src/lib/chat-bytes.ts).
 */
function relayPatch(patch: StatePatch): Promise<{ status: number; body: any }> {
  const { upsert, ...rest } = patch;
  if (!desktop() || !upsert?.length || callsUsePostMessage())
    return relayRaw('POST', 'v1/state/patch', patch);
  const body = jsonWith(rest, [['upsert', chatList(upsert)]]);
  return invoke(
    'relay_request',
    joinBytes(jsonWith({ method: 'POST', path: 'v1/state/patch' }, [['body', body]])),
  );
}
async function relayApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await relayRaw(method, path, body);
  if (response.body?.code === 'host_offline') throw new OfflineHostError(response.body.error);
  if (response.status >= 300)
    throw new RelayResponseError(
      response.body?.error ?? `Relay request failed (${response.status}).`,
      response.status,
    );
  return response.body;
}
export async function connectRelay(url: string, token: string) {
  if (!runtime) throw new Error('This device is still loading.');
  if (hasBlockingRemoteWork())
    throw new Error('Wait for remote requests to finish before changing relays.');
  let generation = ++relayGeneration;
  notifyRelayConnection(false);
  if (desktop()) await invoke('relay_connect', { url, token });
  else {
    if (url !== window.location.origin)
      throw new Error('Open the PWA on your relay server to pair this device.');
    await endBrowserSession('');
    generation = relayGeneration;
    const session = await relayApi<{ workspaceId: string }>('POST', 'v1/browser-session', {
      token,
      environmentId: runtime.installation.id,
    });
    if (!session.workspaceId) throw new Error('Update the relay to support private workspaces.');
    browserSessionBlocked = false;
    browserWorkspaceId = session.workspaceId;
    browserSessionCheckedAt = Date.now();
    announceBrowserSession(session.workspaceId);
  }
  if (!(await acceptRelay(url, generation)))
    throw new Error('The private workspace connection changed. Pair this device again.');
}
type WholeState = {
  instanceId: string;
  workspaceId?: string;
  revision?: number;
  workspace: SharedWorkspace;
  chatRevisions?: unknown;
  metaRevision?: unknown;
};
/**
 * The relay data this connection reaches, from its small revision answer. A relay without that
 * route sends its whole state instead, which the caller may reuse; a device that already holds
 * the workspace never needs it to connect.
 */
/**
 * Whether the relay keeps images in its image store, as its revision answer says. One that
 * predates the store cannot take conversations that name images by reference: they stay on
 * this device until the relay is updated.
 */
let relayStoresImages = false;
const oldRelayImages = 'Update the relay to sync conversations with images.';
function noteImageStore(probe: { status: number; body: any }) {
  if (probe.status !== 200) return;
  noteWorkflows(probe.body?.workflows);
  relayStoresImages = probe.body?.images === 1;
  relayLight = probe.body?.light === 1;
  if (lightSession && !relayLight) throw new Error(lightRelayGone);
}
async function relayIdentity(): Promise<{ instanceId: string; state?: WholeState }> {
  const probe = await relayRaw('GET', 'v1/state/revision');
  noteImageStore(probe);
  if (probe.status === 200 && typeof probe.body?.instanceId === 'string') {
    if (
      !desktop() &&
      typeof probe.body.workspaceId === 'string' &&
      probe.body.workspaceId !== browserWorkspaceId
    )
      throw new Error('The relay returned a different private workspace.');
    return { instanceId: probe.body.instanceId };
  }
  if (probe.status !== 200 && probe.status !== 404)
    throw new Error(probe.body?.error ?? `Relay request failed (${probe.status}).`);
  // A relay without that route, or without an identity in it, is asked for everything.
  const state = await relayApi<WholeState>('GET', 'v1/state');
  return { instanceId: state.instanceId, state };
}
async function acceptRelay(url: string, generation: number, restoring = false) {
  const identity = await relayIdentity();
  const instanceId = identity.instanceId;
  if (!instanceId) throw new Error('Relay protocol version is not supported.');
  if (!desktop()) {
    if (generation !== relayGeneration) return false;
    if (identity.state && identity.state.workspaceId !== browserWorkspaceId)
      throw new Error('The relay returned a different private workspace.');
    const preserveInitialNotification = restoring && !browserScope;
    const scope = { url, workspaceId: browserWorkspaceId, instanceId };
    const current = () => generation === relayGeneration;
    // Decided once per connection: the chats this device holds stay light or whole until the next.
    const light = relayLight;
    const store = await workspaceStore();
    if (!current()) return false;
    const saved = await readBrowserWorkspace(store, scope, light);
    if (!current()) return false;
    await discardOtherBrowserWorkspaces(store, localStorage, scope);
    // A copy saved before the image store holds its images inline. Once the relay holds their
    // bytes they become the references the relay keeps, in this copy and in the checkpoint it
    // merges against, so neither is sent or kept inline again. A checkpoint an earlier release
    // saved whole is written back light at once, so no later start reads it whole again; the
    // conversations follow with the first save.
    if (saved && (relayStoresImages || saved.lightened)) {
      try {
        const images =
          relayStoresImages &&
          (await referenceLegacyImages([saved.base, saved.workspace], current));
        if (images || saved.lightened)
          await store.put(
            [
              [
                `${browserScopeKey(scope)}:sync`,
                JSON.stringify({
                  url,
                  instanceId,
                  base: saved.base,
                  ...(saved.revisions !== undefined ? { revisions: saved.revisions } : {}),
                }),
              ],
            ],
            current,
          );
      } catch {
        // They stay inline, which the relay still accepts.
      }
      if (!current()) return false;
    }
    let remote: SharedWorkspace | undefined;
    let revisions: CheckpointRevisions | undefined;
    if (!saved) {
      // A browser without a copy of this workspace downloads it once, with the revisions it
      // came with, so the first poll is already incremental instead of downloading it again.
      const state =
        identity.state ??
        (await relayApi<WholeState>('GET', light ? 'v1/state?light=1' : 'v1/state'));
      if (!current()) return false;
      if (state.instanceId !== instanceId) throw new Error(relayReplaced);
      if (state.workspaceId !== browserWorkspaceId)
        throw new Error('The relay returned a different private workspace.');
      remote = sharedSchema.parse(state.workspace);
      revisions = checkpointRevisions({
        revision: state.revision,
        chats: state.chatRevisions,
        metaRevision: state.metaRevision,
      });
      // Write the authenticated baseline first. If the page closes before its first
      // poll, a saved snapshot can still be merged against a verified checkpoint.
      await store.put(
        [
          [
            `${browserScopeKey(scope)}:sync`,
            JSON.stringify({ url, instanceId, base: remote, ...(revisions ? { revisions } : {}) }),
          ],
        ],
        current,
      );
    }
    if (!current()) return false;
    browserScope = scope;
    lightSession = light;
    if (saved) resetBaseline(saved.base, checkpointRevisions(saved.revisions));
    else resetBaseline(remote!, revisions);
    relayInstance = instanceId;
    relayUrl = url;
    relayConnected = true;
    const restored = saved?.workspace ?? browserWorkspaceFromServer(remote!);
    // A copy downloaded now holds nothing of this device's own; a saved one names its changes.
    await runtime?.replaceBrowserWorkspace?.(
      restored,
      undefined,
      preserveInitialNotification,
      saved ? saved.unpublished : { chats: [], meta: false },
    );
    if (generation === relayGeneration) notifyRelayConnection(true);
    return generation === relayGeneration;
  }
  const checkpoint = await invoke<{
    url: string;
    instanceId: string;
    base: SharedWorkspace;
    revisions?: unknown;
  } | null>('load_sync_state');
  if (generation !== relayGeneration) return false;
  if (restoring && checkpoint?.url === url && checkpoint.instanceId !== instanceId)
    throw new Error(relayReplaced);
  const resumed = checkpoint?.url === url && checkpoint.instanceId === instanceId;
  const nextBaseline = resumed ? sharedSchema.parse(checkpoint.base) : emptyShared();
  if (generation !== relayGeneration) return false;
  resetBaseline(
    nextBaseline,
    resumed ? checkpointRevisions(checkpoint.revisions) : undefined,
    resumed,
  );
  relayInstance = instanceId;
  relayUrl = url;
  relayConnected = true;
  notifyRelayConnection(true);
  return true;
}
export async function resumeRelay(): Promise<boolean> {
  if (!desktop()) return resumeBrowserRelay();
  if (!runtime) return false;
  const generation = relayGeneration;
  // Native returns only the origin. Saved pairing keys never enter the renderer.
  const url = await invoke<string | null>('relay_resume');
  if (!url || generation !== relayGeneration) return false;
  return relayConnected || acceptRelay(url.replace(/\/$/, ''), generation, true);
}
export async function resumeBrowserRelay(): Promise<boolean> {
  if (desktop() || !runtime || browserSessionBlocked) return false;
  const generation = relayGeneration;
  const response = await relayRaw('GET', 'v1/browser-session');
  if (response.status === 401 || response.status === 404) return false;
  if (response.status !== 200) throw new Error('Server unavailable. Reconnecting automatically…');
  if (response.body.environmentId !== runtime.installation.id)
    throw new Error('Pair this device again to restore its server connection.');
  if (generation !== relayGeneration) return false;
  if (!response.body.workspaceId)
    throw new Error('Update the relay to support private workspaces.');
  if (browserWorkspaceId && browserWorkspaceId !== response.body.workspaceId) {
    await endBrowserSession(
      'This browser is paired with a different private workspace. Reload or pair again to continue.',
    );
    return false;
  }
  browserWorkspaceId = response.body.workspaceId;
  browserSessionCheckedAt = Date.now();
  return relayConnected || acceptRelay(window.location.origin, generation, true);
}
export async function disconnectRelay() {
  if (hasBlockingRemoteWork())
    throw new Error('Stop remote responses and wait for requests to finish before disconnecting.');
  ++relayGeneration;
  notifyRelayConnection(false);
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  if (desktop()) await invoke('relay_disconnect');
  else {
    await relayApi('DELETE', 'v1/browser-session');
    announceBrowserSession('');
    await endBrowserSession('Disconnected from your private workspace.');
  }
  relayConnected = false;
}
/**
 * Publishes and takes in only the conversations that moved. Returns `false` when this relay has
 * no incremental routes, or when this connection has not agreed on a baseline yet, so the
 * whole-state path below runs instead; `null` when the connection changed while it worked.
 */
async function syncIncremental(
  generation: number,
  options: MergeOptions | undefined,
  urgent = false,
): Promise<boolean | null> {
  if (!runtime || baselineRevision === undefined || !manifestEndpoint) return false;
  // Most polls find the relay still where this device's baseline came from. Its small revision
  // says so, and the manifest would only repeat the revisions this device already holds.
  let manifest: Manifest | undefined;
  if (baselineManifest && revisionEndpoint) {
    const probe = await relayRaw('GET', 'v1/state/revision');
    noteImageStore(probe);
    if (probe.status !== 200 && probe.status !== 404)
      throw new Error(probe.body?.error ?? `Relay request failed (${probe.status}).`);
    if (
      probe.status === 200 &&
      typeof probe.body?.instanceId === 'string' &&
      typeof probe.body.revision === 'number'
    ) {
      if (probe.body.instanceId !== relayInstance) throw new Error(relayReplaced);
      if (probe.body.revision === baselineRevision)
        manifest = {
          instanceId: relayInstance,
          revision: baselineRevision,
          metaRevision: baselineMetaRevision,
          chats: baselineChats,
        };
    } else revisionEndpoint = false;
  }
  if (!manifest) {
    const probe = await relayRaw('GET', 'v1/state/manifest');
    if (probe.status === 404) {
      manifestEndpoint = false;
      return false;
    }
    if (probe.status !== 200)
      throw new Error(probe.body?.error ?? `Relay request failed (${probe.status}).`);
    const read = manifestSchema.safeParse(probe.body);
    if (!read.success) {
      manifestEndpoint = false;
      return false;
    }
    manifest = read.data;
  }
  if (manifest.instanceId !== relayInstance) throw new Error(relayReplaced);
  const relayed = manifest;
  // What this poll publishes of what changed here. A conversation uploaded a moment ago waits
  // its turn, and one in which only a call's elapsed time moved on goes out now and then; a
  // conversation the relay changed too is merged at once. What waits goes straight back.
  const taken = runtime.takeUnsynced();
  // Handed back when this poll publishes nothing.
  const unpublished: ChangeSet = { chats: taken.chats, meta: taken.meta, quiet: new Set() };
  const changes: ChangeSet = { chats: taken.chats, meta: taken.meta };
  if (taken.chats) {
    const now = performance.now();
    const moved = (id: string) => relayed.chats[id] !== baselineChats[id];
    const waits = (id: string) => !urgent && !moved(id) && now < (publishTurns.get(id) ?? 0);
    const chats = new Set<string>();
    const later: ChangeSet = { chats: new Set(), meta: false, quiet: new Set() };
    for (const id of taken.chats) (waits(id) ? later.chats! : chats).add(id);
    unpublished.chats = new Set(chats);
    for (const id of taken.quiet ?? []) {
      const recent = now - (publishedAt.get(id) ?? -quietInterval) < quietInterval;
      if (!moved(id) && (recent || waits(id))) later.quiet!.add(id);
      else {
        unpublished.quiet!.add(id);
        chats.add(id);
      }
    }
    changes.chats = chats;
    if (later.chats!.size || later.quiet!.size) runtime.restoreUnsynced(later);
  }
  // Whatever this poll does not get onto the relay waits for the next one.
  let published = false;
  try {
    const localIds = runtime.chatIds();
    const baselineIds = baseline.conversations.map((c) => c.id);
    const { involved, fetch, metaMoved } = involvedChats({
      manifest: relayed,
      baselineChats,
      baselineMetaRevision,
      baselineIds,
      localIds,
      changedHere: changes.chats,
    });
    // A conversation the Viewer holds that neither the relay nor its baseline has, and that it did
    // not make (`received` below), was deleted elsewhere after a baseline the Viewer never saved,
    // and follows the relay out instead of lingering here.
    if (!desktop() && runtime.pendingChanges?.().chats) {
      const listed = new Set([...involved, ...baselineIds]);
      for (const id of localIds) if (!listed.has(id) && !(id in relayed.chats)) involved.push(id);
    }
    // Verify what the relay holds before publishing the viewed chat, as the whole path does.
    await publishNotificationView();
    if (generation !== relayGeneration) return null;
    // The settings travel apart from the conversations, so they need a look only when they
    // moved on either side, or when a change here named nothing.
    const settings = metaMoved || changes.meta || changes.chats === undefined;
    if (!involved.length && !settings) {
      // A checkpoint skipped while things were moving catches up once they stop.
      const behind = checkpointRevision !== baselineRevision;
      baselineRevision = relayed.revision;
      published = true;
      if (behind)
        await saveCheckpoint(
          generation,
          baseline,
          relayed.revision,
          { chats: baselineChats, metaRevision: baselineMetaRevision },
          false,
          [],
        );
      return true;
    }
    const baselineMeta = metaOf(baseline);
    let remoteMeta = baselineMeta;
    if (metaMoved) {
      const answer = metaAnswerSchema.parse(await relayApi<unknown>('GET', 'v1/state/meta'));
      if (answer.instanceId !== relayInstance) throw new Error(relayReplaced);
      remoteMeta = answer.meta;
    }
    // Each conversation here is read once per poll: validating it detaches it at a cost that
    // grows with its size, and the merge and the plan compare the same copy. A light connection
    // reads it as it syncs it, without the work the relay holds.
    const read = new Map<string, Conversation | undefined>();
    const localChat = (id: string) => {
      if (!read.has(id)) {
        const conversation = runtime!.chat(id);
        read.set(id, conversation && syncedChat(conversation));
      }
      return read.get(id);
    };
    // A light connection reads light chats, but whole the open one, to show, and any holding work
    // only this device recorded, whose copies on the relay then merge whole with it.
    const open = lightSession ? runtime.openChat?.() : undefined;
    const whole = new Set(
      lightSession
        ? fetch.filter((id) => {
            const own = localChat(id);
            return id === open || (!!own && holdsWork(own));
          })
        : [],
    );
    const wholes = new Map<string, Conversation>();
    const fetched = new Map<string, Conversation>();
    // The relay answers up to a thousand conversations per request, within a size budget, and
    // names those it left for another request.
    const wanted = [...fetch];
    while (wanted.length) {
      const ids = wanted.splice(0, 1000);
      const answer = chatsAnswerSchema.parse(
        await relayApi<unknown>(
          'POST',
          'v1/state/chats',
          lightSession ? { ids, light: true, full: ids.filter((id) => whole.has(id)) } : { ids },
        ),
      );
      if (answer.instanceId !== relayInstance) throw new Error(relayReplaced);
      for (const conversation of answer.chats) {
        if (!lightSession) {
          fetched.set(conversation.id, conversation);
          continue;
        }
        if (whole.has(conversation.id)) wholes.set(conversation.id, conversation);
        // The merge reads the relay's copy light, but whole where this device recorded work.
        const own = localChat(conversation.id);
        const recorded = own ? workIds(own) : new Set<string>();
        fetched.set(
          conversation.id,
          lightChat(conversation, (m) => recorded.has(m.id)),
        );
      }
      const asked = new Set(ids);
      const rest = (answer.rest ?? []).filter((id) => asked.has(id) && !fetched.has(id));
      if (rest.length && !answer.chats.length)
        throw new Error('The relay sent none of the conversations it was asked for.');
      wanted.unshift(...rest);
    }
    if (generation !== relayGeneration) return null;
    const baseChats = new Map(baseline.conversations.map((c) => [c.id, c]));
    // A conversation the relay still holds at the baseline revision is the baseline's own copy.
    const remoteChat = (id: string) =>
      fetched.get(id) ?? (id in relayed.chats ? baseChats.get(id) : undefined);
    const localMeta = runtime.meta();
    // The Viewer marks each change of its own as it makes it and saves those it has not published
    // with its copy, so the rest of its copy, and its settings when it changed none, hold only what
    // it received: they follow the relay whatever its baseline holds, and never become a conflict
    // copy. A phone closed between saving what a sync took in and saving the baseline that came
    // with it took such chats for its own edits (2026-10-15). Read now, after the requests above,
    // so a change made meanwhile counts as its own.
    const pending = desktop() ? undefined : runtime.pendingChanges?.();
    const own = pending?.chats;
    const merged = mergeInvolved({
      involved,
      baseline: baseChats,
      baselineMeta,
      localChat,
      localMeta: own && !pending!.meta ? baselineMeta : localMeta,
      remoteChat,
      remoteMeta,
      options: own ? { ...options, received: (id: string) => !own.has(id) } : options,
    });
    const plan = syncPlan({
      involved,
      merged,
      manifest: relayed,
      localChat,
      localMeta,
      remoteChat,
      remoteMeta,
    });
    let current = relayed;
    // Uploads go out in turns of about the upload budget, a conversation larger than that in one
    // of its own, and removals a thousand at a time.
    const { send, held } = await publishable(plan.send);
    const batches = uploadBatches(send, plan.sizes, uploadBudget);
    const removals: string[][] = [];
    for (let at = 0; at < plan.remove.length; at += 1000)
      removals.push(plan.remove.slice(at, at + 1000));
    const rounds = Math.max(batches.length, removals.length, plan.sendMeta ? 1 : 0);
    for (let round = 0; round < rounds; round++) {
      const upsert = batches[round] ?? [];
      const remove = removals[round] ?? [];
      const started = performance.now();
      const response = await relayPatch({
        revision: current.revision,
        ...(round === 0 && plan.sendMeta ? { meta: plan.sendMeta } : {}),
        ...(upsert.length ? { upsert } : {}),
        ...(remove.length ? { remove } : {}),
      });
      if (response.status === 409) {
        const moved = manifestSchema.safeParse(response.body);
        if (moved.success && moved.data.instanceId !== relayInstance)
          throw new Error(relayReplaced);
        // Another device wrote first. Keep these conversations unpublished and start over on
        // the next poll with a fresh manifest, rather than guess what it stored.
        return true;
      }
      if (response.status === 413) throw new Error(tooLarge);
      if (response.status !== 200)
        throw new Error(response.body?.error ?? 'Workspace sync failed.');
      current = manifestSchema.parse(response.body);
      if (current.instanceId !== relayInstance) throw new Error(relayReplaced);
      // When each conversation's next turn comes. Its share of this upload's time is by size.
      const ended = performance.now();
      const sent = upsert.reduce((sum, c) => sum + (plan.sizes.get(c.id) ?? 0), 0);
      for (const { id } of upsert) {
        const size = plan.sizes.get(id) ?? 0;
        const share = ((ended - started) * size) / (sent || 1);
        publishedAt.set(id, ended);
        publishTurns.set(
          id,
          Math.max(ended + publishShare * share, started + (size / publishRate) * 1000) - turnSlack,
        );
      }
      for (const id of remove) {
        publishedAt.delete(id);
        publishTurns.delete(id);
      }
    }
    published = true;
    syncNotice = heldNotice(held);
    // Their images may reach the relay later, so they are tried again on the next poll.
    if (held.length)
      runtime.restoreUnsynced({ chats: new Set(held.map((c) => c.id)), meta: false });
    if (generation !== relayGeneration) return null;
    // The relay now holds every message of what it took, so saves from here on, such as the one
    // applying this sync, leave that work out.
    if (lightSession) {
      const kept = new Set(held.map((c) => c.id));
      for (const [id, conversation] of plan.result)
        if (!kept.has(id)) for (const message of messageIds([conversation])) relayHeld.add(message);
    }
    // The merge read this device before the patch went out. A conversation edited here since,
    // such as a reply that finished meanwhile, merges again over that edit, with the copy the
    // merge read as its base, instead of being replaced by the older merge; the result goes out
    // with the next poll.
    const since = new Set<string>();
    const changedSince = (id: string) => {
      const live = runtime!.chat(id);
      const now = live && syncedChat(live);
      return now && !jsonEqual(read.get(id), now) ? now : undefined;
    };
    const again = (id: string, now: Conversation, remote: Conversation | undefined) => {
      const before = read.get(id);
      return mergeInvolved({
        involved: [id],
        baseline: new Map(before ? [[id, before]] : []),
        baselineMeta: localMeta,
        localChat: () => now,
        localMeta,
        remoteChat: () => remote,
        remoteMeta: localMeta,
        options,
      }).conversations;
    };
    const apply: Conversation[] = [];
    for (const conversation of plan.apply) {
      const now = changedSince(conversation.id);
      if (!now) {
        apply.push(conversation);
        continue;
      }
      for (const result of again(conversation.id, now, conversation)) {
        apply.push(result);
        since.add(result.id);
      }
    }
    // A conversation deleted elsewhere yields to that deletion, unless it was edited here
    // meanwhile: then, as in any merge, the edit survives as a copy.
    for (const id of plan.forget) {
      const now = changedSince(id);
      if (now)
        for (const result of again(id, now, undefined)) {
          apply.push(result);
          since.add(result.id);
        }
    }
    if (apply.length || plan.forget.length || plan.applyMeta || wholes.size) {
      await runtime.applyChats(apply, plan.forget, plan.applyMeta, wholes);
      if (generation !== relayGeneration) return null;
    }
    // A change other than replies moving on goes into the checkpoint now: after a reload, what
    // this device saved since its checkpoint looks edited here, and merging that with a rewind,
    // retry or archive made elsewhere left a conflict copy of the chat. A Viewer, which a phone
    // may close at any moment, does the same for such a change of its own.
    const structural =
      !!plan.applyMeta ||
      apply.some((c) => !onlyRepliesMoved(read.get(c.id), c)) ||
      (!desktop() && (!!plan.sendMeta || send.some((c) => !onlyRepliesMoved(remoteChat(c.id), c))));
    if (since.size) runtime.restoreUnsynced({ chats: since, meta: false });
    // The relay still holds its own copy of a conversation this poll could not send.
    const result = new Map(plan.result);
    for (const { id } of held) {
      const remote = remoteChat(id);
      if (remote) result.set(id, remote);
      else result.delete(id);
    }
    // The relay now holds the work of every message here, so a light baseline leaves it out.
    if (lightSession)
      for (const [id, conversation] of result) result.set(id, lightChat(conversation));
    const next: SharedWorkspace = {
      ...plan.mergedMeta,
      conversations: nextBaselineChats(baseline.conversations, involved, result),
    };
    await saveCheckpoint(
      generation,
      next,
      current.revision,
      { chats: current.chats, metaRevision: current.metaRevision },
      structural,
      involved,
    );
    if (generation !== relayGeneration) return null;
    baseline = next;
    noteBaseline();
    baselineRevision = current.revision;
    baselineChats = current.chats;
    baselineMetaRevision = current.metaRevision;
    baselineManifest = true;
    settledRevision = undefined;
    return true;
  } finally {
    if (!published) runtime.restoreUnsynced(unpublished);
    runtime.settleUnsynced?.();
  }
}
/**
 * The relay's whole copies of these conversations, for a light connection to show, fork or export
 * one: all of them, or each answer handed to `each` in turn, so an export never holds every chat
 * whole at once. A conversation the relay lacks is left out.
 */
export async function readWholeChats(
  ids: string[],
  each?: (chats: Conversation[]) => void | Promise<void>,
): Promise<Conversation[]> {
  if (!relayConnected) throw new Error('Connect to your workspace to read this chat.');
  const generation = relayGeneration;
  const found: Conversation[] = [];
  const wanted = [...ids];
  while (wanted.length) {
    const batch = wanted.splice(0, 1000);
    const answer = chatsAnswerSchema.parse(
      await relayApi<unknown>('POST', 'v1/state/chats', { ids: batch }),
    );
    if (generation !== relayGeneration)
      throw new Error('The private workspace connection changed. Try again after pairing.');
    if (answer.instanceId !== relayInstance) throw new Error(relayReplaced);
    if (each) await each(answer.chats);
    else found.push(...answer.chats);
    const asked = new Set(batch);
    const sent = new Set(answer.chats.map((c) => c.id));
    const rest = (answer.rest ?? []).filter((id) => asked.has(id) && !sent.has(id));
    if (rest.length && !answer.chats.length)
      throw new Error('The relay sent none of the conversations it was asked for.');
    wanted.unshift(...rest);
  }
  return found;
}
/**
 * A browser's workspace export, as indented JSON with its images' bytes inline. A light connection
 * puts each conversation's work back from the relay's whole copy, an answer at a time; one the
 * relay lacks, such as a new one not synced yet, is exported as this device holds it.
 */
export async function browserExport(copy: Workspace): Promise<{ blob: Blob; missing: number }> {
  const { conversations, ...rest } = copy;
  let missing = 0;
  const chunks: Blob[] = [];
  const done = new Set<string>();
  const write = async (list: Conversation[]) => {
    if (!list.length) return;
    missing += await portableWorkspace({ conversations: list });
    const parts: string[] = [];
    for (const conversation of list) {
      parts.push(
        `${done.size ? ',\n' : ''}    ${JSON.stringify(conversation, null, 2).replaceAll('\n', '\n    ')}`,
      );
      done.add(conversation.id);
    }
    chunks.push(new Blob(parts));
  };
  if (lightSession) {
    const local = new Map(conversations.map((c) => [c.id, c]));
    await readWholeChats([...local.keys()], async (wholes) => {
      const found = messagesById(wholes);
      await write(
        wholes.flatMap((whole) => {
          const own = local.get(whole.id);
          return own ? [restoreChat(own, (id) => found.get(id))] : [];
        }),
      );
    });
    await write(conversations.filter((c) => !done.has(c.id)));
  } else await write(conversations);
  const head = JSON.stringify({ ...rest, conversations: [] }, null, 2).replace(/\[\]\n}$/, '[\n');
  return {
    blob: new Blob([head, ...chunks, done.size ? '\n  ]\n}' : ']\n}'], {
      type: 'application/json',
    }),
    missing,
  };
}
/**
 * Writes the merge baseline and the revisions it came from for the next start of the app, at
 * most once per interval unless `now`, for a change other than replies moving on. Call before
 * advancing the baseline in memory, so a failed write leaves the next poll to try again.
 * `manifest` is left out when the relay reported no per-conversation revisions, so the next start
 * asks for them instead of trusting an empty list. `changed` names the conversations `base` holds
 * otherwise than the baseline before it, or is left out when any may differ.
 */
async function saveCheckpoint(
  generation: number,
  base: SharedWorkspace,
  revision: number,
  manifest?: { chats: Record<string, number>; metaRevision: number },
  now = false,
  changed?: Iterable<string>,
): Promise<void> {
  // Noted whether or not this call writes, so the write that comes carries them.
  if (changed === undefined) checkpointStale = undefined;
  else if (checkpointStale) for (const id of changed) checkpointStale.add(id);
  if (!runtime || revision === checkpointRevision) return;
  if (!now && checkpointSavedAt && Date.now() - checkpointSavedAt < CHECKPOINT_INTERVAL) return;
  // Everything the checkpoint holds must already be in the saved workspace: after a crash, an
  // older saved copy would otherwise win the next merge against the relay's newer one.
  await runtime.flush?.();
  if (generation !== relayGeneration) return;
  const checkpoint = {
    url: relayUrl,
    instanceId: relayInstance,
    base,
    ...(manifest ? { revisions: { revision, ...manifest } } : {}),
  };
  if (desktop()) await writeCheckpoint(checkpoint);
  else if (browserScope) {
    const key = `${browserScopeKey(browserScope)}:sync`;
    const store = await workspaceStore();
    await store.put([[key, JSON.stringify(checkpoint)]], () => generation === relayGeneration);
    if (generation !== relayGeneration) return;
  }
  checkpointRevision = revision;
  checkpointSavedAt = Date.now();
}
/** Writes the checkpoint through this computer's app: what changed, or everything. */
async function writeCheckpoint(checkpoint: {
  url: string;
  instanceId: string;
  base: SharedWorkspace;
  revisions?: CheckpointRevisions;
}): Promise<void> {
  const stale = checkpointStale;
  // Changes that arrive while this write runs belong to the next one.
  checkpointStale = new Set();
  try {
    if (stale && !callsUsePostMessage()) {
      const { conversations, ...meta } = checkpoint.base;
      const order = conversations.map((c) => c.id);
      const upsert = conversations.filter((c) => stale.has(c.id));
      try {
        await invoke(
          'save_sync_state',
          joinBytes(
            jsonWith({ value: { ...checkpoint, base: meta }, order }, [
              ['upsert', chatList(upsert)],
            ]),
          ),
        );
        return;
      } catch (error) {
        if (!String(error).includes(needsWholeCheckpoint)) throw error;
      }
    }
    await invoke('save_sync_state', { value: checkpoint });
  } catch (error) {
    // Nothing is known about the file after a write that failed.
    checkpointStale = undefined;
    throw error;
  }
}
// Settles when the poll under way ends, so a change that must go out at once can follow it.
let pollDone: Promise<void> = Promise.resolve();
// The heartbeat a poll sends while an earlier one still syncs, so a slow relay never piles them up.
let heartbeating: Promise<unknown> | undefined;
/**
 * Polls once the poll under way, if any, has ended: that one may have read this device before
 * the change it is called for, such as the end of a reply.
 */
export async function pollRelayNow(): Promise<Presence[] | null> {
  if (relayBusy) await pollDone;
  return pollRelay(true);
}
/** `urgent` publishes what changed here without waiting for a conversation's turn. */
export async function pollRelay(urgent = false): Promise<Presence[] | null> {
  if (!relayConnected || !runtime) return null;
  // A sync longer than a poll still tells the relay this computer is here: the relay counts a
  // computer whose heartbeat is 15 seconds old as offline and refuses work for it, which made
  // the VPS host read as offline while it saved a large workspace (requested 2026-10-11). A
  // browser takes no work, so it waits for its sync as before.
  if (relayBusy) {
    if (desktop())
      heartbeating ??= relayTail(relayGeneration)
        .catch(() => null)
        .finally(() => (heartbeating = undefined));
    return null;
  }
  const generation = relayGeneration;
  relayBusy = true;
  let done = () => {};
  pollDone = new Promise<void>((resolve) => (done = resolve));
  // Whether this poll got as far as its heartbeat, which a failed sync otherwise still sends.
  let tailed = false;
  const tail = () => {
    tailed = true;
    return relayTail(generation);
  };
  try {
    if (!desktop() && Date.now() - browserSessionCheckedAt >= 60_000) {
      if (!(await resumeBrowserRelay()))
        throw new Error('Pair this device again to restore its server connection.');
    }
    const options = desktop()
      ? { deadRun: (c: Conversation, m: Message) => deadRunHere(runtime!.fleet(), c, m) }
      : undefined;
    const incremental = await syncIncremental(generation, options, urgent);
    if (incremental === null) return null;
    if (incremental) return await tail();
    // The whole-state path compares whole chats, which a light connection does not hold.
    if (lightSession) throw new Error(lightRelayGone);
    // Syncing copies, compares and saves the whole workspace, which stalls the page, so once a
    // poll leaves both sides equal, later ones only ask whether the relay moved. A reply running
    // here counts each of its events as a change, so its progress still goes out every poll,
    // while a reply waiting on a long tool call stops costing anything. Asking for the revision
    // first also keeps a publishing poll from downloading the baseline it already holds.
    const revision = runtime.revision?.();
    const settled =
      revision !== undefined && revision === settledRevision && baselineRevision !== undefined;
    let unchanged = false;
    // Whether the relay still holds exactly `baseline`, so no download is needed to merge.
    let held = false;
    if (baselineRevision !== undefined && revisionEndpoint) {
      const probe = await relayRaw('GET', 'v1/state/revision');
      noteImageStore(probe);
      if (probe.status !== 200 && probe.status !== 404)
        throw new Error(probe.body?.error ?? `Relay request failed (${probe.status}).`);
      if (
        probe.status === 200 &&
        typeof probe.body?.instanceId === 'string' &&
        typeof probe.body.revision === 'number'
      ) {
        if (probe.body.instanceId !== relayInstance) throw new Error(relayReplaced);
        held = probe.body.revision === baselineRevision;
        unchanged = settled && held && runtime.revision?.() === revision;
      } else revisionEndpoint = false;
    }
    let fetched: RelayState | undefined;
    if (!unchanged && !held) {
      fetched = await relayApi<RelayState>('GET', 'v1/state');
      if (fetched.instanceId !== relayInstance) throw new Error(relayReplaced);
      // Relays without v1/state/revision send the revision with the whole state.
      unchanged =
        settled && fetched.revision === baselineRevision && runtime.revision?.() === revision;
    }
    // The revision probe proved the relay holds the baseline, so this poll merges against the
    // copy already in memory rather than downloading and validating the same data again.
    if (held && !unchanged && baselineRevision !== undefined)
      fetched = { instanceId: relayInstance, revision: baselineRevision, workspace: baseline };
    // Verify the workspace first, then publish the viewed chat before a
    // completion checkpoint can enqueue push.
    await publishNotificationView();
    if (generation !== relayGeneration) return null;
    if (fetched && !unchanged) {
      let remote = fetched;
      // The relay's own copy of the baseline was validated when this device accepted it.
      let remoteShared: SharedWorkspace | undefined =
        remote.workspace === baseline ? baseline : undefined;
      // Read the revision and this device's data together, so a change that lands between them
      // cannot leave the poll reporting that both sides are equal without having sent it. The
      // same read covers every change marked so far: those marked while this sync runs are not
      // in it and wait for the next poll, and a sync that fails hands the covered ones back.
      const before = runtime.revision?.();
      const covered = runtime.takeUnsynced();
      let coveredPublished = false;
      try {
        // A conversation naming images the relay cannot take yet goes out as the relay last had
        // it and waits here, as on the incremental path, while everything else syncs.
        const { outgoing: start, held: waiting } = await holdImageChats(runtime.shared());
        let accepted: SharedWorkspace | undefined;
        let acceptedRevision: number | undefined;
        let acceptedManifest: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          remoteShared ??= sharedSchema.parse(remote.workspace);
          const merged = mergeShared(baseline, start, remoteShared, options);
          // An older relay or app drops app sessions, folder icons, account colors, snoozes and
          // pins. This device keeps its own and sends them with its next other change, instead of
          // writing them back after every write there.
          const unsent = {
            ...merged,
            ...(!remote.workspace.appSessions && merged.appSessions
              ? { appSessions: undefined }
              : {}),
            ...(!remote.workspace.folderIcons && merged.folderIcons
              ? { folderIcons: undefined }
              : {}),
            ...(!remote.workspace.accountColors && merged.accountColors
              ? { accountColors: undefined }
              : {}),
            ...(!remote.workspace.snoozes && merged.snoozes ? { snoozes: undefined } : {}),
            ...(!remote.workspace.pins && merged.pins ? { pins: undefined } : {}),
          };
          const mergedJson = JSON.stringify(unsent);
          if (mergedJson === JSON.stringify(remote.workspace)) {
            accepted = unsent;
            acceptedRevision = remote.revision;
            break;
          }
          const response = await relayRaw('PUT', 'v1/state', {
            revision: remote.revision,
            workspace: merged,
          });
          if (response.status === 409 && response.body?.code !== 'workspace_changed') {
            remote = response.body;
            remoteShared = undefined;
            continue;
          }
          if (response.status === 413) throw new Error(tooLarge);
          if (response.status !== 200)
            throw new Error(response.body?.error ?? 'Workspace sync failed.');
          // The relay stores what it accepted, so its answer is usually this poll's own data,
          // already validated. Validate it again only when an older relay left something out.
          const echoed = JSON.stringify(response.body.workspace) === mergedJson;
          accepted = echoed ? unsent : sharedSchema.parse(response.body.workspace);
          acceptedRevision = response.body.revision;
          acceptedManifest = response.body;
          break;
        }
        if (!accepted) throw new Error('Workspace is changing quickly. Sync will retry shortly.');
        coveredPublished = true;
        // Their images may reach the relay later, so they are tried again on the next poll.
        syncNotice = heldNotice(waiting);
        if (waiting.length)
          runtime.restoreUnsynced({ chats: new Set(waiting.map((c) => c.id)), meta: false });
        if (generation !== relayGeneration) return null;
        // Nothing arrives when the relay holds exactly what this poll sent.
        const sent = sameShared(accepted, start);
        if (!sent) {
          const current = runtime.shared();
          await runtime.apply(mergeShared(start, current, accepted, options));
          if (generation !== relayGeneration) return null;
        }
        // As on the incremental path, a change that arrived other than replies moving on goes
        // into the checkpoint now.
        const sentChats = new Map(start.conversations.map((c) => [c.id, c]));
        const structural =
          !sent &&
          (!sameShared({ ...accepted, conversations: [] }, { ...start, conversations: [] }) ||
            accepted.conversations.some((c) => !onlyRepliesMoved(sentChats.get(c.id), c)));
        // A relay with per-conversation revisions reports them here too, so the next poll can
        // publish and take in only what moved. An older one reports none and keeps this path.
        const reported = z
          .object({
            metaRevision: z.number().int().nonnegative(),
            chatRevisions: z.record(z.string(), z.number().int().nonnegative()),
          })
          .safeParse(acceptedManifest ?? remote);
        // Local data is saved before the merge checkpoint advances, so failed writes remain
        // recoverable, and the checkpoint is rewritten at intervals rather than every poll.
        await saveCheckpoint(
          generation,
          accepted,
          acceptedRevision!,
          reported.success
            ? { chats: reported.data.chatRevisions, metaRevision: reported.data.metaRevision }
            : undefined,
          structural,
        );
        if (generation !== relayGeneration) return null;
        baseline = accepted;
        noteBaseline();
        baselineRevision = acceptedRevision;
        if (reported.success) {
          baselineChats = reported.data.chatRevisions;
          baselineMetaRevision = reported.data.metaRevision;
        }
        baselineManifest = reported.success;
        // Both sides are equal when the relay holds what was sent and nothing changed since, and
        // nothing waits here for its images.
        settledRevision =
          sent && !waiting.length && runtime.revision?.() === before ? before : undefined;
      } finally {
        if (!coveredPublished) runtime.restoreUnsynced(covered);
        runtime.settleUnsynced?.();
      }
    }
    return await tail();
  } catch (error) {
    // A computer whose sync failed is still here and still takes its work, unless the relay it
    // paired with was replaced. A browser's failure can be its session ending, which a request
    // made now would only confuse.
    const replaced = error instanceof Error && error.message === relayReplaced;
    if (desktop() && !tailed && !replaced && generation === relayGeneration)
      await tail().catch(() => null);
    throw error;
  } finally {
    relayBusy = false;
    done();
  }
}
/** Presence, live account readings from other computers, and any work this host must claim. */
async function relayTail(generation: number): Promise<Presence[] | null> {
  if (!runtime) return null;
  {
    const connections = Object.entries(runtime.statuses()).map(([connectionId, s]) => ({
      connectionId,
      installed: s.installed,
      auth: s.auth,
      detail: s.detail,
      version: s.version,
    }));
    const presence = await relayApi<Presence[]>('POST', 'v1/heartbeat', {
      environmentId: runtime.installation.id,
      ...(desktop()
        ? { features: runtime.installation.server ? ['signIn', 'server'] : ['signIn'] }
        : {}),
      connections,
      running: desktop() ? [...runtime.localRuns(), ...workerRuns.keys(), ...jobsToResume] : [],
      accountUpdates: accountHeartbeat(),
    });
    if (generation !== relayGeneration) return null;
    for (const peer of presence) {
      if (!peer.online || peer.environmentId === runtime.installation.id) continue;
      for (const update of peer.accountUpdates ?? [])
        receiveAccountUpdate(update, peer.environmentId);
    }
    const jobs = desktop() ? await relayApi<RelayJob[]>('GET', 'v1/jobs') : [];
    for (const job of jobs)
      if (!workerRuns.has(job.id)) {
        workerRuns.set(job.id, job);
        void executeJob(job);
      }
    for (const runId of jobsToResume) void resumeJob(runId, generation);
    return presence;
  }
}
export async function resolveRelaySettings(): Promise<string> {
  if (!runtime || !relayConnected) throw new Error('Connect to the relay first.');
  const generation = relayGeneration;
  const currentSession = () => {
    if (generation !== relayGeneration || !relayConnected)
      throw new Error('The private workspace connection changed. Try again after pairing.');
  };
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  currentSession();
  relayBusy = true;
  try {
    let backup: string;
    if (desktop())
      backup = await invoke<string>('export_workspace', { workspace: runtime.workspace() });
    else {
      if (!browserScope) throw new Error('Pair this device with your private workspace first.');
      const key = `${browserScopeKey(browserScope)}:backup`;
      const store = await workspaceStore();
      await store.put(
        [[key, JSON.stringify(runtime.workspace())]],
        () => generation === relayGeneration && relayConnected,
      );
      backup = 'this browser’s local backup';
    }
    currentSession();
    const remote = await relayApi<{ workspace: SharedWorkspace }>(
      'GET',
      lightSession ? 'v1/state?light=1' : 'v1/state',
    );
    currentSession();
    await runtime.apply({
      ...sharedWorkspace(runtime.workspace()),
      fleet: sharedSchema.parse(remote.workspace).fleet,
    });
    // The resolved workspace still has to reach the relay.
    settledRevision = undefined;
    return backup;
  } finally {
    relayBusy = false;
  }
}
async function localCall(
  method: RelayJob['method'],
  args: Record<string, unknown>,
  onEvent?: (event: RunEvent) => void,
  // Another device asked for this work through the relay, whose request this window publishes.
  job = false,
): Promise<any> {
  if (!desktop())
    throw new Error('Choose a connected computer to run its agents from this device.');
  if (method === 'run') {
    const channel = new Channel<RunEvent>();
    channel.onmessage = onEvent ?? (() => {});
    const { runId } = args.request as RunRequest;
    ownRuns.add(runId);
    try {
      return await invoke('run_agent', { ...args, ...(job ? { job } : {}), onEvent: channel });
    } finally {
      ownRuns.delete(runId);
    }
  }
  if (method === 'undoFiles') {
    const owner = runtime;
    const result = await invoke<{ files: string[]; undone: boolean }>('undo_files', args);
    if (result.undone && owner && runtime === owner) {
      const shared = sharedWorkspace(owner.workspace());
      const conversation = shared.conversations.find((c) => c.id === args.conversationId);
      const message = conversation?.messages.find((m) => m.runId === args.runId);
      if (conversation && message && !message.filesUndone) {
        message.filesUndone = true;
        conversation.historyRevision = (conversation.historyRevision ?? 0) + 1;
        conversation.updatedAt = new Date().toISOString();
        await owner.apply(shared);
      }
    }
    return result;
  }
  if (method === 'release')
    return invoke('release_conversation', { conversationId: args.conversationId });
  if (method === 'signIn') return hostSignIn(args, onEvent);
  if (method === 'signInCode') {
    // Only a sign-in still waiting here, for the connection the code was sent for.
    const waiting = z.array(signInViewSchema).parse(await invoke('sign_ins'));
    if (!waiting.some((view) => view.id === args.id && view.connectionId === args.connectionId))
      throw new Error('This sign-in has ended. Open sign-in to start again.');
    return invoke('sign_in_code', { id: args.id, code: args.code });
  }
  if (method === 'toolOutputModelViews')
    return hostModelViews({
      runId: String(args.runId),
      toolId: String(args.toolId),
      index: Number(args.index),
    });
  const commands = {
    models: 'list_models',
    usage: 'read_usage',
    account: 'manage_account',
    title: 'generate_title',
    folderIcon: 'generate_folder_icon',
    folders: 'list_folders',
    context: 'read_context',
    mentions: 'search_mentions',
    mcp: 'manage_mcp',
    plugins: 'manage_plugins',
    nativeInstructions: 'read_native_instructions',
    toolOutput: 'read_tool_output',
    toolOutputImage: 'read_tool_output_image',
    toolOutputModel: 'read_tool_output_model',
    toolOutputTable: 'read_tool_output_table',
    toolOutputDocument: 'read_tool_output_document',
    toolOutputFile: 'read_tool_output_file',
    answer: 'answer_question',
    elicitation: 'manage_elicitation',
    steer: 'steer_run',
    screens: 'manage_screen',
  };
  return invoke(commands[method], args);
}
async function routed<T>(
  method: RelayJob['method'],
  args: Record<string, unknown>,
  connectionId?: string,
  onEvent?: (event: RunEvent) => void,
  id: string = crypto.randomUUID(),
): Promise<T> {
  const target = remoteTarget(
    connectionId,
    method === 'folders' || method === 'screens' ? (args.environmentId as string) : undefined,
  );
  if (!target) return localCall(method, args, onEvent);
  if (!relayConnected || !runtime)
    throw new Error('Connect this environment to the relay to use a remote account.');
  const generation = relayGeneration;
  const currentSession = () => {
    if (generation !== relayGeneration || !relayConnected)
      throw new Error('The private workspace connection changed. This request was not replayed.');
  };
  // Optional notice reads must not prevent disconnecting. Session guards discard
  // their late results; credit redemption and other work still block a switch.
  remoteRuns.set(id, !workspaceNoticeRead(method, args));
  try {
    // Publish the conversation and its pinned connection before the target claims its work.
    if (
      method === 'run' ||
      method === 'folders' ||
      method === 'context' ||
      method === 'mentions' ||
      method === 'mcp' ||
      method === 'plugins' ||
      method === 'undoFiles' ||
      method === 'nativeInstructions' ||
      method === 'signIn'
    ) {
      while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
      await pollRelay();
    }
    currentSession();
    await relayApi('POST', 'v1/jobs', {
      id,
      source: runtime.installation.id,
      target,
      method,
      args,
    });
    let previous: string[] = [];
    // A request lasts as long as its computer keeps reporting it, however long that is: the relay
    // ends one whose computer stops.
    for (;;) {
      currentSession();
      const job = await relayApi<RelayJob>('GET', `v1/jobs/${id}`);
      currentSession();
      job.events.forEach((event, index) => {
        const json = JSON.stringify(event);
        if (previous[index] !== json) onEvent?.(event as RunEvent);
        previous[index] = json;
      });
      if (job.status === 'error') throw new Error(job.error ?? 'Remote request failed.');
      if (job.status === 'cancelled') return 'cancelled' as T;
      if (job.status === 'complete') return job.result as T;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    remoteRuns.delete(id);
  }
}
/** Events someone waits on, which a job sends at once rather than with the next batch. */
function awaitsAnswer(event: RunEvent) {
  return (
    event.kind === 'question' ||
    event.kind === 'elicitation' ||
    (event.kind === 'tool' && !!event.tool && !event.tool.parentId && asksTheUser(event.tool.name))
  );
}
/**
 * Does the work `job` asks of this computer and publishes its progress and end to the relay.
 * `resumed`: the reply runs already, and this window, reloaded since it began, follows it again.
 */
async function executeJob(job: RelayJob, resumed = false) {
  const generation = relayGeneration;
  let following = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let publishing = Promise.resolve();
  let waiting: Promise<void> | undefined;
  let status: RelayJob['status'] = 'running';
  let result: unknown, error: string | undefined;
  const events: RunEvent[] = [];
  const request = job.method === 'run' ? (job.args.request as RunRequest) : undefined;
  // The sign-in this job follows, which the device that opened it may cancel.
  let signInId: string | undefined;
  let checkpoint = Promise.resolve();
  const persistEvent = (event?: RunEvent, finalStatus?: 'complete' | 'cancelled' | 'error') => {
    if (event?.kind === 'skillschanged') {
      invalidateSources();
      return;
    }
    if (!request || !runtime) return;
    checkpoint = checkpoint
      .catch(() => {})
      .then(() => runtime!.checkpointRun(request, event, finalStatus, error));
  };
  // Sends the newest state after the update in flight. Calls made while one waits share it,
  // so a burst of events costs one request.
  const publish = () => {
    if (waiting) return waiting;
    waiting = publishing = publishing
      .catch(() => {})
      .then(async () => {
        waiting = undefined;
        if (generation !== relayGeneration || !relayConnected) return;
        const response = await relayApi<RelayJob>('PUT', `v1/jobs/${job.id}`, {
          status,
          events,
          result,
          error,
        });
        if (response.cancel && status === 'running') {
          if (job.method === 'run')
            await invoke('cancel_run', { runId: (job.args.request as RunRequest)?.runId });
          if (job.method === 'title')
            await invoke('cancel_title', { conversationId: job.args.conversationId });
          if (job.method === 'signIn' && signInId)
            await invoke('cancel_sign_in', { id: signInId });
        }
      });
    return publishing;
  };
  // Events go out shortly after they arrive, and those someone waits on at once. A hidden
  // window runs the repeating timer below about once a minute, which then only notices a
  // cancellation, while a timer an event starts keeps its time.
  const publishSoon = (now: boolean) => {
    if (now) {
      clearTimeout(soon);
      soon = undefined;
      void publish().catch(() => {});
    } else
      soon ??= setTimeout(() => {
        soon = undefined;
        void publish().catch(() => {});
      }, 700);
  };
  try {
    const connectionId = job.args.connectionId;
    const fleet = runtime?.fleet();
    const owned = (environmentId: string) =>
      !!fleet && executionHost(fleet, environmentId) === runtime?.installation.id;
    let connection = fleet?.connections.find(
      (c) => c.id === connectionId && owned(c.environmentId),
    );
    // Folders and screens belong to an environment of this computer rather than an account.
    const byEnvironment = job.method === 'folders' || job.method === 'screens';
    // An account another device has just added here reaches this computer with a sync that may
    // come after the request.
    for (let wait = 0; !byEnvironment && !connection && typeof connectionId === 'string'; wait++) {
      if (wait === 20 || generation !== relayGeneration) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const current = runtime?.fleet();
      connection = current?.connections.find(
        (c) =>
          c.id === connectionId &&
          executionHost(current, c.environmentId) === runtime?.installation.id,
      );
    }
    const ownedEnvironment =
      byEnvironment &&
      fleet?.environments.find((e) => e.id === job.args.environmentId && owned(e.id));
    if (byEnvironment ? !ownedEnvironment : !connection || typeof connectionId !== 'string')
      throw new Error('Remote requests must select a connection owned by this environment.');
    if (job.method === 'run' && (job.args.request as RunRequest)?.runId !== job.id)
      throw new Error('Remote run identity mismatch.');
    timer = setInterval(() => {
      void publish().catch(() => {});
    }, 700);
    const onEvent = (event: RunEvent) => {
      if (job.method === 'signIn') {
        // A sign-in's latest state is all its device needs, and it waits for each at once.
        const view = signInViewSchema.safeParse(event);
        if (!view.success) return;
        signInId ??= view.data.id;
        events.splice(0, events.length, event);
        publishSoon(true);
        return;
      }
      retainRunEvent(events, event);
      // The execution host retains results even if the initiating computer disconnects.
      persistEvent(event);
      publishSoon(awaitsAnswer(event));
    };
    if (resumed) following = true;
    result =
      resumed && job.method === 'run'
        ? await followRun(job.id, onEvent)
        : await localCall(job.method, job.args, onEvent, true);
    status = result === 'cancelled' ? 'cancelled' : 'complete';
  } catch (e) {
    status = 'error';
    error = String(e);
    // A reply that runs here ends here even when its request cannot be taken up again.
    if (resumed && !following) runtime?.followReply?.(job.id);
  } finally {
    clearInterval(timer);
    clearTimeout(soon);
    if (job.method === 'plugins') invalidatePluginMutation(job.args.action as PluginAction);
    persistEvent(
      undefined,
      status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'complete',
    );
    await checkpoint.catch(() => {});
    await publish().catch(async (e) => {
      // The relay may refuse a finished request's result (relays before 2026-10-10 refuse one
      // larger than 24 MB). Say so, rather than leave the request to expire as though this
      // computer had gone. A reply ends with its saved conversation instead.
      if (job.method === 'run' || status === 'error') return;
      status = 'error';
      result = undefined;
      error =
        e instanceof RelayResponseError && e.status === 413
          ? 'The result is larger than the relay accepts.'
          : `The result could not be sent through the relay: ${String(e instanceof Error ? e.message : e)}`;
      await publish().catch(() => {});
    });
    workerRuns.delete(job.id);
  }
}
export async function readUsage(
  provider: ProviderId,
  model: string,
  force = false,
  connectionId?: string,
): Promise<UsageSnapshot> {
  return routed('usage', { provider, model, force, connectionId }, connectionId);
}

export function manageAccount(connectionId: string, input: AccountAction): Promise<unknown> {
  return routed('account', { connectionId, input: accountActionSchema.parse(input) }, connectionId);
}
export async function readContext(
  settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'> & {
    conversationId?: string;
    forked?: boolean;
  },
  location?: ChatLocation,
): Promise<ContextSnapshot> {
  return routed(
    'context',
    {
      provider: settings.provider,
      model: settings.model,
      connectionId: settings.connectionId,
      location: location ?? null,
      conversationId: settings.conversationId ?? null,
      forked: settings.forked ?? false,
    },
    settings.connectionId,
  );
}
function makeContextCache() {
  return createContextCache(readContext, () =>
    JSON.stringify(runtime?.fleet().connections.map((c) => [c.id, sharedContextChoice(c)]) ?? []),
  );
}
export let contextCache = makeContextCache();
export async function searchMentions(
  settings: Pick<ChatSettings, 'provider' | 'connectionId'> & { conversationId?: string },
  location: ChatLocation | undefined,
  kind: 'file' | 'app',
  query: string,
): Promise<MentionResult> {
  const args = mentionRequestSchema.parse({
    provider: settings.provider,
    connectionId: settings.connectionId,
    conversationId: settings.conversationId ?? null,
    location: location ?? null,
    kind,
    query,
  });
  return mentionResultSchema.parse(await routed('mentions', args, settings.connectionId));
}
function invalidateSources() {
  contextCache.clear();
  window.dispatchEvent(new Event('studio-skills-changed'));
}
function invalidatePluginMutation(action: PluginAction) {
  if (!['list', 'details', 'eval', 'cancel'].includes(action.kind)) invalidateSources();
}
export async function managePlugins(
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
  conversationId: string | undefined,
  location: ChatLocation | undefined,
  action: PluginAction,
): Promise<PluginResult> {
  if (!settings.connectionId) throw new Error('Select an account connection first.');
  const parsed = pluginActionSchema.parse(action);
  try {
    return await routed(
      'plugins',
      {
        provider: settings.provider,
        connectionId: settings.connectionId,
        conversationId: conversationId ?? null,
        location: location ?? null,
        action: parsed,
      },
      settings.connectionId,
    );
  } finally {
    invalidatePluginMutation(parsed);
  }
}
export async function manageMcp(
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
  conversationId: string | undefined,
  location: ChatLocation | undefined,
  action: McpAction,
): Promise<McpResult> {
  if (!settings.connectionId) throw new Error('Select an account connection first.');
  return routed(
    'mcp',
    {
      provider: settings.provider,
      connectionId: settings.connectionId,
      conversationId: conversationId ?? null,
      location: location ?? null,
      action: mcpActionSchema.parse(action),
    },
    settings.connectionId,
  );
}
export async function readNativeInstructions(
  conversationId: string,
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
): Promise<NativeInstructions> {
  return routed(
    'nativeInstructions',
    {
      conversationId,
      provider: settings.provider,
      connectionId: settings.connectionId,
    },
    settings.connectionId,
  );
}
const importOnDesktop =
  'Import chats in the desktop app on the computer that has them. The Viewer reads no CLI sessions.';
/**
 * The CLI session stores of this computer and its WSL distributions: each separate account
 * profile and each environment's default CLI directory, which the terminal and the desktop apps
 * share. Only the desktop app reads them.
 */
export async function listImportSources(): Promise<ImportSource[]> {
  if (!desktop()) throw new Error(importOnDesktop);
  return z.array(importSourceSchema).parse(await invoke('list_import_sources'));
}
/** One store's chats, newest first, each with an opaque key to import it by. */
export async function listImportableChats(source: string): Promise<SourceChats> {
  if (!desktop()) throw new Error(importOnDesktop);
  return sourceChatsSchema.parse(await invoke('list_importable_chats', { source }));
}
/**
 * Reads one listed chat whole for a new conversation; its images and tool results stay on this
 * computer, and its first reply forks the chat's own session.
 */
export async function importChat(
  key: string,
  conversationId: string,
  connectionId?: string,
): Promise<ImportedChat> {
  if (!desktop()) throw new Error(importOnDesktop);
  return importedChatSchema.parse(
    await invoke('import_chat', { key, conversationId, connectionId: connectionId ?? null }),
  );
}
/**
 * Runs `task` when fewer than `size` others started here are still running, handing each
 * finished slot straight to the task that waited longest.
 */
function createLimiter(size: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < size) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
/**
 * Reads of a kept image, model or full output from another computer, which carry up to tens
 * of megabytes each through the relay's bounded request storage: a window asks for two at
 * a time.
 */
const largeReads = createLimiter(2);
function largeRead<T>(connectionId: string | undefined, read: () => Promise<T>): Promise<T> {
  return remoteTarget(connectionId) ? largeReads(read) : read();
}
/**
 * A finished tool call's result, read from the computer that ran it: through native
 * commands here, or the owning host through the relay. It is never synced or exported.
 * Each stream comes whole. Computers before 2026-10-10 sent the beginning and end of a long one,
 * up to 8 MB of it when `full` is set.
 */
export async function readToolOutput(
  runId: string,
  toolId: string,
  connectionId?: string,
  full = false,
): Promise<ToolOutput> {
  const read = () =>
    routed('toolOutput', { runId, toolId, connectionId, ...(full ? { full } : {}) }, connectionId);
  return toolOutputSchema.parse(await largeRead(connectionId, read));
}
/**
 * One 3D model of a finished tool call's result, whole: as raw bytes from this computer's own
 * store, or as base64 through the relay from the computer that ran it, whatever its size.
 * `format` is the one the reply recorded, which that computer recognized in the file.
 */
export async function readToolOutputModel(
  runId: string,
  toolId: string,
  index: number,
  format: ModelFormat,
  connectionId?: string,
): Promise<{ format: ModelFormat; bytes: ArrayBuffer }> {
  if (desktop() && !remoteTarget(connectionId)) {
    const bytes = await invoke<unknown>('read_tool_output_model_file', {
      runId,
      toolId,
      index,
    });
    return { format, bytes: answerBytes(bytes) };
  }
  const model = toolOutputModelSchema.parse(
    await largeRead(connectionId, () =>
      routed('toolOutputModel', { runId, toolId, index, connectionId }, connectionId),
    ),
  );
  return { format: model.format, bytes: await modelBytes(model) };
}
/**
 * Whether a model comes from another computer: read whole through the relay however large it
 * is, and shown through views that computer renders only when that read fails on the way.
 */
export function modelFromAnotherComputer(connectionId: string | undefined): boolean {
  try {
    return !desktop() || !!remoteTarget(connectionId);
  } catch {
    // A connection that no longer exists fails either read with its reason.
    return !desktop();
  }
}
/**
 * Views of a model, a turn apart, rendered by the window of the computer that keeps it,
 * which sends them instead of a model that could not come whole through the relay.
 */
export async function readToolOutputModelViews(
  runId: string,
  toolId: string,
  index: number,
  connectionId?: string,
): Promise<ModelViews> {
  return modelViewsSchema.parse(
    await largeRead(connectionId, () =>
      routed('toolOutputModelViews', { runId, toolId, index, connectionId }, connectionId),
    ),
  );
}
/** One model's views at a time: each rendering loads the whole model into this window. */
const viewRenders = createLimiter(1);
const viewsInProgress = new Map<string, Promise<ModelViews>>();
/**
 * Views of a model this computer keeps, for another device: those kept beside it, or drawn
 * here from the model, which never leaves this computer, and kept for the next request until
 * the call's result goes. Requests for the same model share one rendering.
 */
function hostModelViews(request: { runId: string; toolId: string; index: number }) {
  const key = `${request.runId}\n${request.toolId}\n${request.index}`;
  let views = viewsInProgress.get(key);
  if (!views) {
    views = keptOrRenderedViews(request).finally(() => viewsInProgress.delete(key));
    viewsInProgress.set(key, views);
  }
  return views;
}
async function keptOrRenderedViews(request: {
  runId: string;
  toolId: string;
  index: number;
}): Promise<ModelViews> {
  const kept = keptModelViewsSchema.parse(await invoke('read_tool_output_model_views', request));
  if (kept.renderer === modelViewsRenderer && kept.views.length === modelViewCount)
    return { views: kept.views };
  return viewRenders(async () => {
    const bytes = answerBytes(await invoke<unknown>('read_tool_output_model_file', request));
    // Square, so a model fills the inline stage and keeps its height in the wider expanded
    // one, and sharp there on a high-density display at tens of kilobytes a view.
    const views = await renderModelViews(bytes, kept.format, {
      count: modelViewCount,
      width: 1600,
      height: 1600,
    });
    // Views that cannot be kept are still sent; the next request draws them again.
    await invoke('store_tool_output_model_views', {
      ...request,
      renderer: modelViewsRenderer,
      views: views.map((view) => view.data),
    }).catch(() => {});
    return { views };
  });
}
/**
 * Rows of a table a finished tool call kept, `count` of them from `start` in sheet `sheet`,
 * parsed by the computer that keeps it, which keeps it parsed for the next page.
 */
export async function readToolOutputTable(
  source: { runId: string; toolId: string; index: number; connectionId?: string },
  sheet: number,
  start: number,
  count: number,
): Promise<TablePage> {
  const { runId, toolId, index, connectionId } = source;
  return tablePageSchema.parse(
    await largeRead(connectionId, () =>
      routed(
        'toolOutputTable',
        { runId, toolId, index, sheet, start, count, connectionId },
        connectionId,
      ),
    ),
  );
}
/** A document a finished tool call kept: whole, or its first `head` bytes for a card. */
export async function readToolOutputDocument(
  source: { runId: string; toolId: string; index: number; connectionId?: string },
  head?: number,
): Promise<DocumentText> {
  const { runId, toolId, index, connectionId } = source;
  return documentTextSchema.parse(
    await largeRead(connectionId, () =>
      routed(
        'toolOutputDocument',
        { runId, toolId, index, ...(head ? { head } : {}), connectionId },
        connectionId,
      ),
    ),
  );
}
/**
 * Where a window plays a video or a sound a finished tool call kept: this computer's window streams
 * it from its own store as it plays, and another device reads it whole through the relay, whatever
 * its size, and plays it from memory until `release`.
 */
export async function toolOutputMedia(source: {
  runId: string;
  toolId: string;
  index: number;
  connectionId?: string;
}): Promise<{ url: string; release(): void }> {
  const { runId, toolId, index, connectionId } = source;
  if (desktop() && !remoteTarget(connectionId))
    return { url: convertFileSrc(`${runId}/${index}/${toolId}`, 'studio-file'), release() {} };
  const file = toolOutputFileSchema.parse(
    await largeRead(connectionId, () =>
      routed('toolOutputFile', { runId, toolId, index, connectionId }, connectionId),
    ),
  );
  // A QuickTime movie plays as the MP4 it is built like.
  const type = file.mediaType === 'video/quicktime' ? 'video/mp4' : file.mediaType;
  const url = URL.createObjectURL(new Blob([await base64Bytes(file.data)], { type }));
  return { url, release: () => URL.revokeObjectURL(url) };
}
/** One image of a finished tool call's result, read like `readToolOutput`. */
export async function readToolOutputImage(
  runId: string,
  toolId: string,
  index: number,
  connectionId?: string,
): Promise<ToolOutputImage> {
  return toolOutputImageSchema.parse(
    await largeRead(connectionId, () =>
      routed('toolOutputImage', { runId, toolId, index, connectionId }, connectionId),
    ),
  );
}
/** Hashes the relay is known to hold, so each image is checked and uploaded once a session. */
let relayImages = { generation: -1, known: new Set<string>() };
function knownOnRelay() {
  if (relayImages.generation !== relayGeneration)
    relayImages = { generation: relayGeneration, known: new Set() };
  return relayImages.known;
}
/**
 * Makes sure the relay holds these images before a conversation or a reply names them: the
 * desktop uploads those it holds, and a browser uploads its own when it sends them. Returns
 * the hashes the relay still lacks.
 */
async function publishImages(hashes: string[]): Promise<Set<string>> {
  const known = knownOnRelay();
  const wanted = [...new Set(hashes)].filter((hash) => !known.has(hash));
  if (!wanted.length) return new Set();
  let lacking: string[] = [];
  if (desktop()) lacking = await invoke<string[]>('upload_chat_images', { hashes: wanted });
  else
    for (let at = 0; at < wanted.length; at += 1000)
      lacking.push(
        ...(
          await relayApi<{ missing: string[] }>('POST', 'v1/images/missing', {
            hashes: wanted.slice(at, at + 1000),
          })
        ).missing,
      );
  for (const hash of wanted) if (!lacking.includes(hash)) known.add(hash);
  return new Set(lacking);
}
/**
 * The conversations of `send` the relay can take now. One naming an image the relay lacks
 * and nobody here holds, or any image while the relay predates the image store, stays
 * unpublished, and the relay keeps its last copy.
 */
async function publishable(send: Conversation[]) {
  const named = send.map((conversation) => ({ conversation, hashes: imageHashes(conversation) }));
  if (!named.some(({ hashes }) => hashes.length)) return { send, held: [] as Conversation[] };
  const lacking = relayStoresImages
    ? await publishImages(named.flatMap(({ hashes }) => hashes))
    : undefined;
  const held = named.filter(
    ({ hashes }) => hashes.length && (!lacking || hashes.some((hash) => lacking.has(hash))),
  );
  return {
    send: named.filter((entry) => !held.includes(entry)).map(({ conversation }) => conversation),
    held: held.map(({ conversation }) => conversation),
  };
}
/**
 * For a whole-state sync: this device's workspace with each conversation the relay cannot take
 * yet as the baseline has it, or left out when the baseline lacks it. The sync then neither
 * sends the conversation nor reads the relay's older copy, or its absence, as a change to it.
 */
async function holdImageChats(start: SharedWorkspace) {
  const { held } = await publishable(start.conversations);
  if (!held.length) return { outgoing: start, held };
  const ids = new Set(held.map((c) => c.id));
  const synced = new Map(baseline.conversations.map((c) => [c.id, c]));
  const conversations = start.conversations.flatMap((c) => {
    if (!ids.has(c.id)) return [c];
    const before = synced.get(c.id);
    return before ? [before] : [];
  });
  return { outgoing: { ...start, conversations }, held };
}
const chatNames = (list: Conversation[]) => list.map((c) => `“${c.title}”`).join(', ');
/** What the sync status says about conversations that wait for their images. */
function heldNotice(held: Conversation[]) {
  if (!held.length) return '';
  return relayStoresImages
    ? `${chatNames(held)} ${held.length === 1 ? 'names images' : 'name images'} the relay does not have yet. ${held.length === 1 ? 'It syncs' : 'They sync'} once the computer that attached them is connected.`
    : `${chatNames(held)} ${held.length === 1 ? 'stays' : 'stay'} on this device. ${oldRelayImages}`;
}
/**
 * Keeps the images of a message in the image store before it names them: this computer's store
 * on the desktop, the relay's in a browser, which keeps none of its own. The message keeps
 * only the references returned.
 */
export async function storeChatImages(images: DraftImage[]): Promise<StoredImage[]> {
  if (desktop()) {
    for (const image of images) {
      const kept = await invoke<{ hash: string }>(
        'store_chat_image',
        new Uint8Array(await image.blob.arrayBuffer()),
      );
      if (kept.hash !== image.hash) throw new Error(`${image.name} changed while it was kept.`);
    }
    return images.map(storedImage);
  }
  if (!relayConnected) throw new Error('Connect to your workspace to send images.');
  const known = knownOnRelay();
  const lacking = await publishImages(images.map((image) => image.hash));
  for (const image of images) {
    if (lacking.has(image.hash)) {
      const answer = await relayImage('PUT', image.hash, image.blob);
      if (answer.status >= 300)
        throw new Error(answer.error ?? `The relay did not keep ${image.name} (${answer.status}).`);
      lacking.delete(image.hash);
      known.add(image.hash);
    }
    // This window shows the image it just sent without reading it back.
    void chatImages.get(image.hash, async () => image.blob);
  }
  return images.map(storedImage);
}
/** Where a window reads a stored image directly: the desktop's image protocol. */
export function chatImageUrl(hash: string): string | undefined {
  return desktop() ? convertFileSrc(hash, 'studio-image') : undefined;
}
// Images a browser read, newest last, bounded by count and bytes.
const chatImages = createFetchCache<Blob>((blob) => blob.size, {
  entries: 64,
  bytes: 160_000_000,
});
/**
 * A stored image's bytes: on the desktop from this computer's image store, or the relay when it
 * lacks them; in a browser from the relay's image store.
 */
export function readChatImage(hash: string): Promise<Blob> {
  if (desktop())
    return invoke<unknown>('read_chat_image', { hash }).then(
      (bytes) => new Blob([answerBytes(bytes)]),
    );
  return chatImages.get(hash, async () => {
    const answer = await relayImage('GET', hash);
    if (answer.status !== 200 || !answer.blob)
      throw new Error(answer.error ?? 'This image is not on the relay.');
    return answer.blob;
  });
}
/** One image through the relay's image store, as raw bytes rather than JSON. */
async function relayImage(
  method: 'GET' | 'PUT',
  hash: string,
  body?: Blob,
): Promise<{ status: number; blob?: Blob; error?: string }> {
  if (!runtime || !browserWorkspaceId)
    throw new Error('Pair this device with your private workspace first.');
  const generation = relayGeneration;
  const response = await fetch(`/v1/images/${hash}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'X-Environment-Id': runtime.installation.id,
      'X-Workspace-Id': browserWorkspaceId,
      'X-Studio-Images': '1',
      ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body,
  });
  if (generation !== relayGeneration)
    throw new Error('The private workspace connection changed. Try again after pairing.');
  if (response.ok && method === 'GET')
    return { status: response.status, blob: await response.blob() };
  const answer = response.headers.get('content-type')?.includes('application/json')
    ? await response.json().catch(() => ({}))
    : {};
  return { status: response.status, error: answer.error };
}
/**
 * A workspace copy for an export from a browser, with its images' bytes inline so it stands
 * on its own. It changes the copy it is given; images the relay cannot provide keep their
 * references, and are counted.
 */
export async function portableWorkspace(workspace: { conversations: Conversation[] }) {
  let missing = 0;
  for (const conversation of workspace.conversations)
    for (const images of imageLists(conversation) as ChatImage[][])
      for (const [index, image] of images.entries()) {
        if (isInline(image)) continue;
        try {
          const data = await blobBase64(await readChatImage(image.hash));
          const { id, name, mediaType } = image;
          images[index] = { id, name, mediaType, data };
        } catch {
          missing++;
        }
      }
  return missing;
}
/**
 * Turns the images a Viewer copy saved before the image store holds inline into references once
 * the relay holds their bytes, uploading those it lacks from the copy. They are the references
 * the relay made of the same images, so the checkpoint still matches the relay's copy. Images
 * that could not be uploaded stay inline. Changes the copies given; true when any image did.
 */
async function referenceLegacyImages(
  copies: { conversations: Parameters<typeof imageLists>[0][] }[],
  current: () => boolean,
): Promise<boolean> {
  const places: { images: ChatImage[]; index: number; image: InlineImage }[] = [];
  for (const copy of copies)
    for (const conversation of copy.conversations)
      for (const images of imageLists(conversation) as ChatImage[][])
        images.forEach((image, index) => {
          if (isInline(image)) places.push({ images, index, image });
        });
  if (!places.length) return false;
  // Each image is hashed once, however many copies and messages hold it.
  const hashes = new Map<string, string>();
  const sources = new Map<string, InlineImage>();
  for (const { image } of places) {
    if (hashes.has(image.data)) continue;
    const hash = await imageHash(inlineBytes(image));
    hashes.set(image.data, hash);
    sources.set(hash, image);
    if (!current()) return false;
  }
  const held = new Set<string>();
  const all = [...sources.keys()];
  for (let at = 0; at < all.length; at += 1000) {
    const batch = all.slice(at, at + 1000);
    const answer = await relayApi<{ missing: string[] }>('POST', 'v1/images/missing', {
      hashes: batch,
    });
    const lacking = new Set(answer.missing);
    for (const hash of batch) {
      if (lacking.has(hash)) {
        const image = sources.get(hash)!;
        const bytes = new Blob([inlineBytes(image)], { type: image.mediaType });
        if ((await relayImage('PUT', hash, bytes)).status >= 300) continue;
      }
      held.add(hash);
    }
    if (!current()) return false;
  }
  const known = knownOnRelay();
  let changed = false;
  for (const { images, index, image } of places) {
    const hash = hashes.get(image.data)!;
    if (!held.has(hash)) continue;
    known.add(hash);
    images[index] = storedImage({ ...image, hash, bytes: imageByteLength(image) });
    changed = true;
  }
  return changed;
}
export type FolderListing = {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  truncated: boolean;
  // Older hosts omit quick-access places; the browser then offers only Home.
  places?: FolderPlace[];
};
export async function listFolders(environmentId: string, path = ''): Promise<FolderListing> {
  return routed('folders', { environmentId, path });
}
export async function generateTitle(
  conversationId: string,
  provider: ProviderId,
  firstMessage: string,
  connectionId?: string,
): Promise<{ title: string; provider: ProviderId; model: string }> {
  return routed(
    'title',
    {
      conversationId,
      provider,
      firstMessage: Array.from(firstMessage).slice(0, 2000).join(''),
      connectionId,
    },
    connectionId,
  );
}
export async function cancelTitle(conversationId: string) {
  if (desktop()) await invoke('cancel_title', { conversationId });
}
/** Has a small model choose the icon of the folder a new conversation started in. */
export async function generateFolderIcon(
  conversationId: string,
  provider: ProviderId,
  path: string,
  firstMessage: string,
  connectionId?: string,
): Promise<{ icon: string; provider: ProviderId; model: string }> {
  return routed(
    'folderIcon',
    {
      conversationId,
      provider,
      folder: folderIconContext(path),
      firstMessage: Array.from(firstMessage).slice(0, 1000).join(''),
      connectionId,
    },
    connectionId,
  );
}
export async function loadModels(
  settings?: Pick<ChatSettings, 'provider' | 'connectionId'>,
): Promise<ModelCatalog> {
  return desktop() || (relayConnected && settings?.connectionId)
    ? routed(
        'models',
        { provider: settings?.provider, connectionId: settings?.connectionId },
        settings?.connectionId,
      )
    : structuredClone(fallbackModels);
}
export async function loadWorkspace(
  installation?: Installation,
  // Replies this computer still runs, which a reloaded window follows again.
  live: LiveRun[] = [],
): Promise<Workspace> {
  const value = desktop() ? await invoke<unknown>('load_workspace') : null;
  if (!value) return initialWorkspace();
  const following = new Set(live.map((run) => run.runId));
  // A restarted server interrupts only the replies it ran; other computers' replies run on. A
  // reply that runs on here through a reload of the window is no interrupted one either.
  return restoreWorkspace(
    value,
    installation?.server || following.size
      ? {
          runsHere: (c, m, fleet) =>
            !(m.runId && following.has(m.runId)) &&
            (!installation?.server || runsOn(fleet, c, m, installation.id)),
        }
      : undefined,
  );
}
/**
 * The app session this desktop process opened when it started; page reloads keep it, and a page
 * after the first one of the process hears that it `reloaded`.
 */
export async function appSession(): Promise<
  { id: string; startedAt: string; reloaded: boolean } | undefined
> {
  if (!desktop()) return undefined;
  const value = await invoke<{ id?: unknown; startedAt?: unknown; reloaded?: unknown } | null>(
    'app_session',
  );
  const startedAt = new Date(typeof value?.startedAt === 'number' ? value.startedAt : NaN);
  if (typeof value?.id !== 'string' || Number.isNaN(startedAt.getTime())) return undefined;
  return { id: value.id, startedAt: startedAt.toISOString(), reloaded: value.reloaded === true };
}
/** The desktop host asks for the whole workspace when it cannot complete a patch. */
const needsWholeWorkspace = 'The whole workspace is needed to save this change.';
export async function saveWorkspace(
  workspace: Workspace,
  scope = workspaceStorageScope(),
  // The conversations that changed. Given them, the desktop host fills the rest in from its last
  // write, so one streamed reply does not serialize every conversation. Omit them to send all.
  changed?: Conversation[],
  // Detached copies of `changed` that share what did not change with the copies before them
  // (src/lib/chat-snapshots.ts). The desktop host then takes the save as bytes, in which only
  // what changed is written anew: a streamed reply saves its conversation every few seconds, and
  // writing a 9.8 MB one as text each time held the page for 70 ms or more.
  copies?: Conversation[],
): Promise<void> {
  if (desktop()) {
    if (changed) {
      const { conversations, ...index } = workspace;
      const order = conversations.map((c) => c.id);
      try {
        if (copies && !callsUsePostMessage())
          await invoke(
            'save_workspace_patch',
            joinBytes(jsonWith({ index, order }, [['upsert', chatList(copies)]])),
          );
        else await invoke('save_workspace_patch', { index, upsert: changed, order });
      } catch (e) {
        if (String(e).includes(needsWholeWorkspace)) await invoke('save_workspace', { workspace });
        else throw e;
      }
    } else await invoke('save_workspace', { workspace });
    notifyDesktop(workspace);
  } else {
    // A queued save from a former session must never be written to the new user's cache.
    if (!scope || scope !== workspaceStorageScope()) return;
    const store = await workspaceStore();
    await saveBrowserWorkspace(
      store,
      scope,
      workspace,
      changed,
      () => scope === workspaceStorageScope(),
      syncedChat,
      unpublishedHere(),
    );
  }
  updatePendingBadge(pendingChatCount(workspace.conversations));
}
// Unsent drafts stay on this device: never in the workspace, exports, or relay sync.
export async function loadDrafts(scope = workspaceStorageScope()): Promise<unknown> {
  if (desktop()) return invoke('load_drafts');
  if (!scope) return null;
  const saved = localStorage.getItem(`${scope}:drafts`);
  return saved === null ? null : JSON.parse(saved);
}
export async function saveDrafts(
  drafts: SavedDrafts,
  scope = workspaceStorageScope(),
): Promise<void> {
  if (desktop()) {
    await invoke('save_drafts', { drafts });
    return;
  }
  // A save queued by a former session must never reach another workspace's storage.
  if (!scope || scope !== workspaceStorageScope()) return;
  if (drafts.drafts.length) localStorage.setItem(`${scope}:drafts`, JSON.stringify(drafts));
  else localStorage.removeItem(`${scope}:drafts`);
}
export async function detectProviders(): Promise<ProviderStatus[]> {
  if (desktop()) return invoke('detect_providers');
  return providerIds.map((id) => ({
    id,
    installed: false,
    version: null,
    auth: 'unknown',
    detail: 'Open the desktop app to use installed CLIs.',
  }));
}
export async function runAgent(
  request: RunRequest,
  onEvent: (event: RunEvent) => void,
): Promise<'complete' | 'cancelled'> {
  // Another computer reads the reply's images from the relay, which must hold them first.
  if (remoteTarget(request.agent.connectionId)) {
    const hashes = request.messages.flatMap((message) => imageHashes({ messages: [message] }));
    if (hashes.length) {
      if (!relayStoresImages) throw new Error(oldRelayImages);
      if ((await publishImages(hashes)).size)
        throw new Error(
          'An image in this chat is not on the relay yet. Open the chat on the computer that attached it while it is connected, then send again.',
        );
    }
  }
  return routed(
    'run',
    { request, connectionId: request.agent.connectionId },
    request.agent.connectionId,
    (event) => {
      if (event.kind === 'skillschanged') {
        invalidateSources();
      } else onEvent(event);
    },
    request.runId,
  );
}
/**
 * A reply this computer runs that this window may follow (src-tauri/src/reply_feed.rs): a window
 * that reloads takes up again each reply its document saved as running.
 */
export type LiveRun = { runId: string; conversationId?: string; job: boolean; ended: boolean };
const liveRunSchema = z.object({
  runId: z.string().min(1),
  conversationId: z.string().optional(),
  job: z.boolean(),
  ended: z.boolean(),
});
/** The replies this computer runs, and those that ended while no window followed them. */
export async function liveRuns(): Promise<LiveRun[]> {
  if (!desktop()) return [];
  const live = await invoke<unknown>('live_runs');
  return Array.isArray(live) ? z.array(liveRunSchema).parse(live) : [];
}
/**
 * Follows a reply this computer runs from this window, which reloaded since the reply began: its
 * events so far come again, then the rest as they come, and the answer is its end.
 */
export async function followRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
): Promise<'complete' | 'cancelled'> {
  if (!desktop()) throw new Error('Only the computer running a reply follows it this way.');
  const channel = new Channel<RunEvent>();
  channel.onmessage = (event) => {
    if (event.kind === 'skillschanged') invalidateSources();
    else onEvent(event);
  };
  ownRuns.add(runId);
  try {
    return await invoke('follow_run', { runId, onEvent: channel });
  } finally {
    ownRuns.delete(runId);
  }
}
/**
 * Replies other devices asked for that ran on while this window reloaded. Their requests go on
 * publishing them once the relay answers (`resumeJob`); `unresumedJobs` hands back those it never
 * took, which the window then follows on its own.
 */
export function resumeJobs(runIds: string[]) {
  for (const runId of runIds) jobsToResume.add(runId);
}
export function unresumedJobs(): string[] {
  const left = [...jobsToResume].filter((runId) => !resumingJobs.has(runId));
  for (const runId of left) jobsToResume.delete(runId);
  return left;
}
const resumingJobs = new Set<string>();
async function resumeJob(runId: string, generation: number) {
  if (!runtime || resumingJobs.has(runId)) return;
  resumingJobs.add(runId);
  try {
    const response = await relayRaw('GET', `v1/jobs/${runId}`);
    if (generation !== relayGeneration || !jobsToResume.has(runId)) return;
    jobsToResume.delete(runId);
    const job = response.status === 200 ? (response.body as RelayJob) : undefined;
    if (
      job?.method === 'run' &&
      job.id === runId &&
      job.target === runtime.installation.id &&
      (job.status === 'running' || job.status === 'queued') &&
      !workerRuns.has(runId)
    ) {
      workerRuns.set(runId, job);
      void executeJob(job, true);
    }
    // The device that asked no longer follows its request: the reply still ends here, in the chat
    // this computer publishes.
    else runtime.followReply?.(runId);
  } catch {
    // The relay did not answer: the next poll asks again.
  } finally {
    resumingJobs.delete(runId);
  }
}
export async function cancelRun(runId: string, connectionId?: string, waitForCompletion = false) {
  if (remoteRuns.has(runId) || remoteTarget(connectionId)) {
    const generation = relayGeneration;
    const currentSession = () => {
      if (generation !== relayGeneration || !relayConnected)
        throw new Error('The private workspace connection changed. Cancellation was not replayed.');
    };
    currentSession();
    await relayApi('POST', `v1/jobs/${runId}/cancel`);
    currentSession();
    if (waitForCompletion) {
      const deadline = Date.now() + 20_000;
      while (true) {
        currentSession();
        const job = await relayApi<RelayJob>('GET', `v1/jobs/${runId}`);
        currentSession();
        if (['complete', 'cancelled', 'error'].includes(job.status)) break;
        if (Date.now() >= deadline)
          throw new Error(
            'The computer has not confirmed stopping the response. Try again when it is connected.',
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Merge the host's final checkpoint before publishing the deletion.
      while (relayBusy) {
        currentSession();
        if (Date.now() >= deadline) throw new Error('Sync is still busy. Try deleting again.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      currentSession();
      await pollRelay();
      currentSession();
    }
    return;
  }
  await invoke('cancel_run', { runId, waitForCompletion });
}
/**
 * Release the CLI process this computer keeps parked for a conversation deleted or rewound
 * here, or deleted on another device and removed here by sync. Nothing else ends one: a
 * parked process stays until the user closes its chat.
 */
export async function releaseConversation(conversationId: string, connectionId?: string) {
  if (!desktop() || remoteTarget(connectionId)) return;
  await invoke('release_conversation', { conversationId });
}
/**
 * The user moved a chat to History, which closes it: the computer that runs it releases its
 * parked CLI process, asked through a relay job from another device. History moves arriving
 * by sync close nothing, since another desktop's startup sends them too.
 */
export async function closeConversation(conversationId: string, connectionId?: string) {
  if (!connectionId || !remoteTarget(connectionId)) return releaseConversation(conversationId);
  await routed('release', { conversationId, connectionId }, connectionId);
}
export async function undoFiles(
  conversationId: string,
  runId: string,
  connectionId: string | undefined,
  commit = false,
): Promise<{ files: string[]; undone: boolean }> {
  const result = await routed<{ files: string[]; undone: boolean }>(
    'undoFiles',
    { conversationId, runId, connectionId, commit },
    connectionId,
  );
  if (
    !result ||
    !Array.isArray(result.files) ||
    !result.files.every((p) => typeof p === 'string') ||
    typeof result.undone !== 'boolean'
  )
    throw new Error('The execution computer returned an invalid Undo result.');
  return result;
}
export async function answerQuestion(runId: string, answer: QuestionAnswer, connectionId?: string) {
  return routed<void>(
    'answer',
    { runId, answer: answerSchema.parse(answer), connectionId },
    connectionId,
  );
}
export async function manageElicitation(
  runId: string,
  input: ElicitationInput,
  connectionId?: string,
): Promise<unknown> {
  return routed(
    'elicitation',
    { runId, input: elicitationInputSchema.parse(input), connectionId },
    connectionId,
  );
}
export async function steerRun(runId: string, input: SteeringInput, connectionId?: string) {
  return routed<void>(
    'steer',
    { runId, input: steeringInputSchema.parse(input), connectionId },
    connectionId,
  );
}
/**
 * Signs in to a connection's CLI on this computer. Claude Code and Codex sign in without a
 * terminal: their page opens in the browser, and the returned sign-in is followed through
 * `watchSignIns`. Antigravity opens its own terminal and returns null.
 */
export async function signIn(
  provider: string,
  connectionId?: string,
  onView?: (view: SignInView) => void,
): Promise<SignInView | null> {
  if (connectionId && remoteTarget(connectionId))
    return remoteSignIn(provider, connectionId, onView);
  const view = await invoke<unknown>('sign_in', { provider, connectionId });
  return view == null ? null : signInViewSchema.parse(view);
}
// Sign-ins this window opened on other computers, by the id their computer gave them: the relay
// job that follows each, and the connection it signs in.
const remoteSignIns = new Map<string, { job: string; connectionId: string }>();
/**
 * Opens a sign-in on the computer that runs this connection, through the relay: its CLI waits
 * there, opening nothing, while this window shows the page and the code (Codex's device code, or
 * the one Claude's page shows, pasted back here). Resolves once the page is known; later changes,
 * up to the end, go to `onView`.
 */
function remoteSignIn(
  provider: string,
  connectionId: string,
  onView?: (view: SignInView) => void,
): Promise<SignInView> {
  const job = crypto.randomUUID();
  return new Promise<SignInView>((resolve, reject) => {
    let started: SignInView | undefined;
    const seen = (value: unknown) => {
      const view = signInViewSchema.safeParse(value);
      if (!view.success) return;
      if (started) {
        onView?.(view.data);
        return;
      }
      started = view.data;
      remoteSignIns.set(view.data.id, { job, connectionId });
      resolve(view.data);
    };
    // Its end, as its computer reported it, or as the request ended without saying.
    const ended = (message: string, phase: 'failed' | 'cancelled') => {
      if (!started) reject(new Error(message || 'Sign-in was cancelled.'));
      else
        onView?.({
          ...started,
          phase,
          url: undefined,
          code: false,
          codeExpected: false,
          userCode: undefined,
          message,
        });
    };
    routed<unknown>('signIn', { provider, connectionId }, connectionId, seen, job)
      .then((result) => {
        if (result === 'cancelled') ended('', 'cancelled');
        else if (!signInViewSchema.safeParse(result).success)
          ended('The sign-in ended without saying how.', 'failed');
        else if (!started) reject(new Error('The sign-in ended before it showed its page.'));
        else seen(result);
      })
      .catch((error) => ended(String(error instanceof Error ? error.message : error), 'failed'))
      .finally(() => {
        if (started) remoteSignIns.delete(started.id);
      });
  });
}
/**
 * A sign-in another device opened on this computer: started without opening a page here, and
 * followed through this computer's own sign-in events until it ends, each state going to that
 * device as the job's event.
 */
async function hostSignIn(
  args: Record<string, unknown>,
  onEvent?: (event: RunEvent) => void,
): Promise<SignInView> {
  const send = (view: SignInView) => onEvent?.(view as unknown as RunEvent);
  let id: string | undefined;
  const early: SignInView[] = [];
  let finish!: (view: SignInView) => void;
  const ended = new Promise<SignInView>((resolve) => (finish = resolve));
  const take = (view: SignInView) => {
    if (view.id !== id) return;
    send(view);
    if (view.phase !== 'waiting') finish(view);
  };
  const stop = await listen<unknown>('studio-sign-in', ({ payload }) => {
    const view = signInViewSchema.safeParse(payload);
    if (!view.success) return;
    if (id) take(view.data);
    else early.push(view.data);
  });
  try {
    const first = signInViewSchema.parse(
      await invoke('sign_in', {
        provider: args.provider,
        connectionId: args.connectionId,
        remote: true,
      }),
    );
    id = first.id;
    send(first);
    for (const view of early) take(view);
    return await ended;
  } finally {
    stop();
  }
}
/** The sign-ins this computer waits on, for a window that opens or reloads. */
export async function listSignIns(): Promise<SignInView[]> {
  if (!desktop()) return [];
  return z.array(signInViewSchema).parse(await invoke('sign_ins'));
}
/** Sends the code a Claude sign-in page showed to the CLI waiting for it. */
export async function submitSignInCode(id: string, code: string): Promise<SignInView> {
  const remote = remoteSignIns.get(id);
  if (remote)
    return signInViewSchema.parse(
      await routed(
        'signInCode',
        { connectionId: remote.connectionId, id, code },
        remote.connectionId,
      ),
    );
  return signInViewSchema.parse(await invoke('sign_in_code', { id, code }));
}
export async function cancelSignIn(id: string): Promise<void> {
  const remote = remoteSignIns.get(id);
  // The computer running it stops it once the relay says so.
  if (remote) await relayApi('POST', `v1/jobs/${remote.job}/cancel`);
  else await invoke('cancel_sign_in', { id });
}
export async function watchSignIns(update: (view: SignInView) => void): Promise<() => void> {
  if (!desktop()) return () => {};
  return listen<unknown>('studio-sign-in', ({ payload }) => {
    const view = signInViewSchema.safeParse(payload);
    if (view.success) update(view.data);
  });
}
/**
 * Opens a console window on this computer, in the chat's folder, and runs one code block of a
 * reply there (`src-tauri/src/console.rs`). A console opens only where it is seen, so a chat
 * another computer runs has no Run. Resolves with the name of the shell that opened.
 */
export async function runInConsole(
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
  conversationId: string,
  location: ChatLocation | undefined,
  shell: ConsoleShell,
  code: string,
): Promise<string> {
  if (!desktop() || remoteTarget(settings.connectionId))
    throw new Error(
      'A console opens on the computer that runs this chat. Open Agent Studio there to run this code.',
    );
  const opened = await invoke<{ shell?: unknown } | null>('run_in_console', {
    provider: settings.provider,
    connectionId: settings.connectionId ?? null,
    conversationId,
    location: location ?? null,
    shell,
    code,
  });
  const name = opened?.shell;
  return typeof name === 'string' && name ? name : 'a console';
}
/**
 * A screen's request, answered by the computer that keeps it (`manage_screen`, src-tauri/src/
 * screens.rs): this one directly, another through its relay job. `environmentId` names that
 * computer, or one of its WSL distributions; the request names the screen by its id alone.
 */
async function screenRequest(environmentId: string, request: ScreenRequest): Promise<unknown> {
  try {
    return await routed('screens', { environmentId, request });
  } catch (e) {
    // A relay older than screens refuses their requests as an invalid payload.
    if (e instanceof RelayResponseError && e.status === 400)
      throw new Error(
        'The relay does not route screens yet. It does once it runs the Agent Studio release that brings them.',
      );
    throw e;
  }
}
/** The screens one computer keeps, named by an environment it owns. */
export async function listScreens(environmentId: string): Promise<ScreenSummary[]> {
  const answer = (await screenRequest(environmentId, { op: 'list' })) as { screens?: unknown };
  return z.array(screenSummarySchema).parse(answer?.screens ?? []);
}
export async function readScreen(environmentId: string, id: string): Promise<ScreenDetail> {
  return screenDetailSchema.parse(await screenRequest(environmentId, { op: 'read', id }));
}
/** Runs one of a screen's actions and waits for its end, as workflow steps run them. */
export async function runScreenAction(
  environmentId: string,
  id: string,
  action: string,
  params: Record<string, unknown>,
): Promise<ScreenOutcome> {
  return screenOutcomeSchema.parse(
    await screenRequest(environmentId, { op: 'run', id, action, params }),
  );
}
/**
 * Starts one of a screen's actions, or a command its page passes, as a job on its computer. It
 * goes on whoever follows it; a kept job stays until a page forgets it.
 */
export async function startScreenJob(
  environmentId: string,
  id: string,
  start: {
    action?: string;
    command?: ScreenCommand;
    params?: Record<string, unknown>;
    keep?: boolean;
  },
): Promise<ScreenJob> {
  return screenJobSchema.parse(await screenRequest(environmentId, { op: 'start', id, ...start }));
}
/** A screen's jobs on its computer, the newest first. */
export async function screenJobs(environmentId: string, id: string): Promise<ScreenJob[]> {
  const answer = (await screenRequest(environmentId, { op: 'jobs', id })) as { jobs?: unknown };
  return z.array(screenJobSchema).parse(answer?.jobs ?? []);
}
/**
 * A job's output from byte `after` of its log, waiting a while for some when asked to. A page's
 * read of a job's end lets a job that is not kept go; `peek` reads without that.
 */
export async function screenJobOutput(
  environmentId: string,
  id: string,
  job: string,
  after: number,
  { wait = false, peek = false }: { wait?: boolean; peek?: boolean } = {},
): Promise<ScreenOutput> {
  return screenOutputSchema.parse(
    await screenRequest(environmentId, { op: 'output', id, job, after, wait, peek }),
  );
}
export async function stopScreenJob(
  environmentId: string,
  id: string,
  job: string,
): Promise<ScreenJob> {
  return screenJobSchema.parse(await screenRequest(environmentId, { op: 'stop', id, job }));
}
export async function forgetScreenJob(environmentId: string, id: string, job: string) {
  await screenRequest(environmentId, { op: 'forget', id, job });
}
/**
 * Calls an MCP tool for a screen through the CLI of an account where the screen runs, or in the
 * place named: the account named first, then the others there until one has the server.
 */
export async function callScreenTool(
  environmentId: string,
  id: string,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  reach: { where?: string; account?: string } = {},
): Promise<ScreenToolResult> {
  return screenToolResultSchema.parse(
    await screenRequest(environmentId, { op: 'mcp', id, server, tool, arguments: args, ...reach }),
  );
}
/** The MCP servers an account has where the screen runs, or in the place named. */
export async function screenMcpServers(
  environmentId: string,
  id: string,
  reach: { where?: string; account?: string } = {},
): Promise<ScreenServers> {
  return screenServersSchema.parse(
    await screenRequest(environmentId, { op: 'tools', id, ...reach }),
  );
}
/** A model's answer to a screen's question, from the screen's account without tools. */
export async function askScreenModel(
  environmentId: string,
  id: string,
  question: { prompt: string; model?: string; system?: string },
): Promise<string> {
  const answer = (await screenRequest(environmentId, { op: 'ask', id, ...question })) as {
    text?: unknown;
  };
  return z.string().parse(answer?.text);
}
export async function deleteScreen(environmentId: string, id: string): Promise<void> {
  await screenRequest(environmentId, { op: 'delete', id });
}
/** The values a screen keeps on its computer with `studio.save`. */
export async function loadScreenData(
  environmentId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const answer = (await screenRequest(environmentId, { op: 'load', id })) as { values?: unknown };
  return z.record(z.string(), z.unknown()).parse(answer?.values ?? {});
}
export async function saveScreenData(
  environmentId: string,
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  await screenRequest(environmentId, { op: 'save', id, key, value });
}
/**
 * The icon a linked site serves for itself, read on this computer for a reply's link marks.
 * A paired browser asks its relay instead, since its window may not load one itself.
 */
export async function siteIcon(origin: string): Promise<string | null> {
  if (desktop()) return (await invoke<string | null>('site_icon', { origin })) ?? null;
  // A paired browser has its relay read the icon: its own window may load images from that
  // origin alone, and the relay keeps one reading for every device.
  const read = await relayApi<{ icon?: string | null }>(
    'GET',
    `v1/icon/${encodeURIComponent(origin)}`,
  );
  return read?.icon ?? null;
}
export async function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (desktop()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener,noreferrer');
}

// ---- claude.ai artifacts inside the window (src-tauri/src/claude_pages.rs) --------------------

/** Where a view's slot is in the window, in CSS pixels. */
export type PagePlace = { x: number; y: number; width: number; height: number };
/** What a view asks of the claude.ai pane of its account: the artifact, and where it shows. */
export type PageRequest = {
  view: string;
  account: string;
  url: string;
  load: string;
  /** None while the view is hidden or something covers its slot. */
  bounds?: PagePlace;
  dark: boolean;
};
/**
 * Whether this window shows claude.ai artifacts inside itself, in a WebView2 of their own over
 * the panel holding them; elsewhere they open in the browser.
 */
export const claudePagesInApp = (): boolean =>
  desktop() && runtime?.installation.platform === 'windows' && !serverHost();
let pageRequests = 0;
export async function showClaudePage(request: PageRequest): Promise<void> {
  watchPageFocus();
  await invoke('claude_page', {
    request: { ...request, bounds: request.bounds ?? null, seq: ++pageRequests },
  });
}
/** Closes the claude.ai sessions of every account but `keep`, whose artifacts chats still show. */
export async function closeClaudePages(keep: string[]): Promise<void> {
  if (claudePagesInApp()) await invoke('close_claude_pages', { keep });
}
// Whether a claude.ai pane has keyboard focus, which this window then still has, and when one
// last gave it back.
const pageFocus = { focused: false, left: 0 };
let pageFocusWatched = false;
function watchPageFocus() {
  if (pageFocusWatched || !desktop()) return;
  pageFocusWatched = true;
  void listen<unknown>('studio-claude-page-focus', ({ payload }) => {
    const focused = payload === true;
    if (pageFocus.focused && !focused) pageFocus.left = Date.now();
    pageFocus.focused = focused;
    // The chat beside the pane is still the one read.
    void publishNotificationView();
  });
}
const pageEnds = new Set<(account: string) => void>();
let pageEndsWatched = false;
/** Hears of the claude.ai panes that ended with their browser process, which Reload builds again. */
export function onClaudePageEnded(listener: (account: string) => void): () => void {
  if (!pageEndsWatched && desktop()) {
    pageEndsWatched = true;
    void listen<unknown>('studio-claude-page-ended', ({ payload }) => {
      if (typeof payload === 'string') for (const heard of pageEnds) heard(payload);
    });
  }
  pageEnds.add(listener);
  return () => void pageEnds.delete(listener);
}
/** Whether keyboard focus is in this window: in its page, or in a claude.ai pane over it. */
export const windowFocused = () =>
  typeof document !== 'undefined' && (document.hasFocus() || pageFocus.focused);
/** Whether the page took focus back from a claude.ai pane just now, rather than from another app. */
export const backFromClaudePage = () => pageFocus.focused || Date.now() - pageFocus.left < 1000;

// ---- Workflows (docs/WORKFLOWS.md) ------------------------------------------------------------

/** The relay's workflow store revision from its revision answer, or undefined without one. */
let relayWorkflows: number | undefined;
const workflowRevisionListeners = new Set<(revision: number | undefined) => void>();
function noteWorkflows(value: unknown) {
  const next =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (next === relayWorkflows) return;
  relayWorkflows = next;
  for (const listener of workflowRevisionListeners) listener(next);
}
/** The revision of the relay's workflow store, while this device reaches one that has it. */
export const relayWorkflowRevision = () => (relayConnected ? relayWorkflows : undefined);
export function watchRelayWorkflows(listener: (revision: number | undefined) => void) {
  workflowRevisionListeners.add(listener);
  return () => void workflowRevisionListeners.delete(listener);
}
/**
 * The address of a webhook trigger: the relay starts a run of the workflow from each POST to it.
 * Only a relay with the workflow store has webhooks.
 */
export function workflowHookUrl(workflowId: string, nodeId: string, secret: string) {
  if (relayWorkflowRevision() === undefined) return undefined;
  const base = desktop() ? relayUrl : window.location.origin;
  if (!base) return undefined;
  return `${base.replace(/\/+$/, '')}/v1/hooks/${workflowId}/${encodeURIComponent(nodeId)}/${secret}`;
}
/** A request of the relay's workflow store. */
export function workflowRelay(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return relayRaw(method, `v1/workflows/${path}`, body);
}
/** The files of this computer's own workflow store, in app data. */
export const workflowFiles = {
  read: (name: string) =>
    invoke<string | null>('workflow_file_read', { name }).then((text) => text ?? undefined),
  write: (name: string, text: string) => invoke<void>('workflow_file_write', { name, text }),
  remove: (name: string) => invoke<void>('workflow_file_remove', { name }),
  names: () => invoke<string[]>('workflow_file_names'),
};
export const workflowCallSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  connectionId: z.string().uuid().nullable().optional(),
  tool: z.string().min(1),
  input: z.unknown(),
  mission: z
    .object({ runId: z.string().uuid(), role: z.literal('orchestrator') })
    .nullable()
    .optional(),
});
/** A workflow tool call of a reply this computer runs, which this window answers. */
export type WorkflowCall = z.infer<typeof workflowCallSchema>;
export async function watchWorkflowCalls(
  listener: (call: WorkflowCall) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  return listen<unknown>('studio-workflow-call', ({ payload }) => {
    const call = workflowCallSchema.safeParse(payload);
    if (call.success) listener(call.data);
  });
}
/** Calls still waiting for this window, as after a reload. */
export async function pendingWorkflowCalls(): Promise<WorkflowCall[]> {
  if (!desktop()) return [];
  return z.array(workflowCallSchema).parse(await invoke('pending_workflow_calls'));
}
export async function answerWorkflowCall(call: WorkflowCall, text: string, error: boolean) {
  await invoke('answer_workflow_call', {
    runId: call.runId,
    connectionId: call.connectionId ?? null,
    id: call.id,
    text,
    error,
  });
}

// Chats whose end alerts stay quiet, every chat of a workflow, and those that raise no alert at
// all, the chats of its runs.
let quietChats: () => Set<string> = () => new Set();
let isolatedChats: () => Set<string> = () => new Set();
export function setQuietChats(chats: () => Set<string>, isolated: () => Set<string>) {
  quietChats = chats;
  isolatedChats = isolated;
}
/** A workflow run's alert, as a desktop notification that opens the workflow. */
export async function notifyWorkflow(
  runId: string,
  alert: { id: string; kind: 'question' | 'notify' | 'completed' | 'failed'; title: string; text: string },
) {
  if (!desktop() || serverHost()) return;
  await invoke('desktop_notification', {
    notice: {
      kind: alert.kind === 'question' ? 'attention' : alert.kind === 'failed' ? 'error' : 'complete',
      workflowId: runId,
      tag: `${runId}:workflow:${alert.id}`,
      title: alert.title,
      body: alert.kind === 'question' ? `Question: ${alert.text}` : alert.text,
    },
  }).catch(() => {});
}
