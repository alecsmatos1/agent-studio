<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import RewindDialog from '$lib/components/RewindDialog.svelte';
  import ImportChats from '$lib/components/ImportChats.svelte';
  import UndoFilesDialog from '$lib/components/UndoFilesDialog.svelte';
  import ShutdownCountdown from '$lib/components/ShutdownCountdown.svelte';
  import { ShutdownWatch } from '$lib/shutdown-watch.svelte';
  import { unfinishedChats, waitingText, type Waiting } from '$lib/shutdown-watch';
  import {
    returnedDraft,
    rewindConversation,
    rewoundMessage,
    sameReturned,
    undoRewind,
  } from '$lib/rewind';
  import { trackMobileViewport } from '$lib/mobileViewport';
  import { trackDrawerSwipe } from '$lib/drawerSwipe';
  import {
    asksTheUser,
    notificationConversation,
    requestsAttention,
    pendingChatCount,
  } from '$lib/notifications';
  import { createFinishedChatTracker, type FinishedChats } from '$lib/finished-chats';
  import { createChangeMarks } from '$lib/change-marks';
  import { createChatSnapshots } from '$lib/chat-snapshots';
  import {
    watchDesktopNotifications,
    watchNotificationView,
    publishNotificationView,
    watchAppUpdates,
    installAppUpdate,
    watchCliUpdates,
    watchSignIns,
    listSignIns,
    submitSignInCode,
    cancelSignIn,
    windowHeartbeat,
    recordWindowStall,
    recordIpcFallback,
    workingForOthers,
    chatsRunningForOthers,
    type AppUpdateStatus,
    type CliUpdates,
  } from '$lib/transport';
  import {
    rememberStall,
    takeRememberedStall,
    waitingCalls,
    watchAnswers,
    watchIpcFallback,
    type WindowStall,
  } from '$lib/window-answers';
  import { signInKey, signInUpdate, type SignInView } from '$lib/sign-in';
  import { restartBlocked } from '$lib/app-updates';
  import { newlyUpdated } from '$lib/cli-updates';
  import { modelMark } from '$lib/model-marks';
  import {
    ArrowUp,
    ArrowDown,
    ArrowRight,
    ArrowLeft,
    Plus,
    Bot,
    Cpu,
    Brain,
    Plug,
    Settings,
    Power,
    Search,
    ChevronRight,
    SlidersHorizontal,
    RefreshCw,
    LoaderCircle,
    MessageCircleQuestionMark,
    CirclePause,
    Activity,
    CircleStop,
    X,
    Pencil,
    Check,
    Laptop,
    CircleAlert,
    MessageCircle,
    FolderSearch,
    Archive,
    BookOpen,
    Paperclip,
    FileText,
    GitFork,
    Rewind,
    PenLine,
    RotateCcwClock,
    CalendarDays,
    LayoutDashboard,
    AlarmClock,
    Pin,
    MessageSquare,
    Zap,
    Workflow,
    Target,
    History as HistoryIcon,
    SearchX,
  } from '@lucide/svelte';
  import {
    abandonedReplyError,
    initialWorkspace,
    providerIds,
    providers,
    historyFor,
    messageSchema,
    messageText,
    settingsFor,
    rememberSettings,
    rememberAgent,
    type ChatSettings,
    type Reasoning,
    type Conversation,
    type Message,
    type ProviderId,
    type ProviderStatus,
    type RunEvent,
    type RunRequest,
    type Workspace,
    type ChatLocation,
  } from '$lib/domain';
  import {
    desktop,
    loadWorkspace,
    loadDrafts,
    saveDrafts,
    loadModels,
    readUsage,
    watchAccountUpdates,
    watchBackgroundWork,
    watchUsageRefresh,
    accountUsageRevision,
    generateTitle,
    cancelTitle,
    generateFolderIcon,
    steerRun,
    saveWorkspace,
    detectProviders,
    runAgent,
    followRun,
    liveRuns,
    resumeJobs,
    unresumedJobs,
    type LiveRun,
    cancelRun,
    abandonedReplies,
    releaseConversation,
    closeConversation,
    signIn,
    runInConsole,
    openLink,
    claudePagesInApp,
    closeClaudePages,
    windowFocused,
    backFromClaudePage,
    getInstallation,
    appSession,
    discoverWsl,
    inspectEnvironmentClis,
    configureRuntime,
    detectConnection,
    detectEnvironmentLogin,
    connectRelay,
    disconnectRelay,
    pollRelay,
    pollRelayNow,
    relaySyncNotice,
    resolveRelaySettings,
    listFolders,
    resumeRelay,
    watchBrowserSession,
    workspaceStorageScope,
    BrowserWorkspaceStorageError,
    OfflineHostError,
    browserExport,
    holdsLightChats,
    readWholeChats,
    relayHolds,
    readChatImage,
    storeChatImages,
    listScreens,
  } from '$lib/transport';
  import {
    isLightMessage,
    messagesById,
    restoreChat,
    sameMarkdown,
    workSignature,
  } from '$lib/light-chats';
  import ScreenView from '$lib/components/ScreenView.svelte';
  import DriverPicker from '$lib/components/DriverPicker.svelte';
  import { WorkflowClient } from '$lib/workflow-client.svelte';
  import type { ChatSpec, Readiness, WorkflowHost } from '$lib/workflow-engine';
  import type { WorkflowPickers } from '$lib/workflow-view';
  import {
    WORKFLOW_ACCOUNT,
    newDefinition,
    runActive,
    type RunDriverChoice,
    type WorkflowSummary,
  } from '$lib/workflow-model';
  import {
    DYNAMIC_FROM_CHAT,
    ORCHESTRATOR_INSTRUCTIONS,
    STATIC_FROM_CHAT,
    assistantInstructions,
  } from '$lib/workflow-prompts';
  import {
    highestReasoning,
    rememberWorkflowAgent,
    rememberWorkflowMode,
    workflowAgent,
    workflowMode,
  } from '$lib/workflow-preferences';
  import {
    loadScreenData,
    notifyWorkflow,
    runScreenAction,
    saveScreenData,
    setQuietChats,
    workflowHookUrl as webhookUrl,
  } from '$lib/transport';
  import { notificationWorkflow } from '$lib/notifications';
  import { screenFolderName, type ScreenDetail, type ScreenSummary } from '$lib/screens';
  import type { PublishedArtifact } from '$lib/published-artifacts';
  import ChatInstructions from '$lib/components/ChatInstructions.svelte';
  import InputTemplates from '$lib/components/InputTemplates.svelte';
  import {
    appendTemplateInput,
    inputTemplatesSchema,
    type InputTemplate,
  } from '$lib/input-templates';
  import { claudeInstructions } from '$lib/claude-instructions';
  import ConversationContextMenu from '$lib/components/ConversationContextMenu.svelte';
  import { forkConversation, forkPoint } from '$lib/forks';
  import ModelContext from '$lib/components/ModelContext.svelte';
  import ModelMark from '$lib/components/ModelMark.svelte';
  import { applyRunEvent, savesAtOnce, toolElapsed } from '$lib/activity';
  import { planCountText, runningPlanProgress } from '$lib/plans';
  import { clock } from '$lib/clock';
  import { awaitingAnswer } from '$lib/questions';
  import { applyQuestionDraft, type QuestionDraft } from '$lib/question-drafts';
  import {
    messageBackgroundWork,
    type BackgroundWorkEvent,
    type HostBackgroundWork,
  } from '$lib/background-work';
  import WindowTitlebar from '$lib/components/WindowTitlebar.svelte';
  import BrowserStatus from '$lib/components/BrowserStatus.svelte';
  import WorkspaceLogin from '$lib/components/WorkspaceLogin.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import PanelResize from '$lib/components/PanelResize.svelte';
  import SidebarResize from '$lib/components/SidebarResize.svelte';
  import FleetManager from '$lib/components/FleetManager.svelte';
  import FolderBrowser from '$lib/components/FolderBrowser.svelte';
  import {
    locationKey,
    locationExecutionId,
    locationExecutionEnvironment,
    computerFolderEnvironments,
    insideDistribution,
    folderName,
    ensureLocationConnections,
    ensureEnvironmentConnections,
    environmentOffers,
    addHostAccounts,
    loginIdentity,
    type LoginIdentities,
    locationConnections,
    rememberLocation,
    knownLocations,
    conversationLocation,
    groupConversations,
    historySectionId,
    nextActiveConversation,
    scratchLocation,
    type PinnedChat,
  } from '$lib/locations';
  import {
    appSessionSchema,
    recordAppSession,
    sessionTimeline,
    startOfDay,
  } from '$lib/app-sessions';
  import { chatDays } from '$lib/chat-days';
  import {
    folderIconIndex,
    folderIconKey,
    folderIconOf,
    folderIconSchema,
    withFolderIcon,
  } from '$lib/folder-icons';
  import FolderIcon from '$lib/components/FolderIcon.svelte';
  import {
    dueSnoozes,
    latestStart,
    snoozeIndex,
    snoozeState,
    withSnooze,
    withoutSnooze,
  } from '$lib/snoozes';
  import { pinIndex, withPin, withoutPin } from '$lib/pins';
  import {
    continueStep,
    continueText,
    limitedReply,
    startedPlan,
    waitingPlan,
  } from '$lib/auto-continue';
  import { accountColorIndex, accountColorValue, assignAccountColors } from '$lib/account-colors';
  import { accountActivity, balanceableAccounts, balancedAccount } from '$lib/account-balance';
  import AccountMark from '$lib/components/AccountMark.svelte';
  import {
    registerInstallation,
    registerWslEnvironments,
    accountName,
    connectionLabel,
    executionHost,
    computerViewId,
    computerViews,
    type CliInventory,
    type Connection,
    type Installation,
    type WslDiscovery,
  } from '$lib/fleet';
  import { replaceFields, sharedMeta, sharedWorkspace, type Presence } from '$lib/sync';
  import {
    fallbackModels,
    fastModeBlock,
    fastModeTitle,
    modelChoices,
    reasoningName,
    reasoningScale,
    type ModelCatalog,
  } from '$lib/models';
  import ChoicePicker from '$lib/components/ChoicePicker.svelte';
  import PlanModePicker from '$lib/components/PlanModePicker.svelte';
  import ComposerCommands from '$lib/components/ComposerCommands.svelte';
  let composerCommands = $state<ComposerCommands>();
  let draftMentions = $state<import('$lib/mentions').Mention[]>([]);
  let staleMentionTokens = $state<string[]>([]);
  let mentionSelection = $state('');
  const hasComposerMentions = $derived(!!draftMentions.length || !!staleMentionTokens.length);
  let modelPicker = $state<ChoicePicker>();
  let reasoningPicker = $state<ChoicePicker>();
  let agentPicker = $state<ChoicePicker>();
  let usageExpanded = $state(false);
  let preparingCommand = false;
  import { separateMemory, summarizeFileChanges } from '$lib/file-changes';
  import MessageView from '$lib/components/MessageView.svelte';
  import ArtifactViewer from '$lib/components/ArtifactViewer.svelte';
  import SubagentPanel from '$lib/components/SubagentPanel.svelte';
  import FileViewer from '$lib/components/FileViewer.svelte';
  import { provideFileViewer } from '$lib/file-viewer.svelte';
  import { carriedSubagents, findSubagent, replyTools } from '$lib/subagents';
  import ClaudePageViewer from '$lib/components/ClaudePageViewer.svelte';
  import { leaveChats, newestPage, type ShownArtifact, type SubagentView } from '$lib/side-panels';
  import { provideRecall, recalled, type ChatRecall } from '$lib/chat-recall';
  import { findPlace, holdAnchor, readPlace, type Anchor, type ChatPlace } from '$lib/chat-places';
  import { codeBlockAction, consoleShells, performCodeBlockAction } from '$lib/code-blocks';
  import { artifactCardAction, recordArtifact, type Artifact } from '$lib/artifacts';
  import ImageAttachments from '$lib/components/ImageAttachments.svelte';
  import {
    readImage,
    imageTypes,
    supportsImages,
    storedImage,
    type DraftImage,
    type StoredImage,
  } from '$lib/images';
  import {
    enqueueMessage,
    queuedPreview,
    restoreToDraft,
    takeOverTarget,
    type QueuedMessage,
  } from '$lib/queue';
  import {
    draftKey,
    hasDraft,
    mergeSavedDrafts,
    readSavedDrafts,
    restoredDraft,
    sameDraft,
    savedDraft,
    savedScratch,
    scratchIdOf,
    scratchTitle,
    type Draft,
    type DraftChange,
    type DraftContent,
    type SavedDraft,
    type SavedScratch,
    type ScratchChat,
    type ScratchWorkflow,
  } from '$lib/drafts';
  import {
    fastModeName,
    replyAccountSwitches,
    replySettingsChanged,
    replySwitches,
    selectedModelName,
    replyTimeTotals,
  } from '$lib/replies';
  import UsagePanel from '$lib/components/UsagePanel.svelte';
  import QuotaBars from '$lib/components/QuotaBars.svelte';
  import SettingsPage from '$lib/components/SettingsPage.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import SidebarEmpty from '$lib/components/SidebarEmpty.svelte';
  import { estimatePromptTokens, usageKey, snapshotFor, type UsageSnapshot } from '$lib/usage';
  import { mergeLiveUsage, type AccountUpdate } from '$lib/live-usage';
  import { createVirtualSpace, type VirtualSpace } from '$lib/virtual-space';
  import '$lib/styles.css';
  import { initAppearance } from '$lib/appearance.svelte';

  initAppearance();

  type View = 'chat' | 'connections' | 'settings' | 'screen' | 'workflow';
  let installation = $state<Installation>();
  let wslDiscovery = $state<WslDiscovery>();
  let wslError = $state('');
  let wslRefreshing = false;
  let connectionStatuses = $state<Record<string, ProviderStatus>>({});
  // Existing CLI login reports per locally managed environment, kept only for this session.
  let environmentLogins = $state<Record<string, Partial<Record<ProviderId, ProviderStatus>>>>({});
  let cliInventories = $state<Record<string, CliInventory>>({});
  const connectionChecks = new Map<string, Promise<void>>();
  // When each connection's sign-in was last checked, so opening the Agent picker often stays cheap.
  const connectionCheckedAt = new Map<string, number>();
  let presence = $state<Presence[]>([]);
  let paired = $state(false);
  let workspaceSession = $state(0);
  let syncStatus = $state('');
  let syncError = $state('');
  // Conversations a working sync leaves on this device, named apart from errors: a notice never
  // makes another computer read as offline or keeps a chat from running there.
  let syncNotice = $state('');
  let view = $state<View>('chat');
  // The account Connections was opened for, shown there with its sign-in on that visit.
  let connectionsHighlight = $state('');
  let sidebarWidth = $state<number>();
  let viewportWidth = $state(1024);
  let sidebarOpen = $state(false);
  let online = $state(true);
  const mobile = $derived(viewportWidth <= 650);
  let sidebarElement = $state<HTMLElement>();
  // A finger dragging the drawer keeps it between closed and open until it lifts,
  // and the drawer then carries itself the rest of the way.
  let drawerDrag = $state<number>();
  let drawerSettling = $state(false);
  let drawerSettleTimer: ReturnType<typeof setTimeout>;
  async function toggleSidebar(open: boolean) {
    sidebarOpen = open;
    await tick();
    if (open) sidebarElement?.querySelector<HTMLButtonElement>('.mobile-close')?.focus();
    else document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus();
  }
  let workspace = $state<Workspace>(initialWorkspace());
  let loaded = $state(false);
  let storageError = $state('');
  // The desktop app stopped answering this window's calls (src/lib/window-answers.ts).
  let appNotAnswering = $state(false);
  let notice = $state('');
  let appUpdate = $state<AppUpdateStatus>();
  let cliUpdates = $state<CliUpdates>();
  let restartingForUpdate = $state(false);
  let statuses = $state<ProviderStatus[]>([]);
  let refreshing = $state(false);
  // Accounts followed until they report ready, by connection or by provider for its own login:
  // for ten minutes after Antigravity's terminal opens, and for a minute after a CLI reports
  // that its sign-in finished. Several may be followed at once.
  const pendingSignIns = new Map<
    string,
    { provider: ProviderId; connectionId?: string; until: number }
  >();
  // Sign-ins this computer runs without a terminal, by the connection (or provider login) they
  // sign in to: waiting for the browser, or ended with a reason to show.
  let signIns = $state<Record<string, SignInView>>({});
  // The notice that asked to finish the latest sign-in opened here, by the key it is followed
  // under. It leaves once that sign-in no longer waits; one that connects adds no notice, since
  // its account reads connected.
  let signInPrompt: { key: string; text: string } | undefined;
  let activeId = $state<string | null>(null);
  let historyAction = $state<{
    kind: 'rewind' | 'files';
    conversationId: string;
    session: number;
    runId?: string;
  }>();
  let historyBusy = $state(false);
  let historyError = $state('');
  $effect(() => {
    if (
      historyAction &&
      (historyAction.session !== workspaceSession ||
        activeId !== historyAction.conversationId ||
        view !== 'chat' ||
        activeRunning)
    )
      historyAction = undefined;
  });
  // A rewind or Undo error belongs to the conversation it was raised in.
  $effect(() => {
    void activeId;
    untrack(() => (historyError = ''));
  });
  let draftSettings = $state<ChatSettings>(untrack(() => settingsFor(workspace.preferences)));
  // Whether the open new chat starts on the least used account of its agent (Settings → New
  // chats), which it does until an account is chosen for it.
  let draftBalanced = $state(false);
  let draftLocation = $state<ChatLocation>();
  let draftComputerId = $state('');
  let folderBrowserOpen = $state(false);
  let selectingLocation = $state(false);
  let locationPending = $state(false);
  let locationGeneration = 0;
  let settingsRevision = 0;
  let collapsedGroups = $state<Record<string, boolean>>({});
  let conversationScope = $state<'active' | 'history' | 'screens'>('active');
  // Screens (docs/SCREENS.md): each computer keeps its own and lists them when asked. This window
  // keeps the lists it read for the session, by the host that answered.
  type ScreenShelf = {
    screens: ScreenSummary[];
    loading: boolean;
    error?: string;
    checkedAt?: number;
  };
  let screenShelves = $state<Record<string, ScreenShelf>>({});
  let openedScreen = $state<{ environmentId: string; id: string }>();
  // Every screen this window opened stays open, shown or not, so its page keeps what it showed
  // while another chat, screen or page is on screen (requested 2026-10-30); its key names the
  // workspace session it belongs to. Reload, deletion and a workspace change end one.
  let keptScreens = $state<{ key: string; environmentId: string; id: string }[]>([]);
  // The workflow or run the main area shows as a page (docs/WORKFLOWS.md).
  let openedWorkflow = $state<string>();
  // The run of it the page shows in its place, and the run each workflow shows beside its chat,
  // by workflow.
  let openedWorkflowRun = $state<string>();
  let panelRuns = $state<Record<string, string | undefined>>({});
  // Whether a workflow shows its chat beside its graph, by workflow; window memory only. It opens
  // while the workflow is made and when you open a chat of it, and opening the workflow again
  // leaves it to the workflow's kind (`chatCardOpen`; requested 2026-10-19 and 2026-10-20).
  let workflowChatOpen = $state<Record<string, boolean>>({});
  // The chat card's width beside a workflow's graph, which its right edge resizes, and the space
  // it shares.
  let chatCardWidth = $state<number>();
  let chatWorkspaceWidth = $state(0);
  // Where a mission a new mission chat starts runs, chosen beside its composer.
  let missionDriver = $state<RunDriverChoice>();
  // The graph library loads with the first workflow opened, not with every start of the page.
  let workflowViewModule: Promise<typeof import('$lib/components/WorkflowView.svelte')> | undefined;
  const workflowView = () =>
    (workflowViewModule ??= import('$lib/components/WorkflowView.svelte'));
  let workflowDraftModule: Promise<typeof import('$lib/components/WorkflowDraft.svelte')> | undefined;
  const workflowDraftView = () =>
    (workflowDraftModule ??= import('$lib/components/WorkflowDraft.svelte'));
  // Definitions and runs, and the runs this desktop drives.
  const workflows = new WorkflowClient({
    host: () => (loaded && installation ? workflowHost : undefined),
    drives: desktop(),
    alert: (summary, alert) => {
      // A run on screen needs no alert of its own.
      if (runShown(summary.id) && windowFocused()) return;
      void notifyWorkflow(summary.id, alert);
    },
  });
  const hiddenChats = $derived(workflows.chats);
  let modelGeneration = 0;
  let models = $state<ModelCatalog>(structuredClone(fallbackModels));
  let modelsLoading = $state(false);
  const modelCache = new Map<string, { catalog: ModelCatalog; checkedAt: number }>();
  const modelRequests = new Map<string, Promise<ModelCatalog>>();
  let usageSnapshots = $state<Record<string, UsageSnapshot>>({});
  let usageLoading = $state<Record<string, boolean>>({});
  let usageErrors = $state<Record<string, string>>({});
  let prompt = $state('');
  let templatesOpen = $state(false);
  $effect(() => {
    if (view !== 'chat') templatesOpen = false;
  });
  let attachedImages = $state<DraftImage[]>([]);
  // Unsent composer content per chat and per scratch chat. Text is saved on this device only;
  // attached images stay until the app closes.
  const drafts = new Map<string, Draft>();
  const changedDrafts = new Map<string, number>();
  let composerDraftKey = '';
  let draftsReady = false;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let draftSaves = Promise.resolve();
  let draftSaveFailed = false;
  // New conversations not sent yet. Every new chat opens its own scratch chat, and those with
  // unsent content stay in the sidebar until they are sent or discarded. `balanced` lasts for
  // the session: a saved scratch chat keeps the account it had.
  type Scratch = ScratchChat & { title: string; filled: boolean; balanced?: boolean };
  let scratches = $state<Scratch[]>([]);
  let scratchId = $state('');
  $effect(() => {
    const content = {
      text: prompt,
      images: $state.snapshot(attachedImages),
      mentions: $state.snapshot(draftMentions),
      staleMentions: $state.snapshot(staleMentionTokens),
      mentionScope: mentionSelection,
    };
    untrack(() => {
      if (!loaded) return;
      composerDraftKey ||= currentDraftKey();
      keepDraft(content);
    });
  });
  // A light Viewer shows the open chat's recorded work, read whole from the relay, whenever another
  // chat opens, and lets the one left go back to light.
  $effect(() => {
    void activeId;
    if (loaded) untrack(() => void showWork());
  });
  // The open scratch chat keeps the computer, folder and settings chosen for it.
  $effect(() => {
    const id = scratchId,
      open = loaded && !activeId;
    const place = {
      computerId: draftComputerId,
      location: locationPending ? undefined : $state.snapshot(draftLocation),
      settings: $state.snapshot(draftSettings),
    };
    untrack(() => {
      if (open && id) placeScratch(id, place);
    });
  });
  let forking = $state(false);
  let attachmentError = $state('');
  let imagesLoading = $state(false);
  // A message's images are being kept in the image store before it is sent.
  let imagesSending = $state(false);
  let imageDragDepth = $state(0);
  let attachmentGeneration = 0;
  let imageInput = $state<HTMLInputElement>();
  let query = $state('');
  // A light Viewer holds every chat without the work its replies recorded (src/lib/light-chats.ts),
  // which the relay keeps, and shows the open chat's from the relay's whole copy. The chats that
  // may hold work here, those showing the relay's, and the work each message shows, so an
  // unchanged copy is not shown again.
  const chatsWithWork = new Set<string>();
  const workShown = new Set<string>();
  const shownWork = new Map<string, string>();
  let workReading = 0;
  /** Gives the open chat the work its replies recorded, and lets the others go back to light. */
  async function showWork() {
    if (!holdsLightChats()) return;
    const id = activeId;
    for (const other of [...chatsWithWork]) if (other !== id) lightenChat(other);
    if (!id || workShown.has(id)) return;
    const reading = ++workReading;
    try {
      const [whole] = await readWholeChats([id]);
      if (reading !== workReading || activeId !== id) return;
      // One the relay lacks yet holds everything here; its work arrives once it moves there.
      if (whole) attachWork(whole);
      else workShown.add(id);
    } catch {
      // Tried again after the next sync.
    }
  }
  /** Shows the relay's whole copy of the open chat. */
  function attachWork(whole: Conversation) {
    if (whole.id !== activeId) return;
    const conversation = workspace.conversations.find((c) => c.id === whole.id);
    if (!conversation) return;
    const found = messagesById([whole]);
    const live = runs[conversation.id];
    for (const message of [...conversation.messages, ...(conversation.rewind?.removed ?? [])]) {
      const source = found.get(message.id);
      // A message the relay lacks, such as a new fork's, and a reply this window follows as it
      // runs keep their own work; one whose text moved on shows its work after the sync that
      // brings that text.
      if (!source || (live && message.runId === live)) continue;
      if (!sameMarkdown(message, source)) continue;
      const signature = workSignature(source);
      if (shownWork.get(message.id) === signature && !isLightMessage(message)) continue;
      message.blocks = source.blocks;
      if (source.fileChanges) message.fileChanges = source.fileChanges;
      else delete message.fileChanges;
      shownWork.set(message.id, signature);
    }
    chatsWithWork.add(conversation.id);
    workShown.add(conversation.id);
  }
  /** A chat no longer shown lets go of the work the relay keeps for it. */
  function lightenChat(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    let kept = false;
    for (const message of [
      ...(conversation?.messages ?? []),
      ...(conversation?.rewind?.removed ?? []),
    ]) {
      if (isLightMessage(message)) continue;
      // Work only this device holds goes out first, and a reply still running keeps its own.
      if (!relayHolds(message.id) || message.status === 'running') {
        kept = true;
        continue;
      }
      message.blocks = message.blocks.filter((block) => block.type === 'markdown');
      delete message.fileChanges;
      shownWork.delete(message.id);
    }
    workShown.delete(id);
    if (!kept) chatsWithWork.delete(id);
  }
  /** A chat whose own recorded work arrives here, as a reply this window follows does. */
  const holdWork = (id: string) => {
    if (holdsLightChats()) chatsWithWork.add(id);
  };
  /** A light copy of a chat that arrived, with the work the chat shows here, which a sync keeps. */
  function keepWork(incoming: Conversation, existing: Conversation): Conversation {
    if (!holdsLightChats() || !chatsWithWork.has(existing.id)) return incoming;
    const found = messagesById([existing]);
    return restoreChat(incoming, (id) => found.get(id));
  }
  // Replies this window started, by conversation. Each conversation runs one reply at a time;
  // different conversations run side by side.
  let runs = $state<Record<string, string>>({});
  // Messages waiting for the running reply, per conversation. Session-only: never saved or relayed.
  let queued = $state<Record<string, QueuedMessage[]>>({});
  // The queued message going out now to a Claude reply that only waits for background work, by
  // conversation, and the idle stretch in which each such reply refused one, by run.
  let takingOver = $state<Record<string, string>>({});
  let takeOverRefused = $state<Record<string, number>>({});
  // The idle stretch each reply this window follows reported last, by run: null once a turn
  // started. A synced copy of the saved field can lag behind, or lack it on an older relay.
  let heardWaits = $state<Record<string, number | null>>({});
  function hearWait(runId: string, event: RunEvent) {
    if (event.kind === 'backgroundwait')
      heardWaits[runId] = Number.isSafeInteger(event.wait) && event.wait! > 0 ? event.wait! : null;
  }
  // Questions Claude is still writing in the replies this window follows, by run. They change
  // nothing saved: the recorded question replaces each one.
  let questionDrafts = $state<Record<string, QuestionDraft[]>>({});
  /** Whether the event only drafts a question, after applying it to the run's drafts. */
  function hearDraft(runId: string, event: RunEvent) {
    const drafts = applyQuestionDraft(questionDrafts[runId], event);
    if (drafts) questionDrafts[runId] = drafts;
    return event.kind === 'questiondraft';
  }
  // Whether a running reply only waits for background work, as this window last heard.
  function waitsForWork(m: Message) {
    const heard = m.runId ? heardWaits[m.runId] : undefined;
    return m.status === 'running' && !!(heard === undefined ? m.backgroundWait : heard);
  }
  // Steering inputs still being delivered, by run.
  let steeringPending = $state<Record<string, boolean>>({});
  let steeringAttempt: { runId: string; text: string; id: string } | undefined;
  // Every file the open chat's replies show, connected in one viewer that steps through them.
  const shownFiles = provideFileViewer();
  // The artifact and the sub-agent each chat shows, by conversation. A side panel stays with its
  // chat while another chat, Connections or Settings is shown (`src/lib/side-panels.ts`).
  let artifactViews = $state<Record<string, ShownArtifact>>({});
  let subagentViews = $state<Record<string, SubagentView>>({});
  // What the window recalls of each chat it showed, by conversation (`src/lib/chat-recall.ts`):
  // where the reader was reading, what they opened in it and where its side panels were scrolled.
  const recalls = new Map<string, ChatRecall>();
  function recallOf(chat: string) {
    let recall = recalls.get(chat);
    if (!recall) recalls.set(chat, (recall = new Map()));
    return recall;
  }
  provideRecall(() => untrack(() => (activeId ? recallOf(activeId) : undefined)));
  // The chat on screen, whose panel shows.
  const panelChat = $derived(view === 'chat' ? activeId : null);
  const artifactView = $derived(panelChat ? artifactViews[panelChat] : undefined);
  const subagentView = $derived(panelChat ? subagentViews[panelChat] : undefined);
  $effect(() => {
    const shown = panelChat;
    untrack(() => leaveChats(artifactViews, subagentViews, shown));
  });
  // A visual or an artifact page shown again under its id shows its latest revision.
  $effect(() => {
    const opened = artifactView;
    if (!opened) return;
    // A claude.ai artifact published again loads again, by whichever reply and device.
    if ('page' in opened) {
      const newest = newestPage(active?.messages ?? [], opened.page.id);
      if (newest && newest.version !== opened.version) {
        opened.page = { ...newest.page };
        opened.version = newest.version;
        opened.load = crypto.randomUUID();
      }
      return;
    }
    for (const message of active?.messages ?? []) {
      const latest = opened.artifact.visualization
        ? message.visualizations?.find((v) => `${message.id}:visual:${v.id}` === opened.artifact.id)
        : message.artifacts?.find((a) => recordArtifact(message.id, a).id === opened.artifact.id);
      if (latest && latest.revision > (opened.artifact.revision ?? 0))
        opened.artifact = {
          ...opened.artifact,
          title: latest.title,
          source: latest.source,
          revision: latest.revision,
        };
    }
  });
  function openArtifact(artifact: Artifact, mode: 'modal' | 'panel' = 'modal') {
    if (!activeId) return;
    artifactViews[activeId] = { artifact, mode, focus: true };
    // One panel at a time sits beside the chat.
    if (mode === 'panel') delete subagentViews[activeId];
  }
  /**
   * Opens a claude.ai artifact inside the window, in the claude.ai session of the account whose
   * reply published it (`src-tauri/src/claude_pages.rs`); elsewhere it opens in the browser.
   * The artifact a chat already shows stays as the reader left it.
   */
  function openPage(
    chat: string,
    page: PublishedArtifact,
    connectionId: string | undefined,
    focus = true,
  ) {
    const account = workspace.fleet.connections.find((c) => c.id === connectionId)?.accountId;
    if (!account || !claudePagesInApp()) {
      void openLink(page.url).catch(() => {});
      return;
    }
    const shown = artifactViews[chat];
    if (shown && 'page' in shown && shown.page.id === page.id) {
      shown.focus = focus;
      return;
    }
    // Its link shows the latest version, whichever reply's card opened it.
    const newest = newestPage(active?.id === chat ? active.messages : [], page.id);
    artifactViews[chat] = {
      page: newest ? { ...newest.page } : page,
      version: newest?.version ?? '',
      account,
      load: crypto.randomUUID(),
      mode: 'panel',
      focus,
    };
    delete subagentViews[chat];
  }
  // The claude.ai sessions of accounts whose artifacts no chat shows close.
  const pageAccounts = $derived(
    [
      ...new Set(
        Object.values(artifactViews).flatMap((shown) => ('page' in shown ? [shown.account] : [])),
      ),
    ]
      .sort()
      .join(' '),
  );
  let pagesShown = false;
  $effect(() => {
    const keep = pageAccounts ? pageAccounts.split(' ') : [];
    if (keep.length) pagesShown = true;
    else if (!pagesShown) return;
    untrack(() => void closeClaudePages(keep).catch(() => {}));
  });
  function showArtifactAs(chat: string, mode: 'modal' | 'panel') {
    const opened = artifactViews[chat];
    if (!opened) return;
    opened.mode = mode;
    if (mode === 'panel') delete subagentViews[chat];
  }
  function openSubagent(messageId: string, agentId: string) {
    if (!activeId) return;
    if (artifactViews[activeId]?.mode === 'panel') delete artifactViews[activeId];
    subagentViews[activeId] = { messageId, agentId, focus: true };
  }
  // A deleted chat's panels close, and the window forgets what it recalled of it.
  function forgetChat(chat: string) {
    delete artifactViews[chat];
    delete subagentViews[chat];
    recalls.delete(chat);
  }
  // Conversations whose reply this window is stopping.
  let stopping = $state<Record<string, boolean>>({});
  let editorOpen = $state(false);
  let contextOpen = $state(false);
  let deletion = $state<{
    type: 'conversation' | 'draft';
    id: string;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  let deleting = $state(false);
  let deletionError = $state('');
  let conversationMenu = $state<{
    id: string;
    scratch?: boolean;
    trigger: HTMLButtonElement;
    x: number;
    y: number;
  } | null>(null);
  const menuConversation = $derived(
    conversationMenu?.scratch
      ? undefined
      : workspace.conversations.find((c) => c.id === conversationMenu?.id),
  );
  const menuScratch = $derived(
    conversationMenu?.scratch ? scratches.find((s) => s.id === conversationMenu?.id) : undefined,
  );
  const deletingConversation = $derived(
    deletion?.type === 'conversation'
      ? workspace.conversations.find((c) => c.id === deletion?.id)
      : undefined,
  );
  let touchMenuTimer: ReturnType<typeof setTimeout> | undefined;
  let touchMenuOrigin: { x: number; y: number } | undefined;
  let longPressedConversation: string | undefined;
  let composerInput = $state<HTMLTextAreaElement>();
  let chatScroll = $state<HTMLDivElement>();
  let chatColumn = $state<HTMLDivElement>();
  let chatSpace = $state<HTMLDivElement>();
  let composerArea = $state<HTMLDivElement>();
  let virtualSpace: VirtualSpace | undefined;
  let nearBottom = true;
  // The conversation's height when the chat last followed its end or the reader moved.
  let followedHeight = 0;
  // What the reader was reading when their chat came back above its end. Content that sizes
  // itself later grows around it without moving it, until the reader moves; `place` waits for
  // the rest of a place that was not all there yet. Meanwhile the browser's own scroll anchoring
  // is off, since its adjustments arrive as scrolls the reader did not make.
  let heldPlace: { anchor: Anchor; place?: ChatPlace } | undefined;
  function holdPlace(held: typeof heldPlace) {
    if (!held !== !heldPlace) chatScroll?.style.setProperty('overflow-anchor', held ? 'none' : '');
    heldPlace = held;
  }
  // Offers a way back to the end while the chat does not follow it and more than a few lines
  // lie below the view.
  let jumpShown = $state(false);
  function showJump() {
    const scroll = chatScroll,
      space = chatSpace;
    jumpShown =
      !nearBottom &&
      !!scroll &&
      !!space &&
      // The virtual space starts where the conversation ends.
      space.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        scroll.clientTop -
        scroll.clientHeight >
        64;
  }
  // A scroll event arrives a frame after the scroll it reports. When the window becomes
  // narrower or shorter before the event of the chat's own return to its end arrives, as WebKit
  // orders them, the event finds the end moved away though nobody scrolled: reading the
  // position then stopped following, and the resize observers left the chat short of its end.
  // So an event that reports the position the chat was last read at or put at changes nothing.
  let scrolledTo: { scroll: HTMLElement; top: number } | undefined;
  function scrolled() {
    const scroll = chatScroll;
    if (!scroll) return;
    const known = scrolledTo?.scroll === scroll && Math.abs(scrolledTo.top - scroll.scrollTop) < 1;
    scrolledTo = { scroll, top: scroll.scrollTop };
    if (!known) readingPosition();
  }
  // Runs after the reader scrolls, expands, or collapses content.
  function readingPosition() {
    holdPlace(undefined);
    if (glide) {
      // The glide's own scrolling keeps the chat following; any other scroll ends it here.
      if (!glide.frame || Math.abs((chatScroll?.scrollTop ?? 0) - glide.top) < 1) return;
      stopGlide();
    }
    const hold = virtualSpace?.scrolled() ?? 'free';
    // Scrolling up through held space is a deliberate reading position too. While space
    // holds the position, new content fills it before the chat follows.
    if (hold === 'up') nearBottom = false;
    else if (hold === 'free' && chatScroll)
      // Only follow at the end. A reading position just above it is still deliberate.
      nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 2;
    followedHeight = chatColumn?.getBoundingClientRect().height ?? 0;
    showJump();
  }
  // Returns to the end and follows it again, as scrolling there does.
  function jumpToEnd(event: MouseEvent) {
    nearBottom = true;
    jumpShown = false;
    virtualSpace?.clear();
    void scrollToEnd();
    // A key press leaves no button to keep focus on: continue in the composer.
    if (!event.detail) composerInput?.focus();
  }
  // A message sent at the end glides there instead of jumping: each frame covers a share of
  // the distance left, so content arriving meanwhile speeds the glide up rather than making
  // it jump. Until it ends, the paths that keep a followed chat at its end leave the
  // scrolling to it, and the reader's own wheel, pointer or keys, or any scroll the glide did
  // not make, end it where it is.
  let glide:
    | { conversation: string; frame: number; at: number; start: number; top: number }
    | undefined;
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stickToEnd(scroll: HTMLElement) {
    if (glide) return;
    scroll.scrollTop = scroll.scrollHeight;
    scrolledTo = { scroll, top: scroll.scrollTop };
  }
  function startGlide(conversation: string) {
    if (glide?.conversation !== conversation || glide.frame || !chatScroll) return;
    glide.at = glide.start = performance.now();
    glide.top = chatScroll.scrollTop;
    glide.frame = requestAnimationFrame(glideFrame);
  }
  function glideFrame(now: number) {
    const current = glide,
      scroll = chatScroll;
    if (!current) return;
    if (!scroll?.isConnected) {
      glide = undefined;
      return;
    }
    if (Math.abs(scroll.scrollTop - current.top) >= 1) {
      takeOver();
      return;
    }
    const gap = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
    // Output that keeps arriving cannot hold the glide open; following takes over from it.
    if (gap < 1 || now - current.start > 700) {
      glide = undefined;
      stickToEnd(scroll);
      return;
    }
    const share = 1 - Math.exp(-Math.max(0, now - current.at) / 80);
    current.at = now;
    // At least a pixel a frame, so rounding cannot stall the last few.
    scroll.scrollTop += Math.max(gap * share, Math.min(gap, 1));
    current.top = scroll.scrollTop;
    current.frame = requestAnimationFrame(glideFrame);
  }
  function stopGlide() {
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    glide = undefined;
  }
  function takeOver() {
    holdPlace(undefined);
    if (!glide) return;
    stopGlide();
    readingPosition();
  }
  $effect(() => {
    if (!chatScroll || !chatColumn || !chatSpace) return;
    // Expanding or collapsing content keeps the chat in place.
    const space = createVirtualSpace(chatScroll, chatColumn, chatSpace, readingPosition);
    virtualSpace = space;
    return () => {
      space.destroy();
      if (virtualSpace === space) virtualSpace = undefined;
    };
  });
  $effect(() => {
    void activeId;
    untrack(() => virtualSpace?.clear());
    followedHeight = 0;
    // Another chat opens where the reader left it.
    jumpShown = false;
    if (glide && glide.conversation !== activeId) stopGlide();
    untrack(showPlace);
  });
  $effect(() => {
    const scroll = chatScroll;
    if (!scroll) return;
    // Passive, so a busy main thread never delays the start of a scroll.
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return;
      if (event.deltaY < 0) nearBottom = false;
      takeOver();
    };
    scroll.addEventListener('wheel', wheel, { passive: true });
    scroll.addEventListener('pointerdown', takeOver, { passive: true });
    scroll.addEventListener('keydown', takeOver);
    return () => {
      scroll.removeEventListener('wheel', wheel);
      scroll.removeEventListener('pointerdown', takeOver);
      scroll.removeEventListener('keydown', takeOver);
      stopGlide();
    };
  });
  $effect(() => {
    const scroll = chatScroll,
      area = composerArea;
    if (!scroll || !area) return;
    let height = 0;
    const observer = new ResizeObserver(() => {
      const next = scroll.clientHeight;
      if (next === height) return;
      // Usage details open over the conversation, so they must fit in what remains of it.
      area.style.setProperty('--chat-height', `${next}px`);
      // A growing draft, a smaller window or a phone keyboard shortens the chat from below.
      // While following, keep its end in view instead of pushing it under the composer.
      if (next < height && nearBottom) {
        virtualSpace?.trim();
        stickToEnd(scroll);
      }
      height = next;
      showJump();
    });
    observer.observe(scroll);
    return () => observer.disconnect();
  });
  $effect(() => {
    const scroll = chatScroll,
      column = chatColumn;
    if (!scroll || !column) return;
    // Content that sizes itself after it renders, such as a visual reporting its height, grows
    // the conversation below the reader. While following, keep its end in view. A toggle updates
    // following in an animation frame, before resize observers run, so what it reveals is not
    // followed.
    let height = 0;
    const observer = new ResizeObserver(() => {
      const next = column.getBoundingClientRect().height;
      const grew = next > height;
      height = next;
      if (grew && nearBottom) {
        virtualSpace?.trim();
        stickToEnd(scroll);
        followedHeight = next;
      } else if (heldPlace && !nearBottom) keepPlace();
      // Replies arriving below a reading position move the end away without a scroll.
      showJump();
    });
    observer.observe(column);
    return () => observer.disconnect();
  });
  // Another chat, a new one, Connections, Settings, a screen or a workflow replaces the chat on
  // screen, so the window recalls where its reader was before it goes (requested 2026-11-03):
  // nowhere while they followed its end, else the place being read.
  let placedChat: string | null = null;
  $effect.pre(() => {
    const next = panelChat;
    untrack(() => {
      const left = placedChat;
      placedChat = next;
      if (!left || left === next) return;
      holdPlace(undefined);
      const scroll = chatScroll,
        column = chatColumn;
      if (!scroll?.isConnected || !column) return;
      // A chat deleted while shown is forgotten.
      if (!workspace.conversations.some((c) => c.id === left)) return;
      const place = nearBottom ? undefined : readPlace(scroll, column);
      recalled(recallOf(left), 'chat').set('place', place);
    });
  });
  // Shows the chat on screen as the reader left it in this window: at the place they were
  // reading above its end, or else at its end, following it.
  function showPlace() {
    const scroll = chatScroll,
      column = chatColumn;
    if (!scroll || !column) return;
    holdPlace(undefined);
    const place =
      activeId && view === 'chat'
        ? recalled(recalls.get(activeId), 'chat').get<ChatPlace>('place')
        : undefined;
    const found = place && findPlace(scroll, column, place);
    if (!found) {
      nearBottom = true;
      void scrollToEnd();
      return;
    }
    holdAnchor(scroll, found.anchor);
    scrolledTo = { scroll, top: scroll.scrollTop };
    readingPosition();
    if (found.complete) {
      if (!nearBottom) holdPlace({ anchor: found.anchor });
      return;
    }
    // The rest of the place arrives later, so the chat waits for it, even at an end it reached
    // without it.
    nearBottom = false;
    showJump();
    holdPlace({ anchor: found.anchor, place });
  }
  // Without scroll anchoring, as in WebKit, content above the place that sizes itself after the
  // chat came back would move the reader. What the place was in can arrive later too, as when
  // the Viewer reads a chat it holds light whole again.
  function keepPlace() {
    const scroll = chatScroll,
      column = chatColumn;
    if (!scroll || !column || !heldPlace) return;
    const found = heldPlace.place && findPlace(scroll, column, heldPlace.place);
    if (found?.complete) holdPlace({ anchor: found.anchor });
    if (!heldPlace.anchor.element.isConnected) holdPlace(undefined);
    else if (holdAnchor(scroll, heldPlace.anchor)) scrolledTo = { scroll, top: scroll.scrollTop };
  }
  // The chat mounts again at its top, as after Connections or Settings.
  $effect(() => {
    if (!chatScroll || !chatColumn) return;
    untrack(showPlace);
  });
  let saveQueue = Promise.resolve();
  const active = $derived(workspace.conversations.find((c) => c.id === activeId));
  // The scratch chat shown, while no conversation is: a new chat, or a workflow chat.
  const currentScratch = $derived(!active ? scratches.find((s) => s.id === scratchId) : undefined);
  const subagentReply = $derived(
    subagentView ? active?.messages.find((m) => m.id === subagentView.messageId) : undefined,
  );
  // The side panel closes when its reply no longer holds the sub-agent, as after a rewind.
  const subagentShown = $derived(
    !!subagentView &&
      !!subagentReply &&
      !!findSubagent(replyTools(subagentReply), subagentView.agentId),
  );
  // The sub-agents of replies a running reply took over, which it waits for while they run.
  const carriedWork = $derived(active ? carriedSubagents(active.messages) : undefined);
  // The shells a console on this computer runs for the open chat, which is where its code
  // blocks offer Run in console. A chat another computer runs, and the Viewer, only copy them.
  const consoles = $derived(
    desktop() ? consoleShells(workspace.fleet, installation, active).join(' ') : '',
  );
  function codeBlockClick(event: MouseEvent) {
    // An artifact a reply shows in place of its code opens in the viewer or beside the chat.
    const card = artifactCardAction(event.target);
    if (card) {
      if (card.button.closest('a')) {
        event.preventDefault();
        event.stopPropagation();
      }
      openArtifact(card.artifact, card.mode);
      return;
    }
    const action = codeBlockAction(event.target);
    if (!action) return;
    // A block's controls never follow a link a reply wrapped around the block.
    if (action.button.closest('a')) {
      event.preventDefault();
      event.stopPropagation();
    }
    const chat = active;
    void performCodeBlockAction(action, (shell, code) => {
      if (!chat) throw new Error('Open the chat this code belongs to, then run it again.');
      return runInConsole(chat.settings, chat.id, chat.location, shell, code);
    });
  }
  const selectedSettings = $derived(active?.settings ?? draftSettings);
  const imagesSupported = $derived(supportsImages(selectedSettings.provider));
  const selectedLocation = $derived(
    locationPending ? undefined : active ? active.location : draftLocation,
  );
  const computers = $derived(computerViews(workspace.fleet));
  function locationComputerId(location: ChatLocation) {
    const environment = locationExecutionEnvironment(workspace.fleet, location);
    return environment ? computerViewId(environment) : location.computerId;
  }
  const selectedComputerId = $derived(
    selectedLocation ? locationComputerId(selectedLocation) : draftComputerId,
  );
  const selectedComputer = $derived(computers.find((c) => c.id === selectedComputerId));
  const selectedComputerOffline = $derived(
    !!selectedComputer && !computerOnline(selectedComputer.id),
  );
  const computerEnvironments = $derived(
    computerFolderEnvironments(workspace.fleet, selectedComputerId),
  );
  const selectedExecutionEnvironment = $derived(
    selectedComputer?.environments.find(
      (e) =>
        e.id ===
        (selectedLocation
          ? locationExecutionId(selectedLocation)
          : selectedConnection?.environmentId),
    ) ?? selectedComputer?.environments[0],
  );
  const savedLocations = $derived(knownLocations(workspace, selectedComputerId));
  const standaloneChoice = $derived(standaloneLocation(selectedComputerId));
  const scopedConnections = $derived(
    selectedLocation
      ? locationConnections(workspace.fleet, selectedLocation)
      : workspace.fleet.connections.filter((c) =>
          selectedComputer?.environments.some((e) => e.id === c.environmentId),
        ),
  );
  const availableProviders = $derived(
    providerIds.filter((provider) =>
      scopedConnections.some(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          canChooseConnection(c.id),
      ),
    ),
  );
  // Every account's color: those the workspace keeps, and one for each account that has none
  // yet, which is saved so the account keeps it on every device.
  const assignedColors = $derived(
    assignAccountColors(
      workspace.accountColors,
      workspace.fleet.accounts,
      workspace.fleet.connections,
    ),
  );
  const colorsByAccount = $derived(accountColorIndex(assignedColors));
  $effect(() => {
    const assigned = assignedColors;
    if (!loaded || assigned === workspace.accountColors) return;
    untrack(() => {
      workspace.accountColors = assigned;
      void persistSettings().catch(() => {});
    });
  });
  /** The color of the account a connection signs in to, as styles read it. */
  function connectionColor(connectionId: string | undefined) {
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    return connection
      ? accountColorValue(colorsByAccount.get(connection.accountId)?.color)
      : undefined;
  }
  const agentOptions = $derived.by(() => {
    const preview = !desktop() && !paired && !selectedComputer;
    return providerIds.flatMap((provider) => {
      // A saved chat keeps its agent; only that agent's accounts on its computer are offered.
      if (active && provider !== selectedSettings.provider) return [];
      const candidates = scopedConnections.filter(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          (canChooseConnection(c.id) || (!!active && c.id === selectedSettings.connectionId)),
      );
      // Saved chats retain their fixed agent; drafts only offer this computer's available CLIs.
      if (!preview && !candidates.length && !(active && provider === selectedSettings.provider))
        return [];
      const base = { mark: providers[provider].mark, color: providers[provider].color };
      // An account to sign in to says so, and choosing it also opens Connections at it.
      const signIn = (attention: boolean) => ({
        attention,
        title: attention ? 'Choosing this account opens Connections to sign in to it' : undefined,
      });
      if (candidates.length > 1)
        return candidates.map((c) => {
          const attention = needsSignIn(c.id);
          return {
            ...base,
            id: `connection:${c.id}`,
            provider,
            connectionId: c.id,
            name: `${providers[provider].name} · ${workspace.fleet.accounts.find((a) => a.id === c.accountId)?.name ?? 'Account'}`,
            // Named accounts are marked in their own color, in the list and on the trigger.
            fill: connectionColor(c.id),
            detail: attention
              ? 'Sign-in needed'
              : connectionStatus(c.id)?.installed
                ? undefined
                : canChooseConnection(c.id)
                  ? 'Checking availability…'
                  : 'Unavailable connection',
            ...signIn(attention),
          };
        });
      const attention = candidates.length === 1 && needsSignIn(candidates[0].id);
      return [
        {
          ...base,
          id: provider,
          provider,
          connectionId: candidates[0]?.id,
          name: providers[provider].name,
          fill: undefined,
          detail:
            selectedLocation && !availableProviders.includes(provider)
              ? 'Unavailable on this computer'
              : candidates.some((c) => !connectionStatus(c.id))
                ? 'Checking availability…'
                : attention
                  ? 'Sign-in needed'
                  : undefined,
          ...signIn(attention),
        },
      ];
    });
  });
  const selectedAgentOption = $derived(
    agentOptions.find(
      (option) =>
        option.provider === selectedSettings.provider &&
        option.connectionId === selectedSettings.connectionId,
    )?.id ?? (active ? selectedSettings.provider : ''),
  );
  // The selected account when the picker names it, with the color that marks it.
  const selectedAccount = $derived.by(() => {
    const option = agentOptions.find((option) => option.id === selectedAgentOption);
    return option?.fill ? { name: option.name, mark: option.mark, color: option.fill } : undefined;
  });
  let agentPickerOpen = $state(false);
  // Opening the Agent picker checks the sign-in of the Claude and Codex accounts it lists on
  // this computer.
  $effect(() => {
    if (!agentPickerOpen) return;
    untrack(() => {
      void recheckConnections(
        agentOptions.flatMap((option) => (option.connectionId ? [option.connectionId] : [])),
      );
    });
  });
  // While open, it reads the usage of every account it lists that can be read, also one whose
  // check finishes meanwhile, for the bars beside them. A reading renews a Claude login and so
  // also finds one that expired since; readings are kept for a minute, so reopening stays cheap.
  const readableAccounts = $derived(
    agentPickerOpen
      ? agentOptions.flatMap(({ provider, connectionId }) =>
          connectionId && canQueryConnection(connectionId, provider)
            ? [{ provider, connectionId }]
            : [],
        )
      : [],
  );
  const readableAccountsKey = $derived(readableAccounts.map((a) => a.connectionId).join(' '));
  $effect(() => {
    const key = readableAccountsKey;
    if (key)
      untrack(() => {
        for (const { provider, connectionId } of readableAccounts)
          void refreshUsage({ provider, model: '', connectionId });
      });
  });
  // A listed account's 5-hour and weekly usage, as the bars below the composer show it: while
  // its first reading loads, and afterwards as last reported when it can no longer be read. An
  // account to sign in to says so instead.
  function listedUsage(id: string) {
    const option = agentOptions.find((option) => option.id === id);
    if (!option?.connectionId || option.attention) return undefined;
    const settings = { provider: option.provider, model: '', connectionId: option.connectionId };
    const key = usageKey(settings);
    const snapshot = snapshotFor(usageSnapshots, settings);
    const ready = canQueryConnection(option.connectionId, option.provider);
    if (!snapshot && !ready) return undefined;
    return {
      provider: option.provider,
      snapshot,
      loading: !!usageLoading[key] || (ready && !snapshot && !usageErrors[key]),
      failed: !!usageErrors[key] || !ready,
    };
  }
  // Balancing (Settings → New chats, `src/lib/account-balance.ts`): a new chat starts on the
  // account of its agent, on its computer, that has used the least, until an account is chosen
  // for it. It is balanced between the accounts that can answer and were not left out there:
  // every one that can be chosen while their checks run, then those reported ready.
  const balanceCandidates = $derived.by(() => {
    if (!loaded || active || !draftBalanced || !workspace.preferences.balanceAccounts) return [];
    const excluded = new Set(workspace.preferences.balanceExcluded);
    const choosable = locationConnections(
      workspace.fleet,
      selectedLocation,
      selectedSettings.provider,
    ).filter(
      (c) => !excluded.has(c.accountId) && canChooseConnection(c.id) && !needsSignIn(c.id),
    );
    const ready = choosable.filter((c) => connectionStatus(c.id)?.auth === 'ready');
    return ready.length && choosable.every((c) => connectionStatus(c.id)) ? ready : choosable;
  });
  // Each of those accounts with its latest reading, and whether its check or first reading is
  // still under way.
  function balanceReadings() {
    const provider = selectedSettings.provider;
    return balanceCandidates.map((connection) => {
      const settings = { provider, model: '', connectionId: connection.id };
      const key = usageKey(settings);
      const snapshot = snapshotFor(usageSnapshots, settings);
      const readable = canQueryConnection(connection.id, provider);
      return {
        connection,
        settings,
        snapshot,
        readable,
        waiting:
          !connectionStatus(connection.id) ||
          (readable && (!!usageLoading[key] || (!snapshot && !usageErrors[key]))),
      };
    });
  }
  // Reads the usage of the accounts the open new chat is balanced between. Readings are kept for
  // a minute, so new chats opened one after another read them once.
  function refreshBalance() {
    for (const { readable, settings } of balanceReadings())
      if (readable) void refreshUsage(settings);
  }
  // New chats whose account was chosen with a reading of every account in hand. Such a choice
  // stays while no other account is better by more than the tolerance, and while a draft waits
  // under it.
  const balanceSettled = new Set<string>();
  // The new chat whose account was chosen from what was known as it opened, and the chat and
  // accounts whose readings were last asked for.
  let balanceChosen = '';
  let balanceRead = '';
  const draftFilled = $derived(prompt !== '' || attachedImages.length > 0);
  $effect(() => {
    if (!balanceCandidates.length) return;
    const id = scratchId;
    // Asked once as the chat opens, and again as its accounts' checks make them readable.
    const read = `${id} ${balanceReadings()
      .filter((reading) => reading.readable)
      .map((reading) => reading.connection.id)
      .join(' ')}`;
    untrack(() => {
      if (read === balanceRead) return;
      balanceRead = read;
      refreshBalance();
    });
    // Runs again as a check or a reading arrives, the draft empties or the picker closes.
    const readings = balanceReadings();
    const draft = { picking: agentPickerOpen, filled: draftFilled, mentions: hasComposerMentions };
    untrack(() => chooseBalanced(id, readings, draft));
  });
  function chooseBalanced(
    id: string,
    readings: ReturnType<typeof balanceReadings>,
    draft: { picking: boolean; filled: boolean; mentions: boolean },
  ) {
    const settled = balanceSettled.has(id);
    const current = selectedSettings.connectionId;
    // The picker's list stays as it is under the pointer. A settled choice moves only in an
    // empty draft; the first one also applies to a draft carried into the chat, short of
    // mentions chosen under its account.
    if (draft.picking || (settled ? draft.filled : draft.mentions)) return;
    const waiting = readings.some((reading) => reading.waiting);
    // Chosen already, or nothing is known of the accounts yet, as when the app starts: the
    // readings under way decide, all of them together.
    if (
      waiting &&
      (settled || balanceChosen === id || !readings.some((reading) => reading.snapshot)) &&
      readings.some((reading) => reading.connection.id === current)
    )
      return;
    const accounts = new Map(workspace.fleet.connections.map((c) => [c.id, c.accountId]));
    const activity = accountActivity(workspace.conversations, (connectionId) =>
      accounts.get(connectionId),
    );
    const choice = balancedAccount(
      readings.map(({ connection, snapshot }) => ({
        connectionId: connection.id,
        snapshot,
        running: activity.get(connection.accountId)?.running ?? 0,
        lastUsed: activity.get(connection.accountId)?.lastUsed ?? 0,
      })),
      { provider: selectedSettings.provider, model: selectedSettings.model },
      Date.now(),
      settled ? current : undefined,
    );
    if (waiting) balanceChosen = id;
    else balanceSettled.add(id);
    if (!choice || choice === current) return;
    // Like any change of settings, it ends a folder's late check of this chat's old ones.
    settingsRevision++;
    draftSettings = { ...draftSettings, connectionId: choice };
  }
  // The open new chat compares its accounts from the start, as on another computer.
  function balanceAfresh() {
    balanceSettled.delete(scratchId);
    if (balanceChosen === scratchId) balanceChosen = '';
  }
  // Whether the open new chat follows balancing, which its scratch chat keeps for its return.
  function followBalance(follows: boolean) {
    if (follows) balanceAfresh();
    draftBalanced = follows;
    const scratch = scratches.find((s) => s.id === scratchId);
    if (scratch) scratch.balanced = follows;
  }
  /** Settings → New chats: whether new chats start on the least used account of their agent. */
  async function setBalanceAccounts(enabled: boolean) {
    if (!loaded) throw new Error('The workspace is still loading.');
    const preferences = workspace.preferences;
    const before = preferences.balanceAccounts;
    const set = (value: boolean | undefined) => {
      if (value) preferences.balanceAccounts = true;
      else delete preferences.balanceAccounts;
    };
    set(enabled);
    try {
      await persistLocal();
    } catch {
      set(before);
      throw new Error('The setting could not be saved.');
    }
    // The new chat that is open follows it at once, unless something was written in it.
    if (!activeId && scratchId && (!enabled || !draftFilled)) followBalance(enabled);
  }
  // The accounts balancing can choose between somewhere, for Settings, which leaves any of them
  // out: agent by agent, as the Agent picker lists them. Two accounts of an agent under one name
  // are told apart by their computers.
  const balanceChoices = $derived.by(() => {
    const excluded = new Set(workspace.preferences.balanceExcluded);
    const accounts = balanceableAccounts(workspace.fleet)
      .map((account) => ({
        ...account,
        label: `${providers[account.provider].name} · ${account.name}`,
      }))
      .sort((a, b) => providerIds.indexOf(a.provider) - providerIds.indexOf(b.provider));
    const computerOf = (environmentId: string) =>
      computers.find((c) => c.environments.some((e) => e.id === environmentId))?.name;
    return accounts.map(({ id, label, environmentIds }) => ({
      id,
      name: label,
      color: accountColorValue(colorsByAccount.get(id)?.color),
      where: accounts.some((other) => other.id !== id && other.label === label)
        ? environmentIds.map(computerOf).filter(Boolean).join(', ')
        : '',
      included: !excluded.has(id),
    }));
  });
  /** Settings → New chats: whether balancing may start new chats on an account. */
  async function setBalanceIncluded(accountId: string, included: boolean) {
    if (!loaded) throw new Error('The workspace is still loading.');
    const preferences = workspace.preferences;
    const before = preferences.balanceExcluded;
    // An account that is gone leaves the list with the next change.
    const known = new Set(workspace.fleet.accounts.map((a) => a.id));
    const excluded = (before ?? []).filter((id) => id !== accountId && known.has(id));
    if (!included) excluded.push(accountId);
    const set = (value: string[] | undefined) => {
      if (value?.length) preferences.balanceExcluded = value;
      else delete preferences.balanceExcluded;
    };
    set(excluded);
    try {
      await persistLocal();
    } catch {
      set(before);
      throw new Error('The setting could not be saved.');
    }
  }
  // A chat's account connection, whether another computer runs it, and its reported status.
  function replyConnection(settings: Pick<ChatSettings, 'provider' | 'connectionId'>) {
    const connection = workspace.fleet.connections.find((c) => c.id === settings.connectionId);
    const host = connection && executionHost(workspace.fleet, connection.environmentId);
    const remote = !!connection && host !== installation?.id;
    const status = settings.connectionId
      ? remote
        ? presence
            .find((p) => p.environmentId === host && p.online)
            ?.connections.find((c) => c.connectionId === settings.connectionId)
        : connectionStatuses[settings.connectionId]
      : statusFor(settings.provider);
    return { connection, remote, status };
  }
  const selectedReplyConnection = $derived(replyConnection(selectedSettings));
  const selectedConnection = $derived(selectedReplyConnection.connection);
  const selectedRemote = $derived(selectedReplyConnection.remote);
  const selectedStatus = $derived(selectedReplyConnection.status);
  // This computer could not check the selected account, which is then unverified, not missing.
  const selectedCheckFailed = $derived(
    !!selectedStatus && 'checkFailed' in selectedStatus && !!selectedStatus.checkFailed,
  );

  const selectedUsageKey = $derived(usageKey(selectedSettings));
  const selectedUsage = $derived(snapshotFor(usageSnapshots, selectedSettings));
  // Whether the selected account's first reading is under way or due, which its bars below the
  // composer wait for as Checking…; a reading then says which limits it has, and only those
  // show. One that failed leaves none waiting while it is tried again.
  const selectedUsageChecking = $derived.by(() => {
    if (usageErrors[selectedUsageKey] || (selectedUsage && !selectedUsage.partial)) return false;
    const { provider, connectionId } = selectedSettings;
    if (usageLoading[selectedUsageKey] || canQueryConnection(connectionId, provider)) return true;
    // An account here is read as soon as its check answers.
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    return (
      !!connection &&
      desktop() &&
      executionHost(workspace.fleet, connection.environmentId) === installation?.id &&
      !connectionStatuses[connection.id]
    );
  });
  const accountUsageTargets = $derived.by(() =>
    workspace.fleet.connections.flatMap((connection) => {
      const account = workspace.fleet.accounts.find((a) => a.id === connection.accountId);
      const host = executionHost(workspace.fleet, connection.environmentId);
      const status =
        host === installation?.id
          ? connectionStatuses[connection.id]
          : paired
            ? presence
                .find((p) => p.environmentId === host && p.online)
                ?.connections.find((c) => c.connectionId === connection.id)
            : undefined;
      return account && status?.installed && status.auth === 'ready'
        ? [{ provider: account.provider, model: '', connectionId: connection.id }]
        : [];
    }),
  );
  const accountUsageTargetKey = $derived(accountUsageTargets.map(usageKey).sort().join('|'));
  $effect(() => {
    const key = accountUsageTargetKey;
    if (loaded && view === 'connections' && key) untrack(() => void refreshAccountUsage());
  });
  const selectedConnectionAvailable = $derived(canQueryConnection(selectedSettings.connectionId));
  // The selected account is read when chosen and again once its check finds it ready, as at
  // startup, so its bars do not wait for the next minute's reading.
  $effect(() => {
    const provider = selectedSettings.provider;
    const model = selectedSettings.model;
    const connectionId = selectedSettings.connectionId;
    const available = selectedConnectionAvailable;
    if (loaded && view === 'chat' && available)
      untrack(() => void refreshUsage({ provider, model, connectionId }));
  });
  const selectedModelScope = $derived(modelScopeKey(selectedSettings));
  const selectedModelReady = $derived(!!active || !!selectedLocation);
  $effect(() => {
    const key = selectedModelScope;
    const ready = selectedModelReady;
    const available = selectedConnectionAvailable;
    if (loaded)
      untrack(() => {
        models = modelCache.get(key)?.catalog ?? structuredClone(fallbackModels);
        if (ready && available) void refreshModels(false);
        else {
          ++modelGeneration;
          modelsLoading = false;
          if (notice === modelRefreshWarning) notice = '';
        }
      });
  });
  const selectedAgent = $derived({
    ...selectedSettings,
    name: providers[selectedSettings.provider].name,
  });
  const availableModels = $derived(
    modelChoices(models, selectedSettings.provider, selectedSettings.model),
  );
  // Each choice's mark: its line's illustration and its version, so lines and versions differ
  // at a glance.
  const modelMarks = $derived(
    new Map(
      availableModels.map((model) => [
        model.id,
        modelMark(selectedSettings.provider, model.name.replace(/^CLI default\s*·\s*/, '')),
      ]),
    ),
  );
  const selectedModelMark = $derived(
    modelMark(selectedSettings.provider, selectedModelName(selectedSettings.model, availableModels)),
  );
  const currentModel = $derived(
    availableModels.find((model) => model.id === selectedSettings.model)!,
  );
  // Fast mode belongs to the models that offer it; a chat keeps its choice while another model
  // is selected, as the CLIs do.
  const fastOffered = $derived(
    (selectedSettings.provider === 'claude' || selectedSettings.provider === 'codex') &&
      !!currentModel.fastMode,
  );
  const reasoningOptions = $derived(
    reasoningScale(currentModel.reasoningLevels, selectedSettings.reasoning).map((id) => ({
      id,
      name: reasoningName(id),
    })),
  );
  const recent = $derived(
    [...workspace.conversations]
      // A workflow's chats stay with their workflow.
      .filter((c) => !hiddenChats.has(c.id))
      .filter((c) =>
        `${c.title} ${providers[c.settings.provider].name} ${c.location?.path ?? ''} ${computers.find((computer) => computer.id === (c.location ? locationComputerId(c.location) : ''))?.name ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
  // Scratch chats with unsent content, newest first. Typing reads their titles only while searching.
  const sidebarScratches = $derived.by(() => {
    const search = query.toLowerCase();
    return scratches
      .filter(
        (s) =>
          s.filled &&
          !s.workflow &&
          (!search ||
            `${s.title} ${s.location?.path ?? ''} ${computers.find((computer) => computer.id === (s.location ? locationComputerId(s.location) : s.computerId))?.name ?? ''}`
              .toLowerCase()
              .includes(search)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  });
  // History names session days, and a chat its days, from today, which moves on at midnight.
  let today = $state(startOfDay(Date.now()));
  // Chats pinned to the top of the tab they are in, Active or History.
  const pinsByChat = $derived(pinIndex(workspace.pins));
  const conversationGroups = $derived(
    groupConversations(
      recent,
      workspace.fleet,
      installation,
      sidebarScratches,
      workspace.appSessions,
      today,
      pinsByChat,
    ),
  );
  const iconsByFolder = $derived(folderIconIndex(workspace.folderIcons));
  // The icon of each folder the Folder picker lists, by its choice's id; read only while it is open.
  const folderChoiceIcons = $derived(
    new Map(
      [...savedLocations, ...(selectedLocation ? [selectedLocation] : [])].map((location) => [
        locationKey(location),
        folderIconOf(iconsByFolder, location)?.icon,
      ]),
    ),
  );
  // Chats snoozed until the app starts again. From the next start they wait at the top of the
  // Active tab until they are opened, snoozed again or closed.
  const snoozesByChat = $derived(snoozeIndex(workspace.snoozes));
  const lastStart = $derived(latestStart(workspace.appSessions));
  const snoozedChats = $derived.by(() => {
    const chats = new Map<string, Conversation>();
    if (snoozesByChat.size)
      for (const c of workspace.conversations) if (snoozesByChat.has(c.id)) chats.set(c.id, c);
    return chats;
  });
  const dueChats = $derived(
    dueSnoozes(workspace.snoozes, (id) => snoozedChats.get(id), lastStart).map((due) => due.chat),
  );
  // While searching, the Active tab lists the snoozed chats the search matches.
  const listedSnoozes = $derived.by(() => {
    if (!query || !dueChats.length) return dueChats;
    const matched = new Set(recent.map((c) => c.id));
    return dueChats.filter((c) => matched.has(c.id));
  });
  const snoozeOf = (c: Conversation) => snoozeState(snoozesByChat.get(c.id), c, lastStart);
  const heldChat = (id: string) => workspace.conversations.find((c) => c.id === id);
  const pendingChats = $derived(
    pendingChatCount(workspace.conversations.filter((c) => !hiddenChats.has(c.id))),
  );
  // Chats whose reply finished while the reader was elsewhere keep a dot in the sidebar until
  // they are opened. Reading state belongs to this window: never saved, exported or synced.
  let finishedChats = $state<FinishedChats>({});
  let observeFinishedChats = createFinishedChatTracker();
  function noteFinishedChats() {
    finishedChats = observeFinishedChats(
      workspace.conversations,
      finishedChats,
      view === 'chat' ? (activeId ?? undefined) : undefined,
    );
  }
  // The conversation on screen is read, including one whose reply ended while Connections,
  // Settings or a scratch chat was open.
  $effect(() => {
    const id = view === 'chat' ? activeId : null;
    if (id && untrack(() => finishedChats[id])) delete finishedChats[id];
  });
  // The newest, as a reply that takes over another runs beside it until that one ends.
  const observedReply = $derived(
    active?.messages.findLast((m) => m.role === 'assistant' && m.status === 'running'),
  );
  // It only waits for background work, so a message sent now goes at once.
  const waitingReply = $derived(
    active ? takeOverTarget(active, takeOverRefused, heardWaits) : undefined,
  );
  const activeRunning = $derived((!!activeId && !!runs[activeId]) || !!observedReply);
  const activeStopping = $derived(!!activeId && !!stopping[activeId]);
  const activeSteering = $derived(
    !!observedReply?.runId && !!steeringPending[observedReply.runId],
  );
  // A reply this window started is running in any conversation.
  const localRunning = $derived(Object.keys(runs).length > 0);
  // Background work this computer still runs for each chat, including after its reply.
  let hostBackground = $state<Record<string, HostBackgroundWork>>({});
  function applyBackgroundWork(event: BackgroundWorkEvent) {
    if (event.kind === 'snapshot') {
      if (event.runs.length)
        hostBackground[event.conversationId] = { runs: event.runs, at: Date.now() };
      else delete hostBackground[event.conversationId];
      return;
    }
    // A task that finished after its reply ended records its outcome in that reply, as do the
    // sub-agents and workflows of a reply that handed its process to the next message.
    const reply = workspace.conversations
      .find((c) => c.id === event.conversationId)
      ?.messages.find((m) => m.role === 'assistant' && m.runId === event.runId);
    if (!reply) return;
    const clock =
      event.kind === 'workflow'
        ? applyRunEvent(reply, { kind: 'nativeworkflow', nativeWorkflows: event.nativeWorkflows })
        : applyRunEvent(reply, { kind: 'tool', tool: event.tool });
    // Outcomes are saved at once; sub-agents' progress goes out with the next sync and save, and
    // a task's running time without hurry.
    if (clock) {
      localChanges++;
      marks.quiet(event.conversationId, reply.id);
    } else if (
      (event.kind === 'tool' && !event.tool.parentId && event.tool.status !== 'running') ||
      Date.now() - earlierSavedAt >= streamSaveInterval()
    ) {
      earlierSavedAt = Date.now();
      saveSoon(event.conversationId, reply.id);
    } else {
      localChanges++;
      marks.chat(event.conversationId, reply.id);
    }
  }
  let earlierSavedAt = 0;
  // A chat whose reply ended stays active while its monitors run, until each reports its
  // outcome or its process is released.
  const runningMonitors = (conversationId: string) =>
    hostBackground[conversationId]?.runs.filter((run) => run.kind === 'monitor').length ?? 0;
  // What a sidebar row adds to its chat's title, on hover and for assistive technology.
  function rowNotes(
    finished: boolean,
    monitors: number,
    plan?: { count: number; complete: number; total: number },
    snoozed = false,
  ): string[] {
    return [
      ...(plan ? [planCountText(plan, 'plan step')] : []),
      ...(finished ? ['New reply'] : []),
      ...(monitors === 1 ? ['Monitor still running'] : []),
      ...(monitors > 1 ? [`${monitors} monitors still running`] : []),
      ...(snoozed ? ['Snoozed'] : []),
    ];
  }
  const switchNotices = $derived(
    replySwitches(active?.messages ?? [], (id) => accountName(workspace.fleet, id)),
  );
  const accountSwitches = $derived(replyAccountSwitches(active?.messages ?? []));
  // Other accounts of this chat's agent on its computer that may take the next reply.
  // Claude and Codex conversations start a fresh native session for the new account.
  const switchableConnections = $derived(
    active && (selectedSettings.provider === 'claude' || selectedSettings.provider === 'codex')
      ? scopedConnections.filter(
          (c) =>
            c.id !== selectedSettings.connectionId &&
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider ===
              selectedSettings.provider &&
            canChooseConnection(c.id),
        )
      : [],
  );
  const lastReplyConnection = $derived(
    active?.messages.findLast((m) => m.role === 'assistant' && !!m.settings?.connectionId)
      ?.settings?.connectionId,
  );
  // Another account takes the next message, also when chosen while a reply runs: that reply
  // finishes on its own account.
  const accountSwitchPending = $derived(
    !!active &&
      !!lastReplyConnection &&
      !!selectedSettings.connectionId &&
      lastReplyConnection !== selectedSettings.connectionId,
  );
  const timeTotals = $derived(replyTimeTotals(active?.messages ?? []));
  // A chat from another day, or continued on one, shows where each of its days begins.
  const dayStarts = $derived(chatDays(active?.messages ?? [], today));
  const chatChanges = $derived(
    separateMemory(summarizeFileChanges((active?.messages ?? []).filter((m) => !m.filesUndone))),
  );
  // The model and reasoning the next message changes from the running reply's; another account
  // is named apart (`accountSwitchPending`).
  const nextReplyChanged = $derived(
    !!observedReply?.settings &&
      replySettingsChanged(observedReply.settings, {
        ...selectedSettings,
        connectionId: observedReply.settings.connectionId,
      }),
  );
  // A chat a workflow run started is the workflow's to drive: it is read here, never written in.
  const readOnlyChat = $derived(!!active && workflows.readOnly(active.id));
  const canSend = $derived(
    loaded &&
      !readOnlyChat &&
      !historyBusy &&
      !historyAction &&
      !imagesLoading &&
      !imagesSending &&
      (!attachedImages.length || imagesSupported) &&
      !selectingLocation &&
      !locationPending &&
      (!selectedLocation ||
        selectedSettings.connectionId ||
        executionHost(workspace.fleet, selectedLocation.environmentId) === installation?.id) &&
      (!!selectedLocation || !!active) &&
      (!selectedLocation ||
        (!!active && !selectedLocation.path) ||
        scopedConnections.some((c) => c.id === selectedSettings.connectionId)) &&
      !activeRunning &&
      (desktop() || paired) &&
      (desktop() || online) &&
      (!selectedRemote || (paired && !syncError)) &&
      !!selectedStatus?.installed &&
      selectedStatus.auth === 'ready',
  );
  const activeQueue = $derived(activeId ? (queued[activeId] ?? []) : []);
  const canCompact = $derived(canSend && !active?.rewind && !!active?.messages.some(m => m.role === 'assistant') &&
    ['claude', 'codex'].includes(selectedSettings.provider) &&
    active?.messages.findLast(m => m.role === 'assistant')?.settings?.connectionId === selectedSettings.connectionId);
  const steeringSupported = $derived(
    observedReply?.settings?.provider === 'codex' || observedReply?.settings?.provider === 'claude',
  );
  const canSteer = $derived(
    loaded &&
      !readOnlyChat &&
      activeRunning &&
      steeringSupported &&
      !observedReply?.compact &&
      !!observedReply?.runId &&
      !activeStopping &&
      !activeSteering &&
      !imagesLoading &&
      !imagesSending &&
      !attachedImages.length &&
      !hasComposerMentions &&
      !!prompt.trim() &&
      !prompt.trimStart().startsWith('/') &&
      (desktop() || (paired && online)) &&
      (!selectedRemote || (paired && !syncError)),
  );
  // A message may wait for the running reply of the open conversation.
  const canQueue = $derived(
    loaded &&
      !!active &&
      activeRunning &&
      !activeSteering &&
      !activeStopping &&
      !imagesLoading &&
      !imagesSending &&
      (!attachedImages.length || imagesSupported) &&
      !selectingLocation &&
      !locationPending &&
      (desktop() || paired) &&
      (desktop() || online),
  );
  // The computers that answer for screens: every host, named by its own environment.
  const screenHosts = $derived.by(() => {
    const fleet = workspace.fleet;
    return [...new Set(fleet.environments.map((e) => executionHost(fleet, e.id)))].filter((host) =>
      fleet.environments.some((e) => e.id === host),
    );
  });
  const screenSummary = (id: string) => {
    for (const shelf of Object.values(screenShelves)) {
      const screen = shelf.screens.find((s) => s.id === id);
      if (screen) return screen;
    }
  };
  const openedScreenSummary = $derived(openedScreen ? screenSummary(openedScreen.id) : undefined);
  const screenCount = $derived(
    Object.values(screenShelves).reduce((count, shelf) => count + shelf.screens.length, 0),
  );
  // The Screens tab lists each computer's screens, newest first, filtered by the search.
  const screenGroups = $derived.by(() => {
    const search = query.toLowerCase();
    const groups = new Map<string, { id: string; name: string; screens: ScreenSummary[] }>();
    for (const shelf of Object.values(screenShelves))
      for (const screen of shelf.screens) {
        const environment = workspace.fleet.environments.find((e) => e.id === screen.environmentId);
        if (!environment) continue;
        if (
          search &&
          !`${screen.title} ${screen.description} ${screen.project}`.toLowerCase().includes(search)
        )
          continue;
        const id = computerViewId(environment);
        const group = groups.get(id) ?? {
          id,
          name: computers.find((c) => c.id === id)?.name ?? environment.name,
          screens: [],
        };
        group.screens.push(screen);
        groups.set(id, group);
      }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
  const screenProblems = $derived(
    Object.entries(screenShelves)
      .filter(([, shelf]) => shelf.error)
      .map(([host, shelf]) => ({
        host,
        name:
          computers.find((c) => c.environments.some((e) => e.id === host))?.name ?? 'A computer',
        error: shelf.error!,
      })),
  );
  const screensLoading = $derived(Object.values(screenShelves).some((shelf) => shelf.loading));
  // A count shows once a computer answered, so an unread list never reads as none.
  const screensChecked = $derived(Object.values(screenShelves).some((shelf) => shelf.checkedAt));
  // A workflow's chat is named by its workflow, static or dynamic.
  const viewTitle = $derived.by(
    () =>
      ({
        chat:
          (workflowChatShown && readOnlyChat ? active?.title : undefined) ??
          (chatWorkflow ? workflows.summaries.get(chatWorkflow)?.title : undefined) ??
          active?.title ??
          (currentScratch?.workflow && !currentScratch.workflow.id
            ? currentScratch.workflow.mode === 'mission'
              ? 'New dynamic workflow'
              : 'New workflow'
            : currentScratch?.workflow?.id
              ? 'Workflow'
              : 'New conversation'),
        connections: 'Connections',
        settings: 'Settings',
        screen: openedScreenSummary?.title ?? 'Screen',
        workflow: (openedWorkflow && workflows.summaries.get(openedWorkflow)?.title) || 'Workflow',
      })[view],
  );
  /** Reads the screens of each reachable host again, unless it answered moments ago. */
  function refreshScreens(hosts: string[] = screenHosts, force = false) {
    const session = workspaceSession;
    for (const host of hosts) {
      if (!environmentOnline(host)) continue;
      const shelf = (screenShelves[host] ??= { screens: [], loading: false });
      if (shelf.loading || (!force && shelf.checkedAt && Date.now() - shelf.checkedAt < 15_000))
        continue;
      shelf.loading = true;
      void listScreens(host).then(
        (screens) => {
          if (session === workspaceSession)
            screenShelves[host] = { screens, loading: false, checkedAt: Date.now() };
        },
        (e) => {
          if (session !== workspaceSession) return;
          // The list it gave before stays, as last reported.
          screenShelves[host] = {
            screens: screenShelves[host]?.screens ?? [],
            loading: false,
            checkedAt: Date.now(),
            error: (e instanceof Error ? e.message : String(e)).replace(/^Error: /, ''),
          };
        },
      );
    }
  }
  $effect(() => {
    if (loaded && conversationScope === 'screens') untrack(() => refreshScreens());
  });
  // This computer's own screens are counted from the start; others' when the tab opens.
  $effect(() => {
    if (loaded && desktop())
      untrack(() => refreshScreens(screenHosts.filter((host) => host === installation?.id)));
  });
  /** The host that keeps the screens of an environment. */
  const screenHost = (environmentId: string) =>
    workspace.fleet.environments.some((e) => e.id === environmentId)
      ? executionHost(workspace.fleet, environmentId)
      : undefined;
  /** A reply saved a screen, so its computer's list changed. */
  function screenSaved(environmentId: string) {
    const host = screenHost(environmentId);
    if (host) refreshScreens([host], true);
  }
  /**
   * A claude.ai artifact that a reply sent from this window created or opened opens beside its
   * chat, or in the browser where the window shows none, as Claude Code's terminal opens it: once
   * per artifact in this window, while its chat is on screen in the focused desktop window. Its
   * card opens it any time.
   */
  function openPublished(
    conversationId: string,
    artifact: PublishedArtifact,
    connectionId: string | undefined,
  ) {
    if (
      !desktop() ||
      activeId !== conversationId ||
      view !== 'chat' ||
      document.visibilityState !== 'visible' ||
      !windowFocused()
    )
      return;
    const key = 'agent-studio.opened-artifacts';
    let opened: unknown;
    try {
      opened = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    } catch {
      opened = [];
    }
    const ids = Array.isArray(opened) ? opened.filter((id) => typeof id === 'string') : [];
    if (ids.includes(artifact.id)) return;
    sessionStorage.setItem(key, JSON.stringify([...ids, artifact.id]));
    // The reader may be typing: the panel leaves focus where it is.
    openPage(conversationId, artifact, connectionId, false);
  }
  /** What a screen's computer last reported of it, kept in its list. */
  function noteScreen(detail: ScreenDetail) {
    const host = screenHost(detail.environmentId);
    if (!host) return;
    const {
      html: _html,
      actions: _actions,
      mcpTools: _tools,
      account: _account,
      digest: _digest,
      ...summary
    } = detail;
    const shelf = (screenShelves[host] ??= { screens: [], loading: false });
    const index = shelf.screens.findIndex((s) => s.id === detail.id);
    if (index >= 0) shelf.screens[index] = summary;
    else shelf.screens.unshift(summary);
  }
  function openScreen(environmentId: string, id: string) {
    openedScreen = { environmentId, id };
    const key = `${workspaceSession}/${environmentId}/${id}`;
    if (!keptScreens.some((kept) => kept.key === key)) keptScreens.push({ key, environmentId, id });
    view = 'screen';
    sidebarOpen = false;
    const host = screenHost(environmentId);
    if (host && !screenSummary(id)) refreshScreens([host]);
  }
  function screenDeleted() {
    if (!openedScreen) return;
    const host = screenHost(openedScreen.environmentId);
    const shelf = host ? screenShelves[host] : undefined;
    const id = openedScreen.id;
    if (shelf) shelf.screens = shelf.screens.filter((s) => s.id !== id);
    keptScreens = keptScreens.filter((kept) => kept.id !== id);
    openedScreen = undefined;
    view = 'chat';
  }
  /** The shell a screen's page runs commands in unless they name one: bash outside Windows. */
  function screenShell(environmentId: string): 'powershell' | 'bash' {
    const environment = workspace.fleet.environments.find((e) => e.id === environmentId);
    return !environment || (environment.platform === 'windows' && !environment.distribution)
      ? 'powershell'
      : 'bash';
  }
  /**
   * `studio.chat`: a new conversation in the screen's folder, with the text as its draft, sent
   * at once when the page asks.
   */
  function chatFromScreen(text: string, screen: ScreenDetail, sending = false) {
    const environment = workspace.fleet.environments.find((e) => e.id === screen.environmentId);
    if (!environment) {
      notice = 'This screen’s computer is no longer in Connections.';
      return;
    }
    newChat(undefined, undefined, {
      computerId: environment.computerId,
      environmentId: environment.id,
      path: screen.project,
    });
    prompt = text;
    keepDraft(composerContent());
    void tick().then(() => {
      composerInput?.focus();
      if (sending) void send();
    });
  }

  // ---- Workflows (docs/WORKFLOWS.md) -----------------------------------------------------------
  const activeWorkflow = $derived(active ? workflows.runOf(active.id) : undefined);
  // Workflows that run now lead the Active list: each run you or a trigger started, without the
  // runs another run started, which that run shows.
  const listedRuns = $derived.by(() => {
    const search = query.trim().toLowerCase();
    return [...workflows.summaries.values()]
      .filter(
        (s) =>
          s.kind === 'run' &&
          runActive(s.status) &&
          !s.parent &&
          (!search || s.title.toLowerCase().includes(search)),
      )
      .sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt));
  });
  /** Whether a run is on screen: its page, its chat, or the panel beside a chat. */
  function runShown(id: string) {
    return (
      (view === 'workflow' && (openedWorkflow === id || openedWorkflowRun === id)) ||
      (view === 'chat' && !!activeId && workflows.workflowOf(activeId)?.id === id) ||
      (view === 'chat' && !!chatWorkflow && panelRuns[chatWorkflow] === id)
    );
  }
  // The workflow a chat shows beside its graph: the one whose assistant or orchestrator it is, a
  // workflow chat about to become one, or for a chat a run started, its run's workflow (a static
  // run's saved workflow, else the run itself).
  const chatWorkflow = $derived.by(() => {
    if (!active) return currentScratch?.workflow?.id;
    const own = workflows.workflowOf(active.id);
    if (own) return own.id;
    if (!readOnlyChat) return undefined;
    const run = workflows.runOf(active.id);
    if (!run) return undefined;
    return run.mode !== 'dynamic' && run.definitionId && workflows.summaries.has(run.definitionId)
      ? run.definitionId
      : run.id;
  });
  // A workflow, static or dynamic, shows its graph in the chat's place, and its chat as a card at
  // the graph's left on demand (requested 2026-10-19). A new one shows the graph it starts with
  // beside its chat, open, until its first message makes it (requested 2026-10-20).
  const workflowDraft = $derived(
    view === 'chat' && !active && !!currentScratch?.workflow && !currentScratch.workflow.id,
  );
  const graphFirst = $derived(view === 'chat' && (!!chatWorkflow || workflowDraft));
  /**
   * Whether a workflow's chat card is open: as you left it, else as its kind shows it, a static
   * workflow's closed until you open it and a dynamic one's orchestrator open (requested
   * 2026-10-20).
   */
  const chatCardOpen = (id: string) =>
    workflowChatOpen[id] ?? workflows.summaries.get(id)?.mode === 'dynamic';
  const workflowChatShown = $derived(
    graphFirst && (workflowDraft || (!!chatWorkflow && chatCardOpen(chatWorkflow))),
  );
  // The chat a workflow's own chats lead back to: its assistant, or the orchestrator of a dynamic
  // workflow you started.
  const workflowHome = $derived.by(() => {
    if (!readOnlyChat || !chatWorkflow) return undefined;
    const summary = workflows.summaries.get(chatWorkflow);
    if (!summary?.chat || summary.chat === activeId || summary.parent) return undefined;
    return workspace.conversations.find((c) => c.id === summary.chat);
  });
  // A workflow chat keeps the workflows' own remembered agent.
  const workflowChat = $derived(!!currentScratch?.workflow || !!chatWorkflow);
  const workflowsInProgress = $derived(
    [...workflows.summaries.values()].filter(
      (s) => s.kind === 'run' && (s.status === 'running' || s.status === 'paused'),
    ).length,
  );
  const workflowsWaiting = $derived(
    [...workflows.summaries.values()].some((s) => s.kind === 'run' && s.questions > 0),
  );
  // The sidebar switches between two modes (requested 2026-10-20, in place of a Workflows row that
  // unfolded the list): Agent, the chats, and Workflow, the list of workflows, each saved workflow
  // and each dynamic workflow you started, the newest first. The mode follows what is on screen,
  // and switching returns to what that mode showed last, else to a new chat or workflow.
  type SidebarMode = 'agent' | 'workflow';
  type Place = { chat: string } | { scratch: string } | { page: string; run?: string };
  let sidebarMode = $state<SidebarMode>('agent');
  const places: Partial<Record<SidebarMode, Place>> = {};
  $effect(() => {
    let mode: SidebarMode;
    if (view === 'workflow' && openedWorkflow) {
      mode = 'workflow';
      places.workflow = { page: openedWorkflow, run: openedWorkflowRun };
    } else if (view === 'chat') {
      mode = workflowChat ? 'workflow' : 'agent';
      places[mode] = activeId ? { chat: activeId } : { scratch: scratchId };
    } else return;
    if (mode === untrack(() => sidebarMode)) return;
    // A row that opened the other mode's chat or workflow leaves with its list: its mode's tab
    // keeps the focus.
    const focused = document.activeElement?.closest('#sidebar-agent, #sidebar-workflow');
    sidebarMode = mode;
    if (focused)
      void tick().then(() => {
        if (document.activeElement === document.body)
          document.getElementById(`mode-${mode}`)?.focus();
      });
  });
  /** Whether a chat shows a workflow: its assistant or orchestrator, or a chat its run started. */
  const showsWorkflow = (id: string) =>
    !!workflows.workflowOf(id) || (workflows.readOnly(id) && !!workflows.runOf(id));
  /** Shows what a mode showed last, while it is still there and still of that mode. */
  function returnTo(mode: SidebarMode) {
    const place = places[mode];
    if (!place) return false;
    if ('page' in place) {
      if (!workflows.summaries.has(place.page)) return false;
      expandWorkflow(place.page, place.run);
      return true;
    }
    if ('scratch' in place) {
      const scratch = scratches.find((s) => s.id === place.scratch);
      if (!scratch || !!scratch.workflow !== (mode === 'workflow')) return false;
      openScratch(scratch, false);
      return true;
    }
    const chat = workspace.conversations.find((c) => c.id === place.chat);
    if (!chat || showsWorkflow(chat.id) !== (mode === 'workflow')) return false;
    openConversation(chat);
    return true;
  }
  async function switchMode(mode: SidebarMode, refocus?: HTMLElement) {
    if (!loaded || (mode === sidebarMode && (view === 'chat' || view === 'workflow'))) return;
    // The phone's drawer stays open on the mode's list.
    const drawer = sidebarOpen;
    if (!returnTo(mode)) {
      if (mode === 'agent') newChat();
      else newWorkflowChat();
    }
    sidebarOpen = drawer;
    if (!refocus) return;
    await tick();
    refocus.parentElement?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }
  function modeKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'agent'
        : event.key === 'End'
          ? 'workflow'
          : sidebarMode === 'agent'
            ? 'workflow'
            : 'agent';
    void switchMode(next, event.currentTarget as HTMLElement);
  }
  const listedWorkflows = $derived.by(() => {
    const search = query.trim().toLowerCase();
    const going = new Map<string, WorkflowSummary>();
    for (const summary of workflows.summaries.values())
      if (summary.kind === 'run' && summary.definitionId && runActive(summary.status)) {
        const known = going.get(summary.definitionId);
        if (!known || (summary.createdAt ?? '') > (known.createdAt ?? '')) going.set(summary.definitionId, summary);
      }
    return [...workflows.summaries.values()]
      .filter(
        (s) =>
          (s.kind === 'definition' || (s.mode === 'dynamic' && !s.parent)) &&
          (!search || s.title.toLowerCase().includes(search)),
      )
      .sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt))
      .map((summary) => ({ summary, run: summary.kind === 'run' ? summary : going.get(summary.id) }));
  });
  /** Whether a workflow is on screen: beside its chat, as its graph, or as a page. */
  const workflowOnScreen = (id: string) =>
    (view === 'chat' && chatWorkflow === id) || (view === 'workflow' && openedWorkflow === id);
  /**
   * Opens a workflow, run or mission: a workflow or mission in its chat, with its graph beside it,
   * a run of a saved workflow in that workflow's panel, and any other run as a page of its own.
   */
  function openWorkflow(id: string) {
    if (!id) return;
    sidebarOpen = false;
    const summary = workflows.summaries.get(id);
    const owner =
      summary?.kind === 'run' && summary.mode !== 'dynamic' && summary.definitionId
        ? workflows.summaries.get(summary.definitionId)
        : undefined;
    const target = owner ?? summary;
    const chat = target?.chat
      ? workspace.conversations.find((c) => c.id === target.chat)
      : undefined;
    // A dynamic workflow another run started has no chat of yours: it opens as a page.
    if (chat && (target?.kind === 'definition' || (target?.mode === 'dynamic' && !target.parent))) {
      panelRuns[target.id] = owner ? id : undefined;
      // A workflow opens on its graph, its chat as its kind shows it.
      delete workflowChatOpen[target.id];
      openConversation(chat);
      return;
    }
    if (target?.kind === 'definition') {
      delete workflowChatOpen[target.id];
      panelRuns[target.id] = owner ? id : undefined;
      newWorkflowChat('workflow', target.id);
      return;
    }
    expandWorkflow(id);
  }
  /** Whether a workflow has a chat here to show: a run only when its orchestrator chat is. */
  function workflowHasChat(id: string) {
    const summary = workflows.summaries.get(id);
    return (
      summary?.kind !== 'run' ||
      (!!summary.chat && workspace.conversations.some((c) => c.id === summary.chat))
    );
  }
  /** Shows a chat of the workflow on screen in the chat card beside its graph. */
  function openWorkflowChat(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    if (!conversation) return;
    openConversation(conversation);
    if (chatWorkflow) workflowChatOpen[chatWorkflow] = true;
  }
  // A chat of yours that becomes a workflow's (requested 2026-10-19): the assistant of a new static
  // workflow it builds from the conversation, or, when it runs on this computer, the orchestrator
  // of a new dynamic workflow that pursues what it asked for. Either leaves the chat lists and
  // shows its graph.
  let workflowMenu = $state(false);
  let makingWorkflow = $state(false);
  const workflowFromChatShown = $derived(
    !!active &&
      !readOnlyChat &&
      !chatWorkflow &&
      !hiddenChats.has(active.id) &&
      workflows.mode !== 'unavailable' &&
      (active.settings.provider === 'claude' || active.settings.provider === 'codex'),
  );
  const dynamicFromChat = $derived.by(() => {
    if (!active || !desktop() || !installation) return false;
    const connection = workspace.fleet.connections.find(
      (c) => c.id === active.settings.connectionId,
    );
    return !!connection && executionHost(workspace.fleet, connection.environmentId) === installation.id;
  });
  async function workflowFromChat(conversation: Conversation, mode: 'workflow' | 'mission') {
    workflowMenu = false;
    if (makingWorkflow || conversationRunning(conversation)) return;
    makingWorkflow = true;
    const actor = { kind: 'user' as const, ...(installation ? { environmentId: installation.id } : {}) };
    const instructions = (text: string) =>
      [conversation.settings.instructions.trim(), text].filter(Boolean).join('\n\n');
    try {
      if (mode === 'workflow') {
        const workflowId = crypto.randomUUID();
        const result = await workflows.saveDefinition(workflowId, null, {
          ...newDefinition(conversation.title.trim() || 'New workflow', actor),
          assistant: { conversationId: conversation.id },
        });
        if (!result.ok) throw new Error('The workflow could not be saved.');
        workflows.own(conversation.id);
        conversation.settings = {
          ...conversation.settings,
          instructions: instructions(assistantInstructions(workflowId)),
        };
        workflowChatOpen[workflowId] = true;
        await workflows.refresh();
        await sendWorkflowMessage(conversation.id, STATIC_FROM_CHAT);
      } else {
        if (!installation || !dynamicFromChat) return;
        const settings = conversation.settings;
        // Its goal is what the conversation asked for last.
        const asked = [...conversation.messages]
          .reverse()
          .find((m) => m.role === 'user' && !m.sentBy);
        const runId = await workflows.startMission({
          title: conversation.title,
          text: (asked && messageText(asked).trim()) || conversation.title,
          ...(conversation.location?.path ? { location: { ...conversation.location } } : {}),
          orchestrator: {
            provider: settings.provider,
            connectionId: settings.connectionId ?? '',
            model: settings.model,
            reasoning: settings.reasoning,
          },
          driver: { preferred: installation.id, elsewhere: true },
          actor,
          chat: {
            conversationId: conversation.id,
            environmentId: installation.id,
            ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
          },
        });
        workflows.own(conversation.id);
        workflowChatOpen[runId] = true;
        conversation.settings = { ...settings, instructions: instructions(ORCHESTRATOR_INSTRUCTIONS) };
        await sendWorkflowMessage(conversation.id, DYNAMIC_FROM_CHAT);
      }
    } catch (error) {
      notice = String(error).replace(/^Error: /, '');
    } finally {
      makingWorkflow = false;
    }
  }
  /**
   * Opens or closes a workflow's chat: a static workflow's assistant, else the chat that becomes
   * it, or a dynamic workflow's orchestrator.
   */
  function toggleWorkflowChat(workflowId: string) {
    if (chatCardOpen(workflowId) && view === 'chat') {
      workflowChatOpen[workflowId] = false;
      return;
    }
    const summary = workflows.summaries.get(workflowId);
    const own = summary?.chat
      ? workspace.conversations.find((c) => c.id === summary.chat)
      : undefined;
    if (own) {
      if (activeId !== own.id) openConversation(own);
    } else if (summary?.kind === 'run') return;
    else if (currentScratch?.workflow?.id !== workflowId || view !== 'chat')
      newWorkflowChat('workflow', workflowId);
    workflowChatOpen[workflowId] = true;
    void tick().then(() => composerInput?.focus());
  }
  /** Shows a workflow, run or mission as a page of its own, with a run of the workflow shown. */
  function expandWorkflow(id: string, run?: string) {
    openedWorkflow = id;
    openedWorkflowRun = run;
    view = 'workflow';
    sidebarOpen = false;
  }
  /**
   * A chat that starts a new workflow or mission, the one left with a draft if there is one;
   * with `id`, the chat that becomes that workflow's assistant.
   */
  function newWorkflowChat(mode: 'workflow' | 'mission' = workflowMode(), id?: string) {
    const kept = scratches.find((s) =>
      id ? s.workflow?.id === id : s.workflow && !s.workflow.id && s.filled,
    );
    if (kept) {
      openScratch(kept);
      return;
    }
    // On this computer, Standalone, with the agent chosen last for workflows.
    const here = installation
      ? computers.find((c) => c.environments.some((e) => e.id === installation!.id))
      : undefined;
    const computerId = here?.id ?? selectedComputerId;
    const location = computerId ? standaloneLocation(computerId) : undefined;
    newChat(workflowAgent().provider, undefined, location, location ? undefined : computerId, true, false, {
      mode,
      ...(id ? { id } : {}),
    });
  }
  /** The arrow keys move between Workflow and Mission on a new workflow chat's welcome. */
  function workflowKindKey(event: KeyboardEvent, mode: 'workflow' | 'mission') {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = mode === 'mission' ? 'workflow' : 'mission';
    setWorkflowMode(next);
    void tick().then(() =>
      document.querySelector<HTMLElement>(`.workflow-kind [data-kind="${next}"]`)?.focus(),
    );
  }
  function setWorkflowMode(mode: 'workflow' | 'mission') {
    const scratch = scratches.find((s) => s.id === scratchId);
    if (!scratch?.workflow || scratch.workflow.id) return;
    scratch.workflow = { mode };
    rememberWorkflowMode(mode);
    const key = draftKey.scratch(scratch.id);
    const draft = drafts.get(key);
    if (draft) {
      draft.updatedAt = Date.now();
      draftChanged(key);
    }
  }
  const computerNameOf = (environmentId?: string) =>
    (environmentId &&
      (computers.find((c) => c.environments.some((e) => e.id === environmentId))?.name ??
        workspace.fleet.environments.find((e) => e.id === environmentId)?.name)) ||
    'A computer';
  const accountNameOf = (connectionId?: string) => {
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    return workspace.fleet.accounts.find((a) => a.id === connection?.accountId)?.name ?? '';
  };
  /** Deletes the chats a deleted run started, as deleting each would. */
  async function deleteWorkflowChats(ids: string[]) {
    const gone = new Set(ids);
    for (const conversation of workspace.conversations.filter((c) => gone.has(c.id))) {
      const reply = conversation.messages.find((m) => m.status === 'running');
      if (reply?.runId)
        await cancelRun(
          reply.runId,
          reply.settings?.connectionId ?? conversation.settings.connectionId,
          true,
        ).catch(() => {});
      delete queued[conversation.id];
      await releaseConversation(conversation.id, conversation.settings.connectionId).catch(
        () => {},
      );
      forgetDraft(draftKey.chat(conversation.id));
      forgetChat(conversation.id);
    }
    workspace.conversations = workspace.conversations.filter((c) => !gone.has(c.id));
    if (activeId && gone.has(activeId)) newChat();
    await persist();
  }
  // A chat a workflow starts: an ordinary conversation, sent its first message through the reply
  // path the composer uses, without a title request.
  function beginWorkflowReply(conversation: Conversation, now: string, mission?: ChatSpec['mission']) {
    const { provider, model } = conversation.settings;
    const catalog = modelCache.get(modelScopeKey(conversation.settings))?.catalog ?? fallbackModels;
    void startReply(conversation, {
      now,
      modelName: selectedModelName(model, modelChoices(catalog, provider, model)),
      ...(mission ? { mission } : {}),
    });
    // The reply's placeholder joins its chat before its request goes out.
    const reply = conversation.messages.at(-1);
    if (reply?.role !== 'assistant') throw new Error('The reply could not start.');
    return reply.id;
  }
  async function sendWorkflowMessage(id: string, text: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    if (!conversation) throw new Error('That chat is no longer here.');
    if (conversationRunning(conversation) || stopping[id] || takingOver[id])
      throw new Error('Its reply is still running.');
    const now = new Date().toISOString();
    if (conversation.archived) conversation.archived = false;
    delete conversation.rewind;
    rewoundDrafts.delete(conversation.id);
    addUserMessage(conversation, { text, images: [], sentBy: 'workflow' }, now);
    return { replyId: beginWorkflowReply(conversation, now) };
  }
  // Workflow chats whose process goes once their running reply ends, such as an orchestrator
  // that completed its mission from that reply (docs/WORKFLOWS.md).
  const releaseAfterReply = new Set<string>();
  function releaseWorkflowChat(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    if (!conversation) return void releaseAfterReply.delete(id);
    if (conversationRunning(conversation) || queued[id]?.length)
      return void releaseAfterReply.add(id);
    releaseAfterReply.delete(id);
    void closeConversation(id, conversation.settings.connectionId).catch(() => {});
  }
  async function startWorkflowChat(spec: ChatSpec) {
    // A chat a driver created before it stopped continues where it is.
    if (workspace.conversations.some((c) => c.id === spec.id))
      return sendWorkflowMessage(spec.id, spec.text);
    const now = new Date().toISOString();
    const location = spec.location ? insideDistribution(workspace.fleet, spec.location) : undefined;
    workflows.own(spec.id);
    workspace.conversations.unshift({
      id: spec.id,
      settings: { ...spec.settings },
      ...(location ? { location: { ...location } } : {}),
      title: spec.title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    const conversation = workspace.conversations.find((c) => c.id === spec.id)!;
    addUserMessage(conversation, { text: spec.text, images: [], sentBy: 'workflow' }, now);
    return { replyId: beginWorkflowReply(conversation, now, spec.mission) };
  }
  function workflowReadiness(settings: ChatSettings, location?: ChatLocation): Readiness {
    const connection = workspace.fleet.connections.find((c) => c.id === settings.connectionId);
    const environment =
      connection?.environmentId ??
      (location ? (location.executionEnvironmentId ?? location.environmentId) : installation?.id);
    if (environment && !environmentOnline(environment))
      return { ready: false, reason: `Waiting for ${computerNameOf(environment)}` };
    if (!settings.connectionId)
      return {
        ready: false,
        reason: `No ${providers[settings.provider].name} account on ${computerNameOf(environment)}`,
      };
    if (needsSignIn(settings.connectionId))
      return { ready: false, reason: `${accountNameOf(settings.connectionId)} needs sign-in` };
    if (!readyToSend({ settings, location } as Conversation))
      return { ready: false, reason: `Waiting for ${accountNameOf(settings.connectionId) || 'its account'}` };
    return { ready: true };
  }
  function workflowLeastUsed(
    provider: ProviderId,
    location: ChatLocation | undefined,
    model: string,
    exclude: string[] = [],
  ) {
    const at =
      location ??
      (installation
        ? { computerId: installation.computerId, environmentId: installation.id, path: '' }
        : undefined);
    const usable = locationConnections(workspace.fleet, at, provider).filter(
      (c) => !exclude.includes(c.id) && canChooseConnection(c.id) && !needsSignIn(c.id),
    );
    // With balancing on, the accounts Settings leaves out take part only when no other can.
    const left = workspace.preferences.balanceAccounts
      ? new Set(workspace.preferences.balanceExcluded)
      : new Set<string>();
    const kept = usable.filter((c) => !left.has(c.accountId));
    const candidates = kept.length ? kept : usable;
    const ready = candidates.filter((c) => connectionStatus(c.id)?.auth === 'ready');
    const pool = ready.length ? ready : candidates;
    if (!pool.length) return undefined;
    const accounts = new Map(workspace.fleet.connections.map((c) => [c.id, c.accountId]));
    const activity = accountActivity(workspace.conversations, (id) => accounts.get(id));
    return balancedAccount(
      pool.map((c) => {
        const settings = { provider, model: '', connectionId: c.id };
        const snapshot = snapshotFor(usageSnapshots, settings);
        if (!snapshot) void refreshUsage(settings);
        return {
          connectionId: c.id,
          snapshot,
          running: activity.get(c.accountId)?.running ?? 0,
          lastUsed: activity.get(c.accountId)?.lastUsed ?? 0,
        };
      }),
      { provider, model },
      Date.now(),
    );
  }
  function recentFolders(environmentId: string) {
    return [
      ...new Set(
        (workspace.preferences.recentLocations ?? [])
          .filter((l) => (l.executionEnvironmentId ?? l.environmentId) === environmentId && l.path)
          .map((l) => l.path),
      ),
    ];
  }
  const serverEnvironment = (environmentId: string) =>
    (environmentId === installation?.id && !!installation?.server) ||
    !!presence.find((p) => p.environmentId === environmentId)?.features?.includes('server');
  const workflowHost: WorkflowHost = {
    self: () => ({
      environmentId: installation!.id,
      computerId: installation!.computerId,
      server: !!installation!.server,
      name: computerNameOf(installation!.id),
    }),
    now: () => Date.now(),
    fleet: () => workspace.fleet,
    online: (environmentId) => environmentOnline(environmentId),
    conversation: (id) => workspace.conversations.find((c) => c.id === id),
    conversations: () => workspace.conversations,
    startChat: startWorkflowChat,
    sendToChat: sendWorkflowMessage,
    async steerChat(id, text) {
      const reply = workspace.conversations.find((c) => c.id === id)?.messages.at(-1);
      if (reply?.role !== 'assistant' || reply.status !== 'running' || !reply.runId)
        throw new Error('Its reply has ended.');
      await steerRun(reply.runId, { id: crypto.randomUUID(), text }, reply.settings?.connectionId);
    },
    async stopChat(id) {
      const conversation = workspace.conversations.find((c) => c.id === id);
      const reply = conversation?.messages.find((m) => m.status === 'running');
      if (!conversation || !reply?.runId) return;
      if (runs[id] === reply.runId) stopping[id] = true;
      await cancelRun(reply.runId, reply.settings?.connectionId ?? conversation.settings.connectionId);
    },
    releaseChat: releaseWorkflowChat,
    switchAccount(id, connectionId) {
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (!conversation) return;
      conversation.settings = { ...conversation.settings, connectionId };
      void persistChat(id);
    },
    readiness: workflowReadiness,
    usage: (connectionId, provider) =>
      snapshotFor(usageSnapshots, { provider, model: '', connectionId }),
    refreshUsage: (connectionId, provider) =>
      void refreshUsage({ provider, model: '', connectionId }, true),
    leastUsed: workflowLeastUsed,
    screens: { run: runScreenAction, load: loadScreenData, save: saveScreenData },
    createRun: (id, run) => workflows.createRun(id, run),
    knownRun: (id) => workflows.knownRun(id),
    definition: (id) => workflows.definition(id),
    computers: () =>
      computers.flatMap((view) => {
        const environment = view.environments[0];
        if (!environment) return [];
        const at = { computerId: environment.computerId, environmentId: environment.id, path: '' };
        return [
          {
            environmentId: environment.id,
            computerId: environment.computerId,
            name: view.name,
            platform: environment.platform,
            online: environmentOnline(environment.id),
            server: serverEnvironment(executionHost(workspace.fleet, environment.id)),
            providers: providerIds.filter((p) =>
              locationConnections(workspace.fleet, at, p).some(
                (c) => connectionStatus(c.id)?.installed !== false,
              ),
            ),
            folders: recentFolders(environment.id),
          },
        ];
      }),
    accounts: () =>
      workspace.fleet.connections.flatMap((c) => {
        const account = workspace.fleet.accounts.find((a) => a.id === c.accountId);
        if (!account) return [];
        const status = connectionStatus(c.id);
        return [
          {
            connectionId: c.id,
            name: account.name,
            provider: account.provider,
            environmentId: c.environmentId,
            ready: status?.auth === 'ready' && !!status.installed && environmentOnline(c.environmentId),
            detail: status?.detail ?? 'Not checked yet',
          },
        ];
      }),
  };
  const workflowPickers = $derived<WorkflowPickers>({
    computers: computers.flatMap((view) =>
      view.environments[0]
        ? [
            {
              id: view.environments[0].id,
              name: view.name,
              ...(environmentOnline(view.environments[0].id) ? {} : { detail: 'Offline' }),
            },
          ]
        : [],
    ),
    location: (environmentId) => {
      const environment = workspace.fleet.environments.find((e) => e.id === environmentId);
      return environment
        ? { computerId: environment.computerId, environmentId: environment.id }
        : undefined;
    },
    folders: recentFolders,
    accounts: (provider, environmentId) =>
      workspace.fleet.connections.flatMap((c) => {
        const account = workspace.fleet.accounts.find((a) => a.id === c.accountId);
        return c.environmentId === environmentId && account?.provider === provider
          ? [{ id: c.id, name: account.name }]
          : [];
      }),
    models: (provider, connectionId) => {
      const catalog =
        modelCache.get(modelScopeKey({ provider, connectionId: connectionId || undefined }))
          ?.catalog ?? fallbackModels;
      return modelChoices(catalog, provider, '').map((m) => ({
        id: m.id,
        name: m.name,
        levels: m.reasoningLevels,
      }));
    },
    chats: () =>
      workspace.conversations
        .filter((c) => !hiddenChats.has(c.id))
        .map((c) => ({ id: c.id, name: c.title })),
    screens: (environmentId) =>
      Object.values(screenShelves)
        .flatMap((shelf) => shelf.screens)
        .filter((s) => s.environmentId === environmentId)
        .map((s) => ({ id: s.id, name: s.title })),
    workflows: () =>
      [...workflows.summaries.values()]
        .filter((s) => s.kind === 'definition')
        .map((s) => ({ id: s.id, name: s.title })),
    computerName: computerNameOf,
    accountName: accountNameOf,
    balancing: !!workspace.preferences.balanceAccounts,
    here: installation?.id ?? '',
    drivers: workspace.fleet.environments
      .filter((e) => !e.discoveredOn && e.platform !== 'wsl')
      .map((e) => ({
        id: e.id,
        name: computerNameOf(e.id),
        server: serverEnvironment(e.id),
        ...(environmentOnline(e.id) ? {} : { detail: 'Offline' }),
      })),
    defaultDriver:
      desktop() && installation
        ? installation.id
        : (workspace.fleet.environments.find(
            (e) => !e.discoveredOn && serverEnvironment(e.id) && environmentOnline(e.id),
          )?.id ??
          workspace.fleet.environments.find((e) => !e.discoveredOn && environmentOnline(e.id))
            ?.id ??
          ''),
  });
  // Where a new dynamic workflow's orchestrator will run, and on which account, as its card says.
  const draftOrchestrator = $derived(
    workflowDraft && currentScratch?.workflow?.mode === 'mission'
      ? [
          computerNameOf(missionDriver?.preferred ?? workflowPickers.defaultDriver),
          accountNameOf(selectedSettings.connectionId),
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  );

  let relayRestorePending = $state(true);
  let notificationTarget = $state<string>();
  function followNotification() {
    if (!notificationTarget || !loaded) return;
    if (notificationTarget.startsWith('workflow:')) {
      openWorkflow(notificationTarget.slice('workflow:'.length));
      notificationTarget = undefined;
      if (notificationWorkflow(window.location.hash))
        history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }
    const conversation = workspace.conversations.find((c) => c.id === notificationTarget);
    if (!conversation) return; // A cold start may still be downloading the checkpoint.
    // Unsent drafts stay with their own chat. Only an image still being read waits for it.
    if (activeId !== conversation.id && imagesLoading) return;
    notificationTarget = undefined;
    if (activeId !== conversation.id) openConversation(conversation, true);
    else {
      view = 'chat';
      sidebarOpen = false;
    }
    if (notificationConversation(window.location.hash))
      history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  let relayRestoreBusy = false;
  let relaySelectionVersion = 0;
  async function restoreRelayConnection() {
    if (!loaded || relayRestoreBusy) return;
    relayRestoreBusy = true;
    const version = relaySelectionVersion;
    try {
      const connected = await resumeRelay();
      if (version !== relaySelectionVersion) return;
      relayRestorePending = false;
      paired = connected;
      syncError = '';
      if (connected) await syncNow();
    } catch (error) {
      if (version !== relaySelectionVersion) return;
      if (error instanceof BrowserWorkspaceStorageError) {
        loaded = false;
        paired = false;
        relayRestorePending = false;
        storageError = error.message;
        syncError = error.message;
        return;
      }
      relayRestorePending = true;
      syncError =
        desktop() ||
        (error instanceof Error && /Pair this device|Relay data was replaced/.test(error.message))
          ? String(error).replace(/^Error: /, '')
          : 'Server unavailable. Reconnecting automatically…';
    } finally {
      relayRestoreBusy = false;
    }
  }

  $effect(() => {
    // Track only the visible chat selection, never streamed workspace content.
    loaded;
    view;
    activeId;
    untrack(() => {
      void publishNotificationView();
    });
  });
  onMount(() => {
    let disposed = false;
    // A workflow's chats end without an alert of their own, and its runs' chats raise none.
    setQuietChats(
      () => workflows.chats,
      () => workflows.isolated,
    );
    const stopAccountUpdates = watchAccountUpdates(applyAccountUpdate);
    const stopBackgroundWork = watchBackgroundWork(applyBackgroundWork);
    const stopUsageRefresh = watchUsageRefresh(refreshUsageConnection);
    const stopNotificationView = watchNotificationView(
      () => (loaded && view === 'chat' ? activeId || undefined : undefined),
    );
    const stopBrowserSession = watchBrowserSession();
    const stopAnswers = watchAppAnswers();
    let stopNotifications = () => {};
    void watchDesktopNotifications((id) => {
      notificationTarget = id.startsWith('workflow:')
        ? `workflow:${notificationWorkflow(`#workflow=${id.slice(9)}`) ?? ''}`
        : notificationConversation(`#conversation=${id}`);
      followNotification();
    }).then((stop) => {
      if (disposed) stop();
      else stopNotifications = stop;
    });
    let stopAppUpdates = () => {};
    void watchAppUpdates((status) => (appUpdate = status)).then((stop) => {
      if (disposed) stop();
      else stopAppUpdates = stop;
    });
    let stopCliUpdates = () => {};
    void watchCliUpdates(applyCliUpdates).then((stop) => {
      if (disposed) stop();
      else stopCliUpdates = stop;
    });
    // Sign-ins outlive a reload: the host still waits on them and reports how they end.
    let stopSignIns = () => {};
    void watchSignIns(applySignIn).then((stop) => {
      if (disposed) stop();
      else stopSignIns = stop;
    });
    void listSignIns()
      .then((views) => views.forEach(applySignIn))
      .catch(() => {});
    const notificationHash = () => {
      const workflow = notificationWorkflow(window.location.hash);
      notificationTarget = workflow
        ? `workflow:${workflow}`
        : notificationConversation(window.location.hash);
      followNotification();
    };
    const notificationMessage = (event: MessageEvent) => {
      if (
        event.source !== navigator.serviceWorker.controller ||
        event.data?.type !== 'studio-notification-open'
      )
        return;
      const workflow = notificationWorkflow(event.data.hash);
      notificationTarget = workflow
        ? `workflow:${workflow}`
        : notificationConversation(event.data.hash);
      followNotification();
    };
    if (!desktop()) {
      notificationHash();
      window.addEventListener('hashchange', notificationHash);
      navigator.serviceWorker?.addEventListener('message', notificationMessage);
    }
    const network = () => {
      online = navigator.onLine;
    };
    network();
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    const stopViewport = trackMobileViewport();
    const stopDrawerSwipe = trackDrawerSwipe({
      enabled: () => mobile && !deletion && !conversationMenu,
      open: () => sidebarOpen,
      drawer: () => sidebarElement,
      move: (progress) => {
        if (progress === undefined && drawerDrag !== undefined) {
          drawerSettling = true;
          clearTimeout(drawerSettleTimer);
          drawerSettleTimer = setTimeout(() => (drawerSettling = false), 400);
        }
        drawerDrag = progress;
      },
      settle: (open) => {
        if (open !== sidebarOpen) void toggleSidebar(open);
      },
    });
    let focusTimer: ReturnType<typeof setTimeout>;
    const onReturn = () => {
      if (!loaded || document.visibilityState === 'hidden') return;
      if (paired) void syncNow();
      else void restoreRelayConnection();
      // The accounts were used meanwhile, here or elsewhere: a new chat still without a draft
      // compares them again.
      if (!draftFilled) refreshBalance();
      if (localRunning) {
        if (pendingSignIns.size) void checkSignIn();
        return;
      }
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        void refresh();
        if (view === 'chat') void refreshUsage();
      }, 250);
    };
    // Focus coming back from a claude.ai pane over the page never left the window.
    const onFocus = () => {
      if (!backFromClaudePage()) onReturn();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    // Save typed drafts right away when the window is left, hidden, or closed.
    const saveDraftsOnLeave = () => void saveDraftsNow();
    const saveDraftsWhenHidden = () => {
      if (document.visibilityState === 'hidden') void saveDraftsNow();
    };
    window.addEventListener('blur', saveDraftsOnLeave);
    window.addEventListener('pagehide', saveDraftsOnLeave);
    document.addEventListener('visibilitychange', saveDraftsWhenHidden);
    const loginPoll = setInterval(() => {
      if (pendingSignIns.size) void checkSignIn();
    }, 5000);
    const usagePoll = setInterval(() => {
      today = startOfDay(Date.now());
      if (loaded && document.visibilityState !== 'hidden') {
        if (view === 'chat') void refreshUsage();
        if (view === 'connections') void refreshAccountUsage();
      }
    }, 60_000);
    // A message sent right after midnight already belongs to the new day, so the day moves on as
    // it begins; the minute timer above covers a computer that slept through midnight.
    let dayTimer: ReturnType<typeof setTimeout>;
    const beginDay = () => {
      today = startOfDay(Date.now());
      const next = new Date(today);
      next.setDate(next.getDate() + 1);
      dayTimer = setTimeout(beginDay, next.getTime() - Date.now());
    };
    beginDay();
    const relayPoll = setInterval(() => {
      if (paired) void syncNow();
      else if (
        relayRestorePending &&
        online &&
        (desktop() || document.visibilityState !== 'hidden')
      )
        void restoreRelayConnection();
    }, 2500);
    const wslPoll = setInterval(() => {
      if (loaded && view === 'connections' && document.visibilityState !== 'hidden')
        void refreshWsl();
    }, 15_000);
    // No one opens a server's window, so it checks its CLIs and accounts on its own, for the
    // devices that run chats on it.
    const serverPoll = setInterval(() => {
      if (loaded && installation?.server && !localRunning && !workingForOthers()) void refresh();
    }, 5 * 60_000);
    // Nothing reports a reply this computer runs without its run, so it is looked for.
    const abandonPoll = setInterval(() => void endAbandonedReplies(), 10_000);
    // A chat a usage limit stopped goes on once the limit resets, from the computer running it.
    const continuePoll = setInterval(continueLimitedChats, 15_000);
    // Replies other devices asked for that ran on through a reload wait this long for the relay
    // to take their requests up again, then end here on their own.
    let jobResumeTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const local = await getInstallation();
        // Replies this computer still runs: a reloaded window follows them again, so they are
        // no interrupted ones. Listed before the workspace is read, so none ends unseen between.
        const live = await liveRuns().catch((): LiveRun[] => []);
        workspace = await loadWorkspace(local, live);
        installation = local;
        if (installation && desktop()) registerInstallation(workspace.fleet, installation);
        // History lists the chats used from this start of the app until the next one under it.
        // A server's starts are no one's sessions.
        const started =
          desktop() && !installation?.server
            ? await appSession().catch(() => undefined)
            : undefined;
        // Legacy chats retain a stable owning computer when the workspace is synchronized.
        for (const conversation of workspace.conversations) {
          // Start each app session with a clean Active list without changing chat recency. A
          // server starts with no one at its window and leaves everyone's chats where they are,
          // and a reloaded window is no new start of the app.
          if (desktop() && !installation?.server && !started?.reloaded)
            conversation.archived = true;
          if (!conversation.location)
            conversation.location = conversationLocation(
              conversation,
              workspace.fleet,
              installation,
            );
        }
        const session = started &&
          installation && {
            id: started.id,
            startedAt: started.startedAt,
            environmentId: installation.id,
          };
        if (session && appSessionSchema.safeParse(session).success)
          workspace.appSessions = recordAppSession(
            workspace.appSessions,
            session,
            workspace.conversations,
          );
        draftComputerId =
          workspace.fleet.environments.find((e) => e.id === installation?.id)?.computerId ??
          installation?.computerId ??
          '';
        draftLocation = workspace.preferences.recentLocations?.find(
          (l) => locationConnections(workspace.fleet, l).length,
        );
        draftSettings = settingsFor(workspace.preferences);
        await loadSavedDrafts();
        loaded = true;
        // The baseline of this session: saved chats are read history, however they ended.
        noteFinishedChats();
        if (!continueScratch()) newChat();
        if (installation)
          configureRuntime({
            installation,
            workspace: () => $state.snapshot(workspace),
            // Validating the live workspace already detaches the replicated part of it, so this
            // costs about half of a snapshot of everything followed by the same validation.
            shared: () => sharedWorkspace(workspace),
            fleet: () => $state.snapshot(workspace.fleet),
            revision: () => localChanges,
            statuses: () => $state.snapshot(connectionStatuses),
            localRuns: () => Object.values(runs),
            replaceBrowserWorkspace: async (
              value,
              reason,
              preserveInitialNotification = false,
              unpublished,
            ) => {
              workspaceSession++;
              queued = {};
              resetDrafts();
              forking = false;
              const previousView = view;
              workspace = value;
              snapshots.clear();
              chatsWithWork.clear();
              workShown.clear();
              shownWork.clear();
              workReading++;
              // Another workspace's replies are history here, not news.
              finishedChats = {};
              observeFinishedChats = createFinishedChatTracker();
              noteFinishedChats();
              connectionStatuses = {};
              cliInventories = {};
              presence = [];
              modelGeneration++;
              modelCache.clear();
              modelRequests.clear();
              models = structuredClone(fallbackModels);
              usageSnapshots = {};
              usageLoading = {};
              usageErrors = {};
              draftComputerId = '';
              selectingLocation = false;
              preparingCommand = false;
              runs = {};
              stopping = {};
              steeringPending = {};
              artifactViews = {};
              subagentViews = {};
              recalls.clear();
              sidebarOpen = false;
              folderBrowserOpen = false;
              contextOpen = false;
              editorOpen = false;
              templatesOpen = false;
              conversationMenu = null;
              deletion = null;
              deleting = false;
              deletionError = '';
              if (!preserveInitialNotification) notificationTarget = undefined;
              collapsedGroups = {};
              query = '';
              notice = '';
              screenShelves = {};
              openedScreen = undefined;
              keptScreens = [];
              newChat();
              view = previousView === 'screen' ? 'chat' : previousView;
              if (reason !== undefined) {
                ++relaySelectionVersion;
                paired = false;
                relayRestorePending = false;
                syncError = reason;
                syncNotice = '';
                syncStatus = '';
              }
              await loadSavedDrafts();
              // What this device changed and had not published, saved with its copy, is all it
              // has to publish: the rest is what it received, which follows the relay.
              if (unpublished) {
                marks.resume(unpublished);
                await persist(false);
              } else await persist();
            },
            checkpointRun: async (request, event, status, error) => {
              const conversation = workspace.conversations.find(
                (c) => c.id === request.conversationId,
              );
              // A message that took over a reply waiting for background work joins the
              // conversation as the host confirms, here as on the device that sent it.
              if (conversation && event?.kind === 'takeover')
                joinTakeOver(conversation, request);
              const message = conversation?.messages.find((m) => m.id === request.assistantId);
              if (!conversation || !message) return;
              let clock = false;
              if (event) {
                hearWait(request.runId, event);
                if (hearDraft(request.runId, event)) {
                  if (activeId === conversation.id) void scrollToEnd(true);
                  return;
                }
                clock = applyRunEvent(message, event) === 'clock';
                if (event.kind === 'screen' && event.screen)
                  screenSaved(event.screen.environmentId);
              }
              if (status) {
                message.status = status;
                message.error = error;
                delete message.backgroundWait;
                delete heardWaits[request.runId];
                delete questionDrafts[request.runId];
                conversation.updatedAt = new Date().toISOString();
                planContinue(conversation, message);
                noteFinishedChats();
                if (activeId === conversation.id) void scrollToEnd();
                await persistChat(conversation.id);
                return;
              }
              // This computer runs the reply for another device, so its progress goes out with
              // every poll. Like a reply started here, it saves at once only what a reader must
              // not lose, and the rest with the next save instead of once per event. Each event
              // changes this one message, and a call's running time goes out without hurry.
              localChanges++;
              if (clock) marks.quiet(conversation.id, message.id);
              else marks.chat(conversation.id, message.id);
              if (event && savesAtOnce(event)) saveSoon(conversation.id, message.id);
              if (activeId === conversation.id) void scrollToEnd(true);
            },
            apply: async (value) => {
              workspace.fleet = value.fleet;
              workspace.workflows = value.workflows;
              workspace.inputTemplates = value.inputTemplates;
              workspace.claudeInstructions = value.claudeInstructions;
              workspace.appSessions = value.appSessions;
              workspace.folderIcons = value.folderIcons;
              workspace.accountColors = value.accountColors;
              workspace.snoozes = value.snoozes;
              const kept = new Set(value.conversations.map((c) => c.id));
              const deleted = workspace.conversations.filter((c) => !kept.has(c.id));
              // Preserve active object identities while network responses arrive.
              workspace.conversations = value.conversations.map((incoming) => {
                const existing = workspace.conversations.find((c) => c.id === incoming.id);
                return existing ? replaceFields(existing, keepWork(incoming, existing)) : incoming;
              });
              if (activeId && kept.has(activeId)) followReceived();
              releaseDeleted(deleted.map((c) => c.id));
              // A conversation deleted on another device takes its unsent draft along.
              const chats = new Set(workspace.conversations.map((c) => draftKey.chat(c.id)));
              for (const key of [...drafts.keys()])
                if (key.startsWith('chat:') && key !== composerDraftKey && !chats.has(key))
                  forgetDraft(key);
              // Received from the relay, so nothing new to send back.
              noteFinishedChats();
              await persist(false);
              refreshNewConnections();
            },
            chat: (id) => {
              const conversation = workspace.conversations.find((c) => c.id === id);
              return conversation && chatCopy(conversation);
            },
            chatIds: () => {
              const ids = workspace.conversations.map((c) => c.id);
              // Copies of conversations this device no longer holds have no further use.
              snapshots.keep(ids);
              return ids;
            },
            meta: () => sharedMeta(workspace),
            takeUnsynced: () => marks.takeUnsynced(),
            restoreUnsynced: (changes) => marks.restoreUnsynced(changes),
            // The Viewer saves which of its changes the relay does not hold yet with its copy.
            settleUnsynced: () => {
              if (marks.settleUnsynced() && !desktop()) saveLocalSoon();
            },
            pendingChanges: () => marks.pending(),
            flush: flushPending,
            // Only the conversations a sync merged, so an unrelated chat is never rewritten.
            openChat: () => activeId ?? undefined,
            applyChats: async (upsert, remove, meta, wholes) => {
              if (meta) {
                workspace.fleet = meta.fleet;
                workspace.workflows = meta.workflows;
                workspace.inputTemplates = meta.inputTemplates;
                workspace.claudeInstructions = meta.claudeInstructions;
                workspace.appSessions = meta.appSessions;
                workspace.folderIcons = meta.folderIcons;
                workspace.accountColors = meta.accountColors;
                workspace.snoozes = meta.snoozes;
              }
              const gone = new Set(remove);
              if (gone.size)
                workspace.conversations = workspace.conversations.filter((c) => !gone.has(c.id));
              releaseDeleted(gone);
              for (const incoming of upsert) {
                const existing = workspace.conversations.find((c) => c.id === incoming.id);
                // Preserve active object identities while network responses arrive.
                if (existing) replaceFields(existing, keepWork(incoming, existing));
                else workspace.conversations.push(incoming);
              }
              // The open chat's work as the relay recorded it, read with this sync.
              const whole = activeId ? wholes?.get(activeId) : undefined;
              if (whole) attachWork(whole);
              if (whole || upsert.some((c) => c.id === activeId)) followReceived();
              // A conversation deleted on another device takes its unsent draft along.
              const chats = new Set(workspace.conversations.map((c) => draftKey.chat(c.id)));
              for (const key of [...drafts.keys()])
                if (key.startsWith('chat:') && key !== composerDraftKey && !chats.has(key))
                  forgetDraft(key);
              // Received from the relay: only these conversations need saving here, and nothing
              // needs publishing back. Settings and the order travel with the index.
              noteFinishedChats();
              if (!loaded || (!upsert.length && !gone.size && !meta)) return;
              for (const conversation of upsert) marks.received(conversation.id);
              if (gone.size || meta) marks.local();
              await flushWorkspace();
              refreshNewConnections();
            },
            followReply: (runId) => followLiveReply(runId),
          });
        // Replies that ran on while the window reloaded, followed again from their start. Those
        // another device asked for go on publishing their requests once the relay answers.
        const jobs = live.filter((run) => run.job).map((run) => run.runId);
        for (const run of liveInChatOrder(live.filter((run) => !run.job)))
          followLiveReply(run.runId);
        if (jobs.length) {
          resumeJobs(jobs);
          jobResumeTimer = setTimeout(() => {
            for (const runId of unresumedJobs()) followLiveReply(runId);
          }, 30_000);
        }
        await persist();
        await restoreRelayConnection();
        followNotification();
        // Workflows read their store once the relay connection is known (docs/WORKFLOWS.md).
        workflows.start();
      } catch (e) {
        storageError = `Could not load your workspace. ${String(e)} No saved data has been overwritten.`;
      }
      void refreshModels();
      await refresh();
    })();
    return () => {
      disposed = true;
      workflows.stop();
      shutdown.stop();
      stopAccountUpdates();
      stopBackgroundWork();
      stopUsageRefresh();
      stopNotificationView();
      stopNotifications();
      stopAppUpdates();
      stopCliUpdates();
      stopSignIns();
      stopBrowserSession();
      stopAnswers();
      window.removeEventListener('hashchange', notificationHash);
      navigator.serviceWorker?.removeEventListener('message', notificationMessage);
      cancelTouchMenu();
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      stopViewport();
      stopDrawerSwipe();
      clearTimeout(drawerSettleTimer);
      clearTimeout(focusTimer);
      clearInterval(loginPoll);
      clearInterval(usagePoll);
      clearTimeout(dayTimer);
      clearInterval(relayPoll);
      clearInterval(wslPoll);
      clearInterval(serverPoll);
      clearInterval(abandonPoll);
      clearInterval(continuePoll);
      clearTimeout(jobResumeTimer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('blur', saveDraftsOnLeave);
      window.removeEventListener('pagehide', saveDraftsOnLeave);
      document.removeEventListener('visibilitychange', saveDraftsWhenHidden);
    };
  });
  // Whether the desktop app still answers this window: a banner while it does not, and a record
  // of the calls left waiting for its diagnostics (docs/DIAGNOSTICS.md).
  function watchAppAnswers() {
    if (!desktop()) return () => {};
    const earlier = takeRememberedStall();
    if (earlier) void recordWindowStall(earlier).catch(() => rememberStall(earlier));
    let stall: WindowStall | undefined;
    const answers = watchAnswers({
      check: (shown) => windowHeartbeat(shown),
      stalled: (started, waitedMs) => {
        appNotAnswering = !!started;
        if (started) {
          stall = {
            noticedAt: Date.now(),
            unansweredMs: waitedMs,
            answeredAfterMs: null,
            calls: waitingCalls(),
          };
          rememberStall(stall);
        } else if (stall) {
          const answered = { ...stall, answeredAfterMs: waitedMs };
          stall = undefined;
          takeRememberedStall();
          void recordWindowStall(answered).catch(() => rememberStall(answered));
        }
      },
    });
    document.addEventListener('visibilitychange', answers.check);
    const stopFallbackWatch = watchIpcFallback(
      (fallback) => void recordIpcFallback(fallback).catch(() => {}),
    );
    return () => {
      answers.stop();
      stopFallbackWatch();
      document.removeEventListener('visibilitychange', answers.check);
    };
  }
  /** Polls the relay. `now` publishes a change at once, after any poll already under way. */
  async function syncNow(now = false) {
    const version = relaySelectionVersion;
    try {
      const peers = await (now ? pollRelayNow() : pollRelay());
      if (peers) {
        followNotification();
        // The open chat's work, when reading it failed before.
        void showWork();
        presence = peers;
        // An account signed in on another computer reads connected once that computer says so.
        if (pendingSignIns.size) noteSignIn();
        syncError = '';
        // A conversation whose images the relay lacks is named here while every other one syncs.
        syncNotice = relaySyncNotice();
        syncStatus = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
    } catch (e) {
      if (version !== relaySelectionVersion) return;
      syncError = String(e);
      presence = presence.map((p) => ({ ...p, online: false }));
    }
  }
  async function pair(url: string, key: string) {
    ++relaySelectionVersion;
    await persist();
    try {
      await connectRelay(url, key);
    } catch (error) {
      syncError = String(error).replace(/^Error: /, '');
      if (error instanceof BrowserWorkspaceStorageError) {
        loaded = false;
        paired = false;
        relayRestorePending = false;
        storageError = error.message;
      }
      throw error;
    }
    paired = true;
    relayRestorePending = false;
    await syncNow();
    if (!desktop() && paired) {
      view = 'chat';
      notificationTarget = notificationConversation(window.location.hash);
      followNotification();
    }
    if (!active && !draftComputerId) draftComputerId = computers[0]?.id ?? '';
  }
  async function unpair() {
    ++relaySelectionVersion;
    await disconnectRelay();
    paired = false;
    relayRestorePending = false;
    presence = [];
    syncError = '';
    syncNotice = '';
    syncStatus = '';
  }
  // Changes to be synchronized, so relay polls can skip the whole-workspace sync while nothing
  // changed. Streamed reply events count too, because they update messages before a save.
  let localChanges = 0;
  // Copies of conversations for syncing and saving. Each shares with the one before it every
  // message and call that did not change, so a reply running in a long chat costs a poll and a
  // save what it changed, not the whole chat (src/lib/chat-snapshots.ts). Tests check each copy
  // against a full parse.
  const verifyingCopies = !!(globalThis as { studioVerifySnapshots?: boolean })
    .studioVerifySnapshots;
  const snapshots = createChatSnapshots({ verify: verifyingCopies });
  // What changed here since the last save and the last sync: named conversations, the replicated
  // settings, or everything when a change names nothing (src/lib/change-marks.ts). A change that
  // names its message, as each event of a running reply does, leaves the other messages' copies
  // as they are.
  const marks = createChangeMarks((chatId, messageId) => {
    if (chatId === undefined) snapshots.touchAll();
    else snapshots.touch(chatId, messageId);
    // Tests read a copy after every change, so an edit the copies would miss shows at the next.
    if (verifyingCopies && chatId !== undefined)
      queueMicrotask(() => {
        const conversation = workspace.conversations.find((c) => c.id === chatId);
        if (!conversation) return;
        try {
          chatCopy(conversation);
        } catch {
          // Logged by `chatCopy`.
        }
      });
  });
  /** A detached, validated copy of a conversation this device holds, as it syncs and saves it. */
  function chatCopy(conversation: Conversation): Conversation {
    try {
      return snapshots.read(conversation);
    } catch (error) {
      if (verifyingCopies) console.error('[chat-snapshots]', String(error));
      throw error;
    }
  }
  /** Whether this window runs a reply on the given connection itself, rather than a relay job. */
  function runsHere(connectionId?: string) {
    if (!desktop()) return false;
    if (!connectionId) return true;
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    return (
      !!connection && executionHost(workspace.fleet, connection.environmentId) === installation?.id
    );
  }
  /** Checks any connection this device owns whose status is not known yet. */
  function refreshNewConnections() {
    if (
      workspace.fleet.connections.some(
        (c) =>
          executionHost(workspace.fleet, c.environmentId) === installation?.id &&
          !connectionStatuses[c.id],
      )
    )
      void refreshConnections();
  }
  /**
   * Copies of these conversations for the desktop app to save as bytes. A save must never fail
   * over a conversation the schema refuses, so without a copy of each they are saved as they are.
   */
  function savedCopies(conversations: Conversation[]): Conversation[] | undefined {
    if (!desktop()) return;
    try {
      return conversations.map(chatCopy);
    } catch {
      return;
    }
  }
  async function flushWorkspace() {
    if (!loaded) return;
    const scope = workspaceStorageScope();
    // Saving serializes the workspace anyway, so copying it first only walked every
    // conversation twice. The queued save keeps this workspace and writes its newest state,
    // which is what the file should hold; a later reassignment cannot redirect it.
    const saved = workspace;
    const pending = marks.takeUnsaved();
    const next = saveQueue.catch(() => {}).then(async () => {
      const started = performance.now();
      try {
        // Resolve the named conversations when the save runs, so it sends their newest state.
        const changed = pending && saved.conversations.filter((c) => pending.has(c.id));
        await saveWorkspace(saved, scope, changed, changed && savedCopies(changed));
      } finally {
        lastSaveMs = performance.now() - started;
      }
    });
    saveQueue = next;
    // A save the app leaves unanswered says so, while replies and the page carry on.
    const unanswered = setTimeout(() => {
      if (!storageError) storageError = 'Changes are not being saved.';
    }, saveWarning);
    try {
      await next;
      storageError = '';
    } catch (e) {
      // A failed save must never leave its conversations looking saved.
      marks.failedSave();
      storageError = `Changes could not be saved: ${String(e)}`;
      throw e;
    } finally {
      clearTimeout(unanswered);
    }
  }
  const saveWarning = 30_000;
  // A reply waits this long for its message to be saved, then starts anyway: a save the app never
  // answers held every new reply at Responding for an hour on 2026-10-08.
  const replySaveWait = 10_000;
  function within<T>(work: Promise<T>, ms: number): Promise<T | void> {
    return Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
  }
  /**
   * Saves and publishes every conversation and setting: for changes nobody named. `local = false`
   * stores what arrived from the relay without publishing it back.
   */
  async function persist(local = true) {
    if (!loaded) return;
    if (local) {
      localChanges++;
      marks.chat();
    } else marks.received();
    await flushWorkspace();
  }
  /** Saves and publishes a change to one conversation, leaving the rest to the host's last write. */
  async function persistChat(chatId: string) {
    if (!loaded) return;
    localChanges++;
    marks.chat(chatId);
    await flushWorkspace();
  }
  /** Saves and publishes the replicated settings: computers, accounts, templates, instructions. */
  async function persistSettings() {
    if (!loaded) return;
    localChanges++;
    marks.meta();
    await flushWorkspace();
  }
  /** Saves what this device keeps to itself, such as remembered choices, publishing nothing. */
  async function persistLocal() {
    if (!loaded) return;
    marks.local();
    await flushWorkspace();
  }
  /** Writes whatever is still unsaved, and waits for saves already queued. */
  async function flushPending() {
    if (marks.unsaved()) await flushWorkspace();
    else await saveQueue.catch(() => {});
  }
  // How long the last save took, so a streamed reply can keep saving to a small share of the
  // time. A save writes the whole workspace, so it grows with the workspace and no frequency
  // makes it free; the reply's own end, its plans, questions and file changes still save at once.
  let lastSaveMs = 0;
  const streamSaveInterval = () => Math.min(15_000, Math.max(1_000, lastSaveMs * 50));
  // A streamed reply asks to save far faster than a large workspace can be written. Each save
  // writes the newest state, so requests made while one runs only need one more save after it.
  let savingSoon = false;
  let saveAgain = false;
  /**
   * Saves and publishes a change to one conversation soon, or every one when none is named.
   * `messageId` names the only message of it that changed.
   */
  function saveSoon(chatId?: string, messageId?: string) {
    marks.chat(chatId, messageId);
    scheduleSave();
  }
  /** Saves and publishes a change to the replicated settings soon. */
  function saveSettingsSoon() {
    marks.meta();
    scheduleSave();
  }
  /** Saves remembered choices and other state this device keeps to itself soon. */
  function saveLocalSoon() {
    marks.local();
    scheduleSave();
  }
  function scheduleSave() {
    saveAgain = true;
    if (savingSoon) return;
    void (async () => {
      savingSoon = true;
      try {
        while (saveAgain) {
          saveAgain = false;
          localChanges++;
          await flushWorkspace().catch(() => {});
        }
      } finally {
        savingSoon = false;
      }
    })();
  }
  async function restartToUpdate() {
    // Finish saving this workspace and its drafts before the installer closes the app.
    await saveDraftsNow();
    await persist();
    await installAppUpdate();
  }
  async function restartFromSidebar() {
    if (restartingForUpdate) return;
    restartingForUpdate = true;
    try {
      await restartToUpdate();
    } catch (e) {
      notice = String(e);
    } finally {
      restartingForUpdate = false;
    }
  }
  /**
   * Shut down when chats finish (src/lib/shutdown-watch.ts): the work this computer has left. Its
   * replies, those this window is starting here and those it runs for other devices, the messages
   * queued behind a running reply, the chats it goes on with after a usage limit, and the workflow
   * runs it drives.
   */
  function shutdownWork(running: readonly string[]): Waiting {
    const starting = Object.entries(runs).flatMap(([id, runId]) => {
      const conversation = workspace.conversations.find((c) => c.id === id);
      const reply = conversation?.messages.findLast((m) => m.runId === runId);
      return runsHere(reply?.settings?.connectionId ?? conversation?.settings.connectionId)
        ? [id]
        : [];
    });
    const chats = unfinishedChats(workspace.conversations, {
      running: [...running, ...starting, ...chatsRunningForOthers()],
      queued,
      replying: conversationRunning,
      // A chat whose account cannot answer, such as one signed out, never goes on by itself.
      continuesHere: (c) => drivesContinue(c) && readyToSend(c),
    });
    return { chats: chats.size, workflows: workflows.drivenRuns() };
  }
  /** What the computer keeps before it turns off: drafts and chats, published as they stand. */
  async function beforeShutdown() {
    await saveDraftsNow();
    await flushWorkspace();
    if (paired) await within(syncNow(true), 15_000);
  }
  const shutdown = new ShutdownWatch(shutdownWork, beforeShutdown, (message) => (notice = message));
  const shutdownTitle = $derived.by(() => {
    const waiting = shutdown.state.phase === 'watching' ? waitingText(shutdown.waiting) : '';
    return waiting ? `Shut down when chats finish · ${waiting}` : 'Shut down when chats finish';
  });
  function toggleShutdown() {
    void shutdown.toggle().catch((e) => (notice = String(e).replace(/^Error: /, '')));
  }
  // A watch left on before the window reloaded goes on once the chats are read.
  $effect(() => {
    if (loaded && desktop() && !installation?.server) untrack(() => void shutdown.start());
  });
  function openRewind(messageId?: string) {
    if (!active?.messages.some((m) => m.role === 'user')) {
      historyError = 'There are no messages to rewind.';
      return;
    }
    if (activeRunning || historyBusy || activeQueue.length) {
      historyError = 'Wait for the response and queued messages to finish before rewinding.';
      return;
    }
    historyError = '';
    // A clicked message is the one to return to, so it rewinds at once: Undo rewind takes it
    // back. /rewind asks which message.
    if (messageId) {
      const id = active.id;
      void changeHistory(messageId).catch((e) => {
        if (activeId === id) historyError = String(e);
      });
      return;
    }
    historyAction = {
      kind: 'rewind',
      conversationId: active.id,
      session: workspaceSession,
    };
  }
  function openUndoFiles(runId?: string) {
    if (!active || activeRunning || historyBusy || activeQueue.length) {
      historyError = 'Open an idle conversation before Undo.';
      return;
    }
    const target =
      runId ??
      active.messages.findLast(
        (m) => m.role === 'assistant' && m.fileChanges?.edits.length && !m.filesUndone,
      )?.runId;
    if (!target) {
      historyError = 'There are no recorded file edits to undo.';
      return;
    }
    historyError = '';
    historyAction = {
      kind: 'files',
      conversationId: active.id,
      runId: target,
      session: workspaceSession,
    };
  }
  // What a rewind in this window put in a conversation's composer and what it replaced there,
  // so Undo rewind can take back a returned message left as it was.
  const rewoundDrafts = new Map<
    string,
    { rewind: string; before: DraftContent; after: DraftContent }
  >();
  // A conversation's composer content, whether it is open or kept for its return.
  function draftOf(id: string): DraftContent {
    const key = draftKey.chat(id);
    return (
      (key === composerDraftKey ? composerContent() : drafts.get(key)) ?? {
        text: '',
        images: [],
        mentions: [],
        staleMentions: [],
        mentionScope: '',
      }
    );
  }
  function setDraftOf(id: string, content: DraftContent) {
    const key = draftKey.chat(id);
    if (key === composerDraftKey) applyComposer(content);
    else if (hasDraft(content)) {
      drafts.set(key, { ...content, updatedAt: Date.now() });
      draftChanged(key);
    } else forgetDraft(key);
  }
  // A rewound message returns to its open composer ahead of the draft, replacing one an earlier
  // rewind returned there that is still as it was. The function given back undoes this, for a
  // rewind that could not be saved.
  function returnToComposer(
    before: Conversation,
    next: Conversation,
    returning: Awaited<ReturnType<typeof rewoundMessage>>,
  ) {
    const draft = draftOf(next.id),
      earlier = rewoundDrafts.get(next.id);
    const base =
      earlier && earlier.rewind === before.rewind?.createdAt && sameReturned(draft, earlier.after)
        ? earlier.before
        : draft;
    const restored = returnedDraft(base, returning.message, {
      connectionId: selectedSettings.connectionId,
      mentionScope: mentionSelection,
    });
    setDraftOf(next.id, restored.draft);
    rewoundDrafts.set(next.id, {
      rewind: next.rewind!.createdAt,
      before: base,
      after: restored.draft,
    });
    const { unread } = returning;
    attachmentError = unread
      ? `${unread} image${unread === 1 ? '' : 's'} of the rewound message could not be read. Undo rewind restores the message with ${unread === 1 ? 'it' : 'them'}.`
      : '';
    return () => {
      if (sameReturned(draftOf(next.id), restored.draft)) setDraftOf(next.id, draft);
      if (earlier) rewoundDrafts.set(next.id, earlier);
      else rewoundDrafts.delete(next.id);
    };
  }
  // Undo rewind takes the returned message back out of the composer while it is as the rewind
  // left it. The function given back returns it again, for an undo that could not be saved.
  function takeBackReturned(before: Conversation) {
    const placed = rewoundDrafts.get(before.id);
    rewoundDrafts.delete(before.id);
    const taken =
      !!placed &&
      placed.rewind === before.rewind?.createdAt &&
      sameReturned(draftOf(before.id), placed.after);
    if (placed && taken) {
      setDraftOf(before.id, placed.before);
      attachmentError = '';
    }
    return () => {
      if (!placed) return;
      if (taken && sameReturned(draftOf(before.id), placed.before))
        setDraftOf(before.id, placed.after);
      rewoundDrafts.set(before.id, placed);
    };
  }
  async function changeHistory(messageId?: string) {
    if (!active || activeRunning || historyBusy || activeQueue.length)
      throw new Error('Wait for the response to finish before rewinding.');
    const id = active.id,
      session = workspaceSession;
    let before: Conversation | undefined,
      restoreComposer = () => {};
    historyBusy = true;
    try {
      // A rewound message returns to the composer, its images read back into memory first.
      const returning = messageId
        ? await rewoundMessage(active, messageId, readChatImage)
        : undefined;
      if (session !== workspaceSession || active?.id !== id) return;
      before = $state.snapshot(active);
      const next = messageId ? rewindConversation(before, messageId) : undoRewind(before);
      workspace.conversations = workspace.conversations.map((c) => (c.id === next.id ? next : c));
      restoreComposer = returning
        ? returnToComposer(before, next, returning)
        : takeBackReturned(before);
      await persistChat(next.id);
      if (session !== workspaceSession) return;
      await releaseConversation(next.id, next.settings.connectionId).catch(() => {});
      delete artifactViews[next.id];
      historyError = '';
      // The conversation now ends elsewhere: drop held space and show the new end.
      virtualSpace?.clear();
      nearBottom = true;
      void scrollToEnd();
      // The control that started this is usually gone; continue in the composer.
      void tick().then(() =>
        requestAnimationFrame(() => {
          if (!historyAction && session === workspaceSession)
            composerInput?.focus({ preventScroll: true });
        }),
      );
    } catch (e) {
      if (session === workspaceSession && before) {
        const saved = before;
        workspace.conversations = workspace.conversations.map((c) =>
          c.id === saved.id ? saved : c,
        );
        restoreComposer();
      }
      throw e;
    } finally {
      if (session === workspaceSession) historyBusy = false;
    }
  }
  async function prepareUndo(conversationId: string, session: number) {
    if (
      session !== workspaceSession ||
      !active ||
      active.id !== conversationId ||
      activeRunning
    )
      throw new Error('The conversation changed. Reopen Undo.');
    // Undo reads this conversation from the saved file, so it must be there as shown.
    await persistChat(conversationId);
  }
  async function markFilesUndone(conversationId: string, runId: string, session: number) {
    if (session !== workspaceSession) return;
    const conversation = workspace.conversations.find((c) => c.id === conversationId);
    const message = conversation?.messages.find((m) => m.runId === runId);
    if (!conversation || !message) return;
    if (!message.filesUndone) {
      message.filesUndone = true;
      conversation.historyRevision = (conversation.historyRevision ?? 0) + 1;
    }
    conversation.updatedAt = new Date().toISOString();
    await persistChat(conversation.id);
  }
  async function updateInputTemplate(
    template: InputTemplate | undefined,
    previous?: InputTemplate,
  ) {
    const session = workspaceSession;
    const before = $state.snapshot(workspace.inputTemplates);
    const current = before?.find((item) => item.id === (previous?.id ?? template?.id));
    if (JSON.stringify(current) !== JSON.stringify(previous))
      throw new Error(
        'This template changed on another device. Reopen it from the library before editing.',
      );
    const next = inputTemplatesSchema.parse(
      template
        ? previous
          ? (before ?? []).map((item) => (item.id === template.id ? template : item))
          : [...(before ?? []), template]
        : (before ?? []).filter((item) => item.id !== previous?.id),
    );
    workspace.inputTemplates = next;
    try {
      await persistSettings();
    } catch {
      if (
        session === workspaceSession &&
        JSON.stringify(workspace.inputTemplates) === JSON.stringify(next)
      )
        workspace.inputTemplates = before;
      throw new Error('The template could not be saved. Your changes are still here; try again.');
    }
  }
  async function saveClaudeInstructions(value: string | undefined, previous: string | undefined) {
    const session = workspaceSession;
    const before = workspace.claudeInstructions;
    if (before !== previous)
      throw new Error(
        'These instructions changed on another device. Save again to replace them with your text.',
      );
    workspace.claudeInstructions = value;
    try {
      await persistSettings();
    } catch {
      if (session === workspaceSession && workspace.claudeInstructions === value)
        workspace.claudeInstructions = before;
      throw new Error('The instructions could not be saved. Your text is still here; try again.');
    }
  }
  function closeTemplates() {
    templatesOpen = false;
    void tick().then(() => composerInput?.focus());
  }
  async function refresh(forceUsage = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshWsl();
      await refreshCliInventories();
      statuses = await detectProviders();
      if (installation)
        environmentLogins[installation.id] = Object.fromEntries(statuses.map((s) => [s.id, s]));
      // Connected accounts report their own login identities first, so a terminal login of an
      // account connected elsewhere on this computer joins that account's label, not a new one.
      await refreshConnections();
      const before = workspace.fleet.connections.length;
      const detected = (environmentId: string) => {
        const inventory = cliInventories[environmentId];
        return inventory?.error || !inventory?.entries
          ? undefined
          : inventory.entries.filter((entry) => entry.path).map((entry) => entry.id);
      };
      const own = workspace.fleet.environments.filter(
        (e) => executionHost(workspace.fleet, e.id) === installation?.id,
      );
      // This computer's own logins first, saved and checked (an account's check reads its saved
      // connection) before its WSL distributions take its accounts.
      for (const environment of own.filter((e) => !e.discoveredOn)) {
        const providers = detected(environment.id);
        if (providers)
          ensureEnvironmentConnections(
            workspace.fleet,
            environment.id,
            providers,
            loginIdentities(),
          );
      }
      if (workspace.fleet.connections.length !== before) {
        await persistSettings();
        await refreshConnections(undefined, true);
      }
      const added = workspace.fleet.connections.length;
      let distributions = false;
      for (const environment of own.filter((e) => e.discoveredOn)) {
        const providers = detected(environment.id);
        if (!providers) continue;
        await probeEnvironmentLogins(environment.id, providers);
        distributions = addDistributionAccounts(environment.id, providers) || distributions;
        ensureEnvironmentConnections(workspace.fleet, environment.id, providers, loginIdentities());
      }
      if (workspace.fleet.connections.length !== added) {
        await persistSettings();
        await refreshConnections(undefined, true);
      } else if (distributions) await persistLocal();
      if (view === 'connections') void refreshAccountUsage(forceUsage);
      noteSignIn();
    } catch (e) {
      notice = String(e);
    } finally {
      refreshing = false;
    }
  }
  // Sign-in finishes in the browser or a terminal, whatever replies run meanwhile, so each
  // account signed in to here is followed by checking that account alone until it reports
  // ready. A provider's own login is followed by refreshing everything.
  async function checkSignIn() {
    const now = Date.now();
    const accounts: Connection[] = [];
    let everything = false;
    for (const [key, pending] of pendingSignIns) {
      if (pending.until <= now) {
        pendingSignIns.delete(key);
        continue;
      }
      const connection = workspace.fleet.connections.find((c) => c.id === pending.connectionId);
      if (
        connection &&
        executionHost(workspace.fleet, connection.environmentId) === installation?.id
      )
        accounts.push(connection);
      // Another computer checks its own accounts and reports them with its heartbeat.
      else if (!connection) everything = true;
    }
    if (everything) await refresh();
    await Promise.all(
      accounts.map(async (connection) => {
        await connectionChecks.get(connection.id);
        await checkConnection(connection);
      }),
    );
    noteSignIn();
  }
  // An account's status as this computer checked it, or as its own computer reports it.
  function reportedStatus(connectionId: string) {
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    const host = connection && executionHost(workspace.fleet, connection.environmentId);
    if (!connection || host === installation?.id) return connectionStatuses[connectionId];
    return presence
      .find((p) => p.environmentId === host && p.online)
      ?.connections.find((c) => c.connectionId === connectionId);
  }
  function noteSignIn() {
    for (const [key, pending] of pendingSignIns) {
      const status = pending.connectionId
        ? reportedStatus(pending.connectionId)
        : statuses.find((s) => s.id === pending.provider);
      if (status?.auth !== 'ready') continue;
      pendingSignIns.delete(key);
      endSignInPrompt(key);
    }
  }
  function endSignInPrompt(key: string) {
    if (signInPrompt?.key !== key) return;
    if (notice === signInPrompt.text) notice = '';
    signInPrompt = undefined;
  }
  async function refreshWsl() {
    if (installation?.platform !== 'windows' || wslRefreshing) return;
    wslRefreshing = true;
    try {
      const discovery = await discoverWsl();
      wslDiscovery = discovery;
      wslError = discovery.warning ?? '';
      const before = JSON.stringify(workspace.fleet);
      registerWslEnvironments(workspace.fleet, installation, discovery);
      if (JSON.stringify(workspace.fleet) !== before) await persistSettings();
    } catch (e) {
      wslError = String(e);
    } finally {
      wslRefreshing = false;
    }
  }
  async function refreshConnections(location?: ChatLocation, missingOnly = false) {
    if (!desktop() || !installation) return;
    await Promise.all(
      workspace.fleet.connections
        .filter(
          (c) =>
            executionHost(workspace.fleet, c.environmentId) === installation?.id &&
            (!location || c.environmentId === locationExecutionId(location)) &&
            (!missingOnly || !connectionStatuses[c.id]),
        )
        .map(checkConnection),
    );
  }
  function checkConnection(c: Connection) {
    const pending = connectionChecks.get(c.id);
    if (pending) return pending;
    const account = workspace.fleet.accounts.find((a) => a.id === c.accountId);
    if (!account) return;
    connectionCheckedAt.set(c.id, Date.now());
    const check = detectConnection(account.provider, c.id)
      .then((status) => {
        connectionStatuses[c.id] = status;
      })
      .catch((e) => {
        connectionStatuses[c.id] = {
          id: account.provider,
          installed: false,
          auth: 'unknown',
          version: null,
          detail: String(e),
          checkFailed: true,
        };
      })
      .finally(() => {
        connectionChecks.delete(c.id);
      });
    connectionChecks.set(c.id, check);
    return check;
  }
  // A Claude or Codex login can lapse between refreshes, which wait for replies running here:
  // the CLI finds out when a reply or a usage reading next tries to renew it, and reports the
  // account signed out from then on. These checks of named accounts on this computer run
  // whatever replies do, at most every ten seconds each unless `force`d after such a failure.
  async function recheckConnections(ids: string[], force = false) {
    if (!desktop() || !installation) return;
    const now = Date.now();
    await Promise.all(
      workspace.fleet.connections
        .filter(
          (c) =>
            ids.includes(c.id) &&
            executionHost(workspace.fleet, c.environmentId) === installation?.id &&
            workspace.fleet.accounts.some(
              (a) => a.id === c.accountId && (a.provider === 'claude' || a.provider === 'codex'),
            ) &&
            (force || now - (connectionCheckedAt.get(c.id) ?? 0) >= 10_000),
        )
        .map(async (c) => {
          // A check already under way may have read the login before the renewal failed.
          if (force) await connectionChecks.get(c.id);
          await checkConnection(c);
        }),
    );
  }
  // Managed WSL distributions have no provider-level status; check their existing logins only
  // while no account of that agent is connected there, the only time detection adds one.
  async function probeEnvironmentLogins(environmentId: string, detected: ProviderId[]) {
    const missing = detected.filter(
      (provider) => !environmentOffers(workspace.fleet, environmentId, provider),
    );
    await Promise.all(
      missing.map(async (provider) => {
        let status: ProviderStatus;
        try {
          status = await detectEnvironmentLogin(environmentId, provider);
        } catch (e) {
          status = {
            id: provider,
            installed: false,
            auth: 'unknown',
            version: null,
            detail: String(e),
          };
        }
        environmentLogins[environmentId] = {
          ...environmentLogins[environmentId],
          [provider]: status,
        };
      }),
    );
  }
  // This computer's accounts join each WSL distribution it manages by themselves, once each, so
  // one removed there stays removed. Returns whether the accounts it remembers changed.
  function addDistributionAccounts(environmentId: string, detected: ProviderId[]) {
    const remembered = workspace.preferences.distributionAccounts?.[environmentId] ?? [];
    const known = new Set(remembered);
    for (const provider of detected)
      addHostAccounts(
        workspace.fleet,
        environmentId,
        provider,
        known,
        (id) => connectionStatus(id)?.auth === 'ready',
        loginIdentities(),
      );
    const accounts = [...known].filter((id) => workspace.fleet.accounts.some((a) => a.id === id));
    if (accounts.length === remembered.length && accounts.every((id, i) => id === remembered[i]))
      return false;
    workspace.preferences.distributionAccounts = {
      ...workspace.preferences.distributionAccounts,
      [environmentId]: accounts,
    };
    return true;
  }
  function loginIdentities(): LoginIdentities {
    return {
      login: (environmentId, provider) =>
        loginIdentity(environmentLogins[environmentId]?.[provider]),
      connection: (id) => loginIdentity(connectionStatus(id)),
    };
  }
  async function refreshCliInventories() {
    if (!desktop() || !installation) return;
    await Promise.all(
      workspace.fleet.environments
        .filter((e) => executionHost(workspace.fleet, e.id) === installation?.id)
        .map(async (environment) => {
          cliInventories[environment.id] = { ...cliInventories[environment.id], checking: true };
          try {
            const entries = await inspectEnvironmentClis(environment.id);
            cliInventories[environment.id] = { entries, checking: false };
          } catch (e) {
            cliInventories[environment.id] = {
              ...cliInventories[environment.id],
              checking: false,
              error: String(e),
            };
          }
        }),
    );
  }
  function statusFor(id: ProviderId) {
    return statuses.find((s) => s.id === id);
  }
  function environmentOnline(environmentId: string) {
    const host = executionHost(workspace.fleet, environmentId);
    if (desktop() && host === installation?.id) return true;
    return (
      paired && !syncError && online && presence.some((p) => p.environmentId === host && p.online)
    );
  }
  function computerOnline(computerId: string) {
    return (
      computers
        .find((c) => c.id === computerId)
        ?.environments.some((e) => environmentOnline(e.id)) ?? false
    );
  }
  function canQueryConnection(connectionId?: string, provider = selectedSettings.provider) {
    if (!connectionId) return desktop() && statusFor(provider)?.auth === 'ready';
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    if (!connection) return false;
    const status = connectionStatus(connectionId);
    return (
      environmentOnline(connection.environmentId) && !!status?.installed && status.auth === 'ready'
    );
  }
  function connectionStatus(id: string) {
    const connection = workspace.fleet.connections.find((c) => c.id === id);
    if (!connection) return undefined;
    const host = executionHost(workspace.fleet, connection.environmentId);
    return host === installation?.id
      ? connectionStatuses[id]
      : presence
          .find((p) => p.environmentId === host && p.online)
          ?.connections.find((c) => c.connectionId === id);
  }
  // The CLI reports this account signed out, as it also does once a reply or a usage reading
  // could not renew an expired login.
  function needsSignIn(id: string | undefined) {
    const status = id ? connectionStatus(id) : undefined;
    return !!status?.installed && status.auth === 'login';
  }
  function canChooseConnection(id: string) {
    const status = connectionStatus(id);
    if (status) return status.installed;
    const connection = workspace.fleet.connections.find((c) => c.id === id);
    // Local choices can be prepared while detection runs; sending still requires a ready result.
    return (
      !!connection &&
      desktop() &&
      executionHost(workspace.fleet, connection.environmentId) === installation?.id
    );
  }
  function modelScopeKey(settings: Pick<ChatSettings, 'provider' | 'connectionId'>) {
    const connection = workspace.fleet.connections.find((c) => c.id === settings.connectionId);
    return JSON.stringify([settings.provider, connection ?? settings.connectionId ?? null]);
  }
  const modelRefreshWarning = 'Could not refresh models.';
  function applyCliUpdates(next: CliUpdates) {
    const updated = newlyUpdated(cliUpdates, next);
    cliUpdates = next;
    if (!updated.length) return;
    forgetCatalogs(updated);
    // A check made while the update replaced the CLI may have found none there, which keeps
    // its accounts from signing in until they are checked again.
    void recheckConnections(
      workspace.fleet.connections
        .filter((c) =>
          updated.some(
            (update) =>
              update.environmentId === c.environmentId &&
              workspace.fleet.accounts.some(
                (a) => a.id === c.accountId && a.provider === update.provider,
              ),
          ),
        )
        .map((c) => c.id),
      true,
    );
  }
  // An updated CLI can offer newer models (Claude Code also resolves its aliases anew), so the
  // catalogs of that CLI in that environment are stale.
  function forgetCatalogs(updated: { provider: string; environmentId: string }[]) {
    for (const key of [...modelCache.keys()]) {
      const [provider, connection] = JSON.parse(key) as [string, unknown];
      const environmentId = (connection as { environmentId?: unknown } | null)?.environmentId;
      if (
        updated.some(
          (update) =>
            update.provider === provider &&
            (typeof environmentId !== 'string' || update.environmentId === environmentId),
        )
      )
        modelCache.delete(key);
    }
    if (updated.some((update) => update.provider === selectedSettings.provider))
      void refreshModels(true);
  }
  async function refreshModels(force = true) {
    const generation = ++modelGeneration;
    if ((!active && !selectedLocation) || !canQueryConnection(selectedSettings.connectionId)) {
      modelsLoading = false;
      return;
    }
    const selected = { ...selectedSettings };
    const key = modelScopeKey(selected);
    const cached = modelCache.get(key);
    if (!force && cached && Date.now() - cached.checkedAt < 300_000) {
      models = cached.catalog;
      modelsLoading = false;
      return;
    }
    modelsLoading = true;
    try {
      let request = modelRequests.get(key);
      if (!request) {
        // A newly created connection must reach native storage before its catalog is queried.
        request = saveQueue
          .then(() => {
            if (!canQueryConnection(selected.connectionId, selected.provider))
              throw new Error('The selected connection is unavailable.');
            return loadModels(selected);
          })
          .then((catalog) => {
            modelCache.set(key, { catalog, checkedAt: Date.now() });
            return catalog;
          })
          .finally(() => {
            modelRequests.delete(key);
          });
        modelRequests.set(key, request);
      }
      const catalog = await request;
      if (generation === modelGeneration && key === modelScopeKey(selectedSettings)) {
        models = catalog;
        if (notice === modelRefreshWarning) notice = '';
      }
    } catch (error) {
      if (error instanceof OfflineHostError) {
        const connection = workspace.fleet.connections.find((c) => c.id === selected.connectionId);
        const host = connection && executionHost(workspace.fleet, connection.environmentId);
        presence = presence.map((p) => (p.environmentId === host ? { ...p, online: false } : p));
      } else if (
        generation === modelGeneration &&
        canQueryConnection(selected.connectionId, selected.provider)
      )
        notice = modelRefreshWarning;
    } finally {
      if (generation === modelGeneration) modelsLoading = false;
    }
  }
  async function refreshUsage(
    settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'> = selectedSettings,
    force = false,
  ) {
    if (
      !canQueryConnection(settings.connectionId, settings.provider) ||
      (!settings.connectionId && !active && !selectedLocation)
    )
      return;
    const key = usageKey(settings);
    if (usageLoading[key]) return;
    usageLoading[key] = true;
    const scope = workspaceStorageScope();
    const revision = accountUsageRevision(settings.connectionId);
    const current = () =>
      scope === workspaceStorageScope() && revision === accountUsageRevision(settings.connectionId);
    try {
      await saveQueue;
      const snapshot = await readUsage(
        settings.provider,
        settings.model,
        force,
        settings.connectionId,
      );
      if (!snapshot || !Array.isArray(snapshot.windows))
        throw new Error('Usage was not reported by this CLI.');
      if (!current()) return;
      snapshot.live = snapshotFor(usageSnapshots, settings)?.live;
      usageSnapshots[key] = { ...snapshot, connectionId: settings.connectionId };
      usageErrors[key] = '';
    } catch (e) {
      if (current()) usageErrors[key] = String(e);
      // Reading usage renews an expired login first, so a failure can mean it lapsed.
      if (settings.connectionId) void recheckConnections([settings.connectionId], true);
    } finally {
      if (scope === workspaceStorageScope()) {
        usageLoading[key] = false;
        const latest = accountUsageRevision(settings.connectionId);
        if (latest?.accountChanged && (latest.epoch !== revision?.epoch || latest.accountChanged !== revision?.accountChanged))
          void refreshUsage(settings, true);
      }
    }
  }
  function refreshUsageConnection(connectionId: string) {
    const account = workspace.fleet.accounts.find(
      (a) => a.id === workspace.fleet.connections.find((c) => c.id === connectionId)?.accountId,
    );
    if (account)
      void refreshUsage(
        {
          provider: account.provider,
          connectionId,
          model: selectedSettings.connectionId === connectionId ? selectedSettings.model : '',
        },
        true,
      );
  }
  function applyAccountUpdate(update: AccountUpdate, accountChanged: boolean) {
    if (!loaded) return;
    const matching = Object.entries(usageSnapshots).filter(
      ([, snapshot]) =>
        snapshot.connectionId === update.connectionId &&
        snapshot.provider === update.snapshot.provider,
    );
    for (const [key, previous] of matching) {
      usageSnapshots[key] = mergeLiveUsage(accountChanged ? undefined : previous, update);
      usageErrors[key] = '';
    }
    if (!matching.length) {
      const key = usageKey({
        provider: update.snapshot.provider,
        connectionId: update.connectionId,
        model: '',
      });
      usageSnapshots[key] = mergeLiveUsage(undefined, update);
    }
    if (accountChanged) {
      const scope = workspaceStorageScope();
      const connection = workspace.fleet.connections.find((c) => c.id === update.connectionId);
      if (
        connection &&
        executionHost(workspace.fleet, connection.environmentId) === installation?.id
      ) {
        connectionStatuses[connection.id] = {
          id: update.snapshot.provider,
          installed: true,
          auth: update.authMode === null ? 'login' : 'unknown',
          detail: 'Account changed. Checking sign-in…',
          version: null,
        };
        void detectConnection(update.snapshot.provider, connection.id)
          .then((status) => {
            const latest = accountUsageRevision(connection.id);
            if (scope !== workspaceStorageScope() || latest?.epoch !== update.epoch || latest.accountChanged !== update.accountChanged)
              return;
            connectionStatuses[connection.id] = status;
            refreshUsageConnection(connection.id);
            if (selectedSettings.connectionId === connection.id) void refreshModels();
          })
          .catch(() => {});
      } else refreshUsageConnection(update.connectionId);
    }
  }
  async function refreshAccountUsage(force = false) {
    await Promise.all(accountUsageTargets.map((settings) => refreshUsage(settings, force)));
  }
  // `/fast` turns Fast mode on or off for the next reply, and `/fast on`, `/fast off` and
  // `/fast default` set it; only a model that offers it turns it on.
  function commandFastMode(command: string) {
    const fastMode =
      command === 'fast'
        ? !selectedSettings.fastMode
        : command === 'fast:default'
          ? undefined
          : command === 'fast:on';
    if (fastMode && !fastOffered) {
      notice = 'This model has no Fast mode.';
      return;
    }
    changeSettings({ ...selectedSettings, fastMode });
    notice = fastMode
      ? (fastModeBlock(currentModel) ??
        (currentModel.fastModeDetail
          ? `Fast mode on for the next reply · ${currentModel.fastModeDetail}`
          : 'Fast mode on for the next reply; it costs more usage.'))
      : fastMode === false
        ? 'Fast mode off for the next reply.'
        : 'Fast mode follows the CLI default.';
  }
  // `chosen` marks an agent or account the user picked, which new chats then start with.
  function changeSettings(settings: ChatSettings, remember = true, chosen = false) {
    if (!loaded) return;
    // Only the next request's account, model, reasoning and Fast mode may change while a reply
    // is running.
    if (
      activeRunning &&
      (settings.provider !== selectedSettings.provider ||
        !!settings.planMode !== !!selectedSettings.planMode ||
        settings.outputSchema !== selectedSettings.outputSchema ||
        settings.maxThinkingTokens !== selectedSettings.maxThinkingTokens ||
        settings.fallbackModel !== selectedSettings.fallbackModel ||
        settings.instructions !== selectedSettings.instructions)
    )
      return;
    // The agent stays fixed; its account may change between replies to an offered one.
    if (
      active &&
      (settings.provider !== active.settings.provider ||
        (settings.connectionId !== active.settings.connectionId &&
          !switchableConnections.some((c) => c.id === settings.connectionId)))
    )
      return;
    settingsRevision++;
    if (workflowChat)
      rememberWorkflowAgent({
        provider: settings.provider,
        connectionId: settings.connectionId ?? '',
        model: settings.model,
        reasoning: settings.reasoning,
      });
    else {
      if (remember) rememberSettings(workspace.preferences, settings);
      if (chosen) rememberAgent(workspace.preferences, settings);
    }
    // An account chosen for a new chat stays, whatever the accounts' usage.
    if (chosen && !active) followBalance(false);
    if (active) {
      active.settings = settings;
      active.updatedAt = new Date().toISOString();
      saveSoon(active.id);
    } else {
      // A new chat's settings live in its draft; only the remembered choices are saved.
      draftSettings = settings;
      saveLocalSoon();
    }
  }
  function chooseProvider(value: string) {
    if (active) return;
    if (selectedLocation && !availableProviders.includes(value as ProviderId)) return;
    const settings = settingsFor(workspace.preferences, value as ProviderId);
    if (workflowChat) {
      const remembered = workflowAgent(value as ProviderId);
      if (remembered.model) settings.model = remembered.model;
      settings.reasoning = remembered.reasoning;
    }
    if (selectedLocation)
      settings.connectionId = preferredConnection(settings.provider, selectedLocation);
    const model = models[settings.provider].find((m) => m.id === settings.model);
    if (
      !workflowChat &&
      workspace.preferences.reasoningByProvider[settings.provider]?.[settings.model] ===
        undefined &&
      model
    )
      settings.reasoning = model.defaultReasoning;
    changeSettings(
      {
        ...settings,
        instructions: selectedSettings.instructions,
        outputSchema: settings.provider === 'gemini' ? undefined : selectedSettings.outputSchema,
      },
      true,
      true,
    );
  }
  function chooseAgent(value: string) {
    const option = agentOptions.find((option) => option.id === value);
    if (!option) return;
    selectAgent(option);
    // An account that needs signing in is chosen and shown in Connections, where its sign-in is.
    if (option.attention && option.connectionId) openConnections(option.connectionId);
  }
  function selectAgent(option: (typeof agentOptions)[number]) {
    if (active) {
      // Only another account of the same agent may take over an existing conversation, from its
      // next message on, also while a reply runs.
      if (!option.connectionId || !switchableConnections.some((c) => c.id === option.connectionId))
        return;
      changeSettings({ ...selectedSettings, connectionId: option.connectionId }, true, true);
      return;
    }
    if (!option.id.startsWith('connection:')) {
      chooseProvider(option.provider);
      return;
    }
    if (!option.connectionId || !canChooseConnection(option.connectionId)) return;
    const settings =
      option.provider === selectedSettings.provider
        ? selectedSettings
        : settingsFor(workspace.preferences, option.provider);
    changeSettings(
      {
        ...settings,
        connectionId: option.connectionId,
        instructions: selectedSettings.instructions,
        outputSchema: settings.provider === 'gemini' ? undefined : selectedSettings.outputSchema,
      },
      true,
      true,
    );
  }
  // Connections opened for an account scrolls to it and marks it until the page is left, so
  // the chat and its draft are kept for the way back.
  function openConnections(connectionId?: string) {
    connectionsHighlight = connectionId ?? '';
    view = 'connections';
  }
  $effect(() => {
    if (view !== 'connections') untrack(() => (connectionsHighlight = ''));
  });
  function chooseModel(model: string) {
    const levels = availableModels.find((m) => m.id === model)?.reasoningLevels ?? [];
    // A workflow chat keeps its reasoning where the model has it, else the model's highest.
    const reasoning = workflowChat
      ? levels.includes(selectedSettings.reasoning)
        ? selectedSettings.reasoning
        : highestReasoning(levels)
      : (workspace.preferences.reasoningByProvider[selectedSettings.provider]?.[model] ??
        availableModels.find((m) => m.id === model)?.defaultReasoning ??
        '');
    changeSettings({ ...selectedSettings, model, reasoning });
  }
  // A chat started on a computer or in a folder is revealed in the sidebar and focused, unless
  // `reveal` is false, as when Move to history continues in the folder it left. `connectionId`
  // is an account the user named for the chat unless `named` is false, as for `/new`, which
  // goes on from the chat it was typed in.
  function newChat(
    provider?: ProviderId,
    connectionId?: string,
    location?: ChatLocation,
    computerId?: string,
    reveal = true,
    named = true,
    // A chat that starts a workflow or mission, or becomes a workflow's assistant chat.
    flow?: ScratchWorkflow,
  ) {
    if (!loaded || selectingLocation) return;
    // Opening a chat on a computer can register its CLI logins as connections.
    const connections = workspace.fleet.connections.length;
    templatesOpen = false;
    sidebarOpen = false;
    folderBrowserOpen = false;
    locationGeneration++;
    if (!flow) conversationScope = 'active';
    locationPending = false;
    draftSettings = settingsFor(workspace.preferences, provider);
    if (flow) {
      // Claude at its maximum reasoning, until other choices are remembered.
      const agent = workflowAgent(provider);
      draftSettings = {
        ...draftSettings,
        provider: agent.provider,
        ...(agent.model ? { model: agent.model } : {}),
        reasoning: agent.reasoning,
        instructions: '',
        // The account chosen last, where it is connected.
        ...(agent.connectionId && agent.connectionId !== WORKFLOW_ACCOUNT
          ? { connectionId: agent.connectionId }
          : {}),
      };
    }
    // A new chat on a WSL folder runs inside its distribution, whichever folder or recent
    // location it starts from.
    const recent = (workspace.preferences.recentLocations ?? []).map((l) =>
      insideDistribution(workspace.fleet, l),
    );
    draftLocation = location
      ? insideDistribution(workspace.fleet, { ...location })
      : computerId
        ? undefined
        : recent.find((l) => locationConnections(workspace.fleet, l).length);
    if (computerId) draftComputerId = computerId;
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    // An account named for the chat is the user's choice; otherwise balancing may choose one.
    draftBalanced = !!workspace.preferences.balanceAccounts && !(connection && named);
    if (connection) {
      const environment = workspace.fleet.environments.find(
        (e) => e.id === connection.environmentId,
      );
      draftComputerId = environment ? computerViewId(environment) : '';
      draftLocation =
        recent.find((l) => locationExecutionId(l) === connection.environmentId) ??
        (environment
          ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
          : undefined);
      draftSettings.connectionId = connection.id;
    } else {
      draftLocation ??= standaloneLocation(draftComputerId);
      if (draftLocation) {
        ensureLocationConnections(workspace.fleet, draftLocation, loginIdentities());
        draftComputerId = locationComputerId(draftLocation);
        draftSettings = settingsAtLocation(draftSettings, draftLocation);
      } else delete draftSettings.connectionId;
    }
    if (draftLocation && !draftLocation.path) {
      const scope = { ...draftLocation };
      ensureLocationConnections(workspace.fleet, scope, loginIdentities());
      if (workspace.fleet.connections.length !== connections) saveSettingsSoon();
      void saveQueue
        .then(() => refreshConnections(scope, true))
        .catch((e) => {
          notice = String(e);
        });
    } else if (workspace.fleet.connections.length !== connections) saveSettingsSoon();
    activeId = null;
    // Each new chat is a scratch chat of its own; the one left behind stays if it has content.
    scratchId = crypto.randomUUID();
    scratches.push({
      id: scratchId,
      computerId: draftComputerId,
      location: draftLocation && $state.snapshot(draftLocation),
      settings: $state.snapshot(draftSettings),
      createdAt: Date.now(),
      title: '',
      filled: false,
      balanced: draftBalanced,
      ...(flow ? { workflow: flow } : {}),
    });
    switchDraft(currentDraftKey());
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    if (reveal && (location || computerId)) {
      query = '';
      const computerKey = `active/${location ? locationComputerId(location) : computerId}`;
      collapsedGroups[computerKey] = false;
      if (location) collapsedGroups[`${computerKey}/${locationKey(location)}`] = false;
      void tick().then(() => composerInput?.focus());
    }
    // Chat from Connections and `/new` name the agent and account to start with. An account
    // balancing chooses is no choice of the user's to remember.
    if (provider && !flow) {
      rememberSettings(workspace.preferences, draftSettings);
      rememberAgent(
        workspace.preferences,
        draftBalanced ? { provider: draftSettings.provider } : draftSettings,
      );
      saveLocalSoon();
    }
  }
  // On another computer a chat keeps its account when that account is connected there.
  function preferredConnection(provider: ProviderId, location: ChatLocation, accountId?: string) {
    const candidates = locationConnections(workspace.fleet, location, provider);
    const remembered = workspace.preferences.connectionByProvider?.[provider];
    const kept = accountId ? candidates.find((c) => c.accountId === accountId) : undefined;
    return (
      kept?.id ??
      candidates.find((c) => c.id === remembered)?.id ??
      candidates.find((c) => c.profile === 'existing' && connectionStatus(c.id)?.installed)?.id ??
      candidates[0]?.id
    );
  }
  function chooseComputer(id: string) {
    if (active || activeRunning || selectingLocation || id === selectedComputerId) return;
    const location = standaloneLocation(id);
    folderBrowserOpen = false;
    if (location) {
      void chooseLocation(location, true).catch((e) => (notice = String(e)));
      return;
    }
    locationGeneration++;
    draftComputerId = id;
    draftLocation = undefined;
    draftSettings = { ...draftSettings, connectionId: undefined };
    locationPending = true;
  }
  function standaloneLocation(computerId: string): ChatLocation | undefined {
    const environment = computerViews(workspace.fleet).find((c) => c.id === computerId)?.environments[0];
    return environment
      ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
      : undefined;
  }
  function settingsAtLocation(settings: ChatSettings, location: ChatLocation): ChatSettings {
    const installed = providerIds.filter((p) =>
      locationConnections(workspace.fleet, location, p).some(
        (c) => connectionStatus(c.id)?.installed,
      ),
    );
    const supported = providerIds.filter(
      (p) => locationConnections(workspace.fleet, location, p).length,
    );
    const provider = installed.includes(settings.provider)
      ? settings.provider
      : (installed[0] ??
        (supported.includes(settings.provider) ? settings.provider : supported[0]) ??
        settings.provider);
    return {
      ...(provider === settings.provider ? settings : settingsFor(workspace.preferences, provider)),
      instructions: settings.instructions,
      outputSchema: provider === 'gemini' ? undefined : settings.outputSchema,
      connectionId: preferredConnection(
        provider,
        location,
        workspace.fleet.connections.find((c) => c.id === settings.connectionId)?.accountId,
      ),
    };
  }
  async function chooseLocation(location: ChatLocation, verified = false) {
    if (active || activeRunning || selectingLocation) return;
    location = insideDistribution(workspace.fleet, location);
    if (selectedLocation && locationKey(location) === locationKey(selectedLocation)) return;
    const generation = ++locationGeneration;
    const conversationId = activeId;
    selectingLocation = true;
    try {
      if (!verified && location.path) {
        const listing = await listFolders(location.environmentId, location.path);
        location = { ...location, path: listing.path };
      }
      if (generation !== locationGeneration || conversationId !== activeId) return;
      const connections = workspace.fleet.connections.length;
      ensureLocationConnections(workspace.fleet, location, loginIdentities());
      const sameComputer = selectedComputerId === locationComputerId(location);
      // Another computer has accounts of its own to balance the chat between.
      if (!sameComputer) balanceAfresh();
      const settings = sameComputer
        ? { ...selectedSettings }
        : settingsAtLocation(selectedSettings, location);
      draftLocation = { ...location };
      locationPending = false;
      draftComputerId = locationComputerId(location);
      rememberLocation(workspace, location);
      // Automatic computer defaults must not replace the user's remembered account elsewhere.
      changeSettings(settings, sameComputer);
      const revision = settingsRevision;
      // The folder joins this device's recent ones; new connections belong to every device.
      if (workspace.fleet.connections.length !== connections) await persistSettings();
      else await persistLocal();
      // CLI availability belongs to the environment, not each folder. Reuse known results.
      void (async () => {
        await refreshConnections(location, true);
        if (paired) await syncNow();
        if (
          generation !== locationGeneration ||
          conversationId !== activeId ||
          revision !== settingsRevision ||
          !selectedLocation ||
          locationKey(selectedLocation) !== locationKey(location) ||
          JSON.stringify(selectedSettings) !== JSON.stringify(settings)
        )
          return;
        const resolved = sameComputer
          ? selectedSettings
          : settingsAtLocation(selectedSettings, location);
        if (JSON.stringify(resolved) !== JSON.stringify(selectedSettings))
          changeSettings(resolved, sameComputer);
      })().catch((e) => {
        notice = String(e);
      });
    } finally {
      selectingLocation = false;
    }
  }
  // Chats deleted on another device leave no CLI process parked here. Deletion closes a chat
  // wherever it happens; History moves arriving by sync may be another computer's startup.
  function releaseDeleted(ids: Iterable<string>) {
    for (const id of ids) {
      forgetChat(id);
      void releaseConversation(id).catch(() => {});
    }
  }
  // Moves a conversation to History. The open chat gives way to the Active conversation listed
  // below it in its folder, else above it there (a search match first), or to a new chat in that
  // folder when none is left, never to another folder's chat. From the sidebar, the view and the
  // phone drawer stay as they are.
  function archiveConversation(c: Conversation, fromSidebar = false) {
    if (!loaded || c.archived || conversationRunning(c)) return;
    const open = c.id === activeId;
    const unfiltered = () =>
      groupConversations(
        workspace.conversations
          .filter((other) => !other.archived)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        workspace.fleet,
        installation,
        [],
        [],
        Date.now(),
        pinsByChat,
      );
    const next = open
      ? (nextActiveConversation(conversationGroups, c.id) ??
        (query ? nextActiveConversation(unfiltered(), c.id) : undefined))
      : undefined;
    c.archived = true;
    c.updatedAt = new Date().toISOString();
    saveSoon(c.id);
    // Closing a chat is the user's call, and it closes the chat's parked CLI process too.
    void closeConversation(c.id, c.settings.connectionId).catch(() => {});
    if (!open) return;
    const shown = view,
      drawer = sidebarOpen;
    if (next) openConversation(next);
    else
      newChat(
        undefined,
        undefined,
        conversationLocation(c, workspace.fleet, installation),
        undefined,
        false,
      );
    if (fromSidebar) {
      view = shown;
      sidebarOpen = drawer;
    }
  }
  // The toolbar's Move to history, and its Snooze of an Active chat. The button leaves with the
  // chat, so focus continues in the next chat's composer, or at its actions menu on phones.
  function archiveOpenChat(snooze = false) {
    if (!active) return;
    if (snooze) snoozeConversation(active);
    else archiveConversation(active);
    void tick().then(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      if (mobile) document.querySelector<HTMLElement>('.mobile-actions-toggle')?.focus();
      else composerInput?.focus({ preventScroll: true });
    });
  }
  // A sidebar row's Move to history. A scratch chat has no history to move to, so the same
  // button discards it at once; the open one empties where it is. Keyboard focus moves on to the
  // row now in its place.
  function archiveRow(event: MouseEvent, c: Conversation | Scratch) {
    const control = event.currentTarget as HTMLElement;
    const rows = () => [
      ...(sidebarElement?.querySelectorAll<HTMLElement>(
        '#conversation-panel-active :is(.conversation-item, .scratch-item)',
      ) ?? []),
    ];
    const index = rows().indexOf(control.previousElementSibling as HTMLElement);
    const focused = document.activeElement === control,
      open = c.id === activeId;
    if ('messages' in c) {
      archiveConversation(c, true);
      if (!c.archived) return;
    } else discardScratch(c.id);
    if (!focused) return;
    void tick().then(() => {
      const listed = rows();
      const row =
        (open && listed.find((r) => r.getAttribute('aria-current') === 'page')) ||
        listed[index] ||
        listed[index - 1];
      (
        row || sidebarElement?.querySelector<HTMLElement>('.conversation-tabs [aria-selected="true"]')
      )?.focus();
    });
  }
  // Snoozes a chat until the app starts again: an Active one moves to History as Move to history
  // moves it, and from the next start of the app it waits at the top of the sidebar.
  function snoozeConversation(c: Conversation, fromSidebar = false) {
    if (!loaded || conversationRunning(c)) return;
    if (!c.archived) archiveConversation(c, fromSidebar);
    if (!c.archived) return;
    workspace.snoozes = withSnooze($state.snapshot(workspace.snoozes), c, heldChat);
    saveSettingsSoon();
  }
  function endSnooze(c: Conversation) {
    workspace.snoozes = withoutSnooze($state.snapshot(workspace.snoozes), c.id, heldChat);
    saveSettingsSoon();
  }
  // The toolbar's Snooze. An Active chat leaves for History; a History chat stays open with the
  // button pressed until its snooze ends.
  function toggleOpenSnooze() {
    if (!active) return;
    if (snoozeOf(active)) endSnooze(active);
    else if (active.archived) snoozeConversation(active);
    else archiveOpenChat(true);
  }
  // The context menu's Snooze and Cancel snooze. A chat that leaves Active gives keyboard focus
  // to the row now in its place.
  function snoozeFromMenu() {
    const c = menuConversation,
      trigger = conversationMenu?.trigger;
    if (!c || !trigger) return;
    const rows = () => [
      ...(sidebarElement?.querySelectorAll<HTMLElement>(
        '#conversation-panel-active :is(.conversation-item, .scratch-item)',
      ) ?? []),
    ];
    const index = rows().indexOf(trigger);
    closeConversationMenu();
    if (snoozeOf(c)) endSnooze(c);
    else snoozeConversation(c, true);
    void tick().then(() => {
      const listed = rows();
      (trigger.isConnected && trigger.getClientRects().length
        ? trigger
        : (listed[index] ??
          listed[index - 1] ??
          sidebarElement?.querySelector<HTMLElement>('.conversation-tabs [aria-selected="true"]'))
      )?.focus({ preventScroll: true });
    });
  }
  // The Snoozed list's Open shows the chat where it is, in History, where sending a message
  // brings it back to Active as usual.
  function openSnoozed(c: Conversation) {
    endSnooze(c);
    openConversation(c);
    if (!mobile) void tick().then(() => composerInput?.focus({ preventScroll: true }));
  }
  // Snooze again and Close take the chat out of the list, so keyboard focus moves on to the chat
  // now in its place, or once none is left to the first Active chat, else the Active tab.
  function leaveSnoozed(event: MouseEvent, c: Conversation, again: boolean) {
    const focused = document.activeElement === event.currentTarget;
    const index = listedSnoozes.findIndex((due) => due.id === c.id);
    if (again) snoozeConversation(c, true);
    else endSnooze(c);
    if (!focused) return;
    void tick().then(() => {
      const items = [...(sidebarElement?.querySelectorAll<HTMLElement>('.snoozed-chat') ?? [])];
      (
        (items[index] ?? items[index - 1])?.querySelector<HTMLElement>('button') ??
        sidebarElement?.querySelector<HTMLElement>(
          '#conversation-panel-active :is(.conversation-item, .scratch-item)',
        ) ??
        sidebarElement?.querySelector<HTMLElement>('.conversation-tabs [aria-selected="true"]')
      )?.focus();
    });
  }
  // Pins a chat to the top of the tab it is in, Active or History, or unpins it. Its place in
  // Active or History stays as it is.
  function togglePin(c: Conversation) {
    if (!loaded) return;
    const pins = $state.snapshot(workspace.pins);
    workspace.pins = pinsByChat.has(c.id) ? withoutPin(pins, c.id) : withPin(pins, c.id);
    saveSettingsSoon();
  }
  // The context menu's Pin and Unpin. The row moves between the pinned chats and its folder, and
  // keyboard focus follows it, into view when the keyboard chose it.
  function pinFromMenu(event: MouseEvent) {
    const c = menuConversation,
      trigger = conversationMenu?.trigger;
    if (!c || !trigger) return;
    const keyboard = event.detail === 0;
    closeConversationMenu();
    togglePin(c);
    void tick().then(() =>
      (
        sidebarElement?.querySelector<HTMLElement>(
          `.conversation-item[data-conversation="${c.id}"]`,
        ) ??
        (trigger.isConnected && trigger.getClientRects().length ? trigger : undefined) ??
        sidebarElement?.querySelector<HTMLElement>('.conversation-tabs [aria-selected="true"]')
      )?.focus({ preventScroll: !keyboard }),
    );
  }
  // Chats the Claude Code and Codex CLIs saved on this computer, imported into History.
  let importOpen = $state(false);
  function openImport() {
    if (!desktop()) {
      notice = 'Import chats in the desktop app on the computer that has them.';
      return;
    }
    importOpen = true;
  }
  async function saveImported(conversation: Conversation) {
    const session = workspaceSession;
    if (!loaded) throw new Error('The workspace is still loading.');
    workspace.conversations.push(conversation);
    try {
      await persistChat(conversation.id);
    } catch (error) {
      if (session === workspaceSession)
        workspace.conversations = workspace.conversations.filter((c) => c.id !== conversation.id);
      throw error;
    }
    if (session !== workspaceSession)
      throw new Error('The workspace changed while this chat was imported.');
  }
  function openImported(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    if (!conversation) return;
    importOpen = false;
    query = '';
    openConversation(conversation);
  }
  // Another chat opens as the reader left it in this window (`showPlace`), or at its end when
  // `latest`, as from an alert about it.
  function openConversation(c: Conversation, latest = false) {
    if (latest) recalled(recalls.get(c.id), 'chat').set('place', undefined);
    delete finishedChats[c.id];
    templatesOpen = false;
    sidebarOpen = false;
    locationGeneration++;
    folderBrowserOpen = false;
    // A workflow's chat opens from its graph and keeps the sidebar where it is.
    if (!hiddenChats.has(c.id)) revealConversation(c);
    locationPending = false;
    activeId = c.id;
    switchDraft(draftKey.chat(c.id));
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    void scrollToEnd();
  }
  // Returns to a scratch chat with the computer, folder and settings chosen for it.
  function openScratch(scratch: Scratch, focus = true) {
    if (!loaded || selectingLocation) return;
    templatesOpen = false;
    sidebarOpen = false;
    folderBrowserOpen = false;
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    if (!activeId && scratchId === scratch.id) return;
    locationGeneration++;
    if (!scratch.workflow) conversationScope = 'active';
    locationPending = false;
    const location = scratchLocation(workspace.fleet, scratch);
    const available = !!location && !!locationExecutionEnvironment(workspace.fleet, location);
    draftLocation = location && { ...location };
    draftComputerId = location ? locationComputerId(location) : scratch.computerId;
    const settings = $state.snapshot(scratch.settings) ?? settingsFor(workspace.preferences);
    if (!location) delete settings.connectionId;
    draftSettings =
      !available ||
      locationConnections(workspace.fleet, location).some((c) => c.id === settings.connectionId)
        ? settings
        : settingsAtLocation(settings, location);
    draftBalanced = !!scratch.balanced;
    activeId = null;
    scratchId = scratch.id;
    switchDraft(draftKey.scratch(scratch.id));
    if (focus) void tick().then(() => composerInput?.focus());
    if (!available) return;
    const connections = workspace.fleet.connections.length;
    ensureLocationConnections(workspace.fleet, location, loginIdentities());
    if (workspace.fleet.connections.length !== connections) saveSettingsSoon();
    void refreshConnections(location, true).catch((e) => {
      notice = String(e);
    });
  }
  async function forkChat(id: string, messageId?: string) {
    if (!loaded || forking || deleting || imagesLoading) return;
    const source = workspace.conversations.find((c) => c.id === id);
    if (!source) return;
    const session = workspaceSession;
    const selected = activeId;
    const selectedView = view;
    let fork: Conversation | undefined;
    forking = true;
    closeConversationMenu();
    try {
      notice = '';
      let copy: Conversation = $state.snapshot(source);
      // A light Viewer holds the source without its recorded work, which the fork copies.
      if (holdsLightChats()) {
        const [whole] = await readWholeChats([id]);
        if (session !== workspaceSession) return;
        if (whole) {
          const found = messagesById([whole]);
          copy = restoreChat(copy, (m) => found.get(m));
        }
      }
      fork = forkConversation(copy, messageId);
      workspace.conversations.unshift(fork);
      // Its work goes out whole once, then it lets that work go like any other chat.
      holdWork(fork.id);
      await persistChat(fork.id);
      if (session !== workspaceSession) return;
      query = '';
      revealConversation(fork);
      // Navigation or a blank draft may have changed while saving. Do not
      // replace that selection or move an unrelated draft into the new chat.
      if (
        activeId !== selected || view !== selectedView || imagesLoading ||
        (!activeId && (prompt || attachedImages.length))
      ) {
        notice = `“${fork.title}” created in Active.`;
        return;
      }
      // The source chat keeps its draft for when it is reopened.
      openConversation(fork);
      await tick();
      composerInput?.focus();
    } catch (error) {
      if (session !== workspaceSession) return;
      if (fork) workspace.conversations = workspace.conversations.filter((c) => c.id !== fork!.id);
      notice = `Could not fork conversation: ${String(error)}`;
    } finally {
      if (session === workspaceSession) forking = false;
    }
  }
  /** When the chat goes on after the usage limit that stopped its last reply, for that card. */
  function continuationOf(conversation: Conversation, reply: Message) {
    const at = waitingPlan(conversation);
    return at
      ? {
          at,
          ...(readOnlyChat ? {} : { cancel: () => cancelContinue(conversation.id, reply.id) }),
        }
      : undefined;
  }
  function revealConversation(c: Conversation) {
    conversationScope = c.archived ? 'history' : 'active';
    const location = conversationLocation(c, workspace.fleet, installation);
    // Active lists chats by computer, History by the app session they were last used in.
    const sectionKey = `${conversationScope}/${
      c.archived
        ? historySectionId(c, sessionTimeline(workspace.appSessions))
        : location
          ? locationComputerId(location)
          : 'unassigned'
    }`;
    collapsedGroups[sectionKey] = false;
    collapsedGroups[`${sectionKey}/${location ? locationKey(location) : 'unassigned'}`] = false;
  }
  async function conversationTabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tablist = (event.currentTarget as HTMLElement).parentElement;
    const scopes = ['active', 'history', 'screens'] as const;
    const index = Math.max(0, scopes.indexOf(conversationScope as (typeof scopes)[number]));
    conversationScope =
      event.key === 'Home'
        ? 'active'
        : event.key === 'End'
          ? 'screens'
          : scopes[(index + (event.key === 'ArrowLeft' ? scopes.length - 1 : 1)) % scopes.length];
    await tick();
    tablist?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }
  /** `live` marks an update of a running reply, whose activity can fold into less space. */
  async function scrollToEnd(live = false) {
    await tick();
    if (nearBottom && chatScroll) {
      const height = chatColumn?.getBoundingClientRect().height ?? 0;
      if (height >= followedHeight)
        // New content fills any held space before the chat follows it.
        virtualSpace?.trim();
      // Finished calls folded into their groups: space keeps the chat in place until new
      // content fills it, instead of pulling everything down.
      else if (live) virtualSpace?.pad(followedHeight - height);
      // The conversation now ends elsewhere, as when a reply's activity becomes Work history.
      else virtualSpace?.clear();
      stickToEnd(chatScroll);
      followedHeight = height;
    }
  }
  // Changes to the open chat that arrive through the relay, such as a reply another computer
  // runs, are followed like a reply running here.
  function followReceived() {
    const open = workspace.conversations.find((c) => c.id === activeId);
    if (open) void scrollToEnd(conversationRunning(open));
  }
  function conversationRunning(conversation: Conversation) {
    return (
      !!runs[conversation.id] || conversation.messages.some((m) => m.status === 'running')
    );
  }
  function closeConversationMenu(restoreFocus = false) {
    const trigger = conversationMenu?.trigger;
    conversationMenu = null;
    if (restoreFocus) void tick().then(() => trigger?.focus({ preventScroll: true }));
  }
  // The actions of a sidebar row: a conversation, or a scratch chat when `scratch` is set.
  function openConversationMenu(event: MouseEvent | KeyboardEvent, id: string, scratch = false) {
    event.preventDefault();
    cancelTouchMenu();
    if ('pointerType' in event && event.pointerType === 'touch') longPressedConversation = id;
    const trigger = event.currentTarget as HTMLButtonElement;
    const bounds = trigger.getBoundingClientRect();
    const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0);
    conversationMenu = {
      id,
      ...(scratch ? { scratch } : {}),
      trigger,
      x: pointer ? event.clientX : bounds.left + 12,
      y: pointer ? event.clientY : bounds.bottom,
    };
  }
  function cancelTouchMenu() {
    clearTimeout(touchMenuTimer);
    touchMenuOrigin = undefined;
  }
  function moveTouchMenu(event: PointerEvent) {
    if (
      touchMenuOrigin &&
      Math.hypot(event.clientX - touchMenuOrigin.x, event.clientY - touchMenuOrigin.y) > 8
    )
      cancelTouchMenu();
  }
  function startTouchMenu(event: PointerEvent, id: string, scratch = false) {
    cancelTouchMenu();
    longPressedConversation = undefined;
    if (event.pointerType !== 'touch') return;
    const trigger = event.currentTarget as HTMLButtonElement;
    const x = event.clientX,
      y = event.clientY;
    touchMenuOrigin = { x, y };
    touchMenuTimer = setTimeout(() => {
      touchMenuOrigin = undefined;
      if (!trigger.isConnected || !trigger.getClientRects().length) return;
      longPressedConversation = id;
      conversationMenu = { id, ...(scratch ? { scratch } : {}), trigger, x, y };
    }, 500);
  }
  function requestConversationDeletion() {
    if (!conversationMenu || !menuConversation || deleting) return;
    deletionError = '';
    deletion = {
      type: 'conversation',
      id: menuConversation.id,
      name: menuConversation.title,
      trigger: conversationMenu.trigger,
    };
    closeConversationMenu();
  }
  function requestScratchDiscard() {
    if (!conversationMenu || !menuScratch || deleting) return;
    deletionError = '';
    deletion = {
      type: 'draft',
      id: menuScratch.id,
      name: menuScratch.title,
      trigger: conversationMenu.trigger,
    };
    closeConversationMenu();
  }
  // Discarding the open scratch chat empties it, which also takes it out of the sidebar.
  function discardScratch(id: string) {
    if (activeId || scratchId !== id) {
      dropScratch(draftKey.scratch(id));
      return;
    }
    clearImages();
    applyComposer(undefined);
    keepDraft(composerContent());
  }
  function focusDeletionDialog(node: HTMLElement) {
    const trigger = deletion?.trigger;
    node.querySelector<HTMLButtonElement>('button')?.focus();
    return {
      destroy() {
        void tick().then(() => {
          if (trigger?.isConnected && trigger.getClientRects().length)
            trigger.focus({ preventScroll: true });
          else if (mobile && sidebarOpen)
            sidebarElement
              ?.querySelector<HTMLElement>('.conversation-tabs [aria-selected="true"]')
              ?.focus();
          else composerInput?.focus();
        });
      },
    };
  }
  async function remove() {
    if (deletion?.type === 'draft' && !deleting) {
      discardScratch(deletion.id);
      deletion = null;
      return;
    }
    if (!deletion || !deletingConversation || deleting) return;
    const session = workspaceSession;
    const target = deletingConversation;
    const ownedRun = runs[target.id];
    const reply = target.messages.find((m) => m.status === 'running');
    const runId = ownedRun ?? reply?.runId;
    deleting = true;
    deletionError = '';
    try {
      if (ownedRun) stopping[target.id] = true;
      if (runId)
        await cancelRun(runId, reply?.settings?.connectionId ?? target.settings.connectionId, true);
      if (session !== workspaceSession) return;
      delete queued[target.id];
      await releaseConversation(target.id, target.settings.connectionId).catch(() => {});
      if (session !== workspaceSession) return;
      await cancelTitle(target.id).catch(() => {});
      if (session !== workspaceSession) return;
      workspace.conversations = workspace.conversations.filter((c) => c.id !== target.id);
      // Its snooze and its pin go with it.
      if (snoozesByChat.has(target.id)) {
        workspace.snoozes = withoutSnooze($state.snapshot(workspace.snoozes), target.id, heldChat);
        marks.meta();
      }
      if (pinsByChat.has(target.id)) {
        workspace.pins = withoutPin($state.snapshot(workspace.pins), target.id);
        marks.meta();
      }
      // The saved order leaves it out, and a sync sees it gone from the baseline.
      await persistChat(target.id);
      if (session !== workspaceSession) return;
      // Its unsent draft and its panels are deleted with the conversation.
      forgetDraft(draftKey.chat(target.id));
      rewoundDrafts.delete(target.id);
      forgetChat(target.id);
      if (activeId === target.id) {
        composerDraftKey = '';
        newChat();
      }
      deletion = null;
    } catch (e) {
      if (session !== workspaceSession) return;
      if (!workspace.conversations.some((c) => c.id === target.id))
        workspace.conversations.unshift(target);
      deletionError = `Could not delete this conversation: ${String(e)}`;
      if (ownedRun && runs[target.id] === ownedRun) delete stopping[target.id];
    } finally {
      if (session === workspaceSession) deleting = false;
    }
  }
  function clearImages() {
    imageDragDepth = 0;
    attachmentGeneration++;
    attachedImages = [];
    attachmentError = '';
    imagesLoading = false;
  }
  function currentDraftKey() {
    if (activeId) return draftKey.chat(activeId);
    return scratchId ? draftKey.scratch(scratchId) : '';
  }
  function composerContent(): DraftContent {
    return {
      text: prompt,
      images: $state.snapshot(attachedImages),
      mentions: $state.snapshot(draftMentions),
      staleMentions: $state.snapshot(staleMentionTokens),
      mentionScope: mentionSelection,
    };
  }
  function applyComposer(draft?: DraftContent) {
    prompt = draft?.text ?? '';
    attachedImages = [...(draft?.images ?? [])];
    draftMentions = draft?.mentions.map((m) => ({ ...m })) ?? [];
    staleMentionTokens = [...(draft?.staleMentions ?? [])];
    // Restored mentions stay selected only while their chat, account, and folder still match.
    if (draft?.mentions.length) mentionSelection = draft.mentionScope;
  }
  function keepDraft(content: DraftContent) {
    const key = composerDraftKey;
    if (!key) return;
    const previous = drafts.get(key);
    if (!hasDraft(content)) {
      if (previous) forgetDraft(key);
    } else if (!previous || !sameDraft(previous, content)) {
      drafts.set(key, { ...content, updatedAt: Date.now() });
      draftChanged(key);
    }
    // A scratch chat is listed in the sidebar by its first line while it has content.
    const scratch = scratchFor(key);
    if (!scratch) return;
    const title = scratchTitle(content),
      filled = hasDraft(content);
    if (scratch.title !== title) scratch.title = title;
    if (scratch.filled !== filled) scratch.filled = filled;
  }
  function forgetDraft(key: string) {
    if (drafts.delete(key)) draftChanged(key);
  }
  function draftChanged(key: string) {
    changedDrafts.set(key, Date.now());
    // Save a few times a second even while typing continues, so closing loses little.
    if (draftsReady) draftTimer ??= setTimeout(() => void saveDraftsNow(), 300);
  }
  function scratchFor(key: string) {
    const id = scratchIdOf(key);
    return id === undefined ? undefined : scratches.find((s) => s.id === id);
  }
  // A saved scratch chat is saved again when its computer, folder or settings change.
  function placeScratch(id: string, place: Omit<SavedScratch, 'createdAt'>) {
    const scratch = scratches.find((s) => s.id === id);
    if (
      !scratch ||
      (scratch.computerId === place.computerId &&
        JSON.stringify(scratch.location) === JSON.stringify(place.location) &&
        JSON.stringify(scratch.settings) === JSON.stringify(place.settings))
    )
      return;
    scratch.computerId = place.computerId;
    scratch.location = place.location;
    scratch.settings = place.settings;
    const key = draftKey.scratch(id);
    const draft = drafts.get(key);
    if (!draft) return;
    draft.updatedAt = Date.now();
    draftChanged(key);
  }
  // What a scratch chat's saved draft records besides its text.
  function scratchPlace(key: string): SavedScratch | undefined {
    const scratch = scratchFor(key);
    if (!scratch) return;
    const { computerId, location, settings, createdAt, workflow } = $state.snapshot(scratch);
    return {
      computerId,
      ...(location ? { location } : {}),
      ...(settings ? { settings } : {}),
      createdAt,
      ...(workflow ? { workflow } : {}),
    };
  }
  // A new session continues the scratch chat edited last, until another chat opens or text is
  // typed. The view stays, so a workspace loaded from Connections does not leave it.
  function continueScratch() {
    let latest: Scratch | undefined;
    let at = -1;
    for (const scratch of scratches) {
      // Workflow chats wait under Workflows.
      if (scratch.workflow) continue;
      const updatedAt = drafts.get(draftKey.scratch(scratch.id))?.updatedAt ?? -1;
      if (updatedAt > at) {
        latest = scratch;
        at = updatedAt;
      }
    }
    if (!latest || activeId || hasDraft(composerContent())) return false;
    const shown = view;
    openScratch(latest, false);
    view = shown;
    return true;
  }
  // Removes a scratch chat that was sent or discarded or, when `left`, one left without content.
  function dropScratch(key: string, left = false) {
    const id = scratchIdOf(key);
    if (id === undefined || (left && hasDraft(drafts.get(key)))) return;
    forgetDraft(key);
    balanceSettled.delete(id);
    const index = scratches.findIndex((s) => s.id === id);
    if (index >= 0) scratches.splice(index, 1);
  }
  // Opening another chat or scratch chat keeps the current draft for its return.
  function switchDraft(key: string) {
    keepDraft(composerContent());
    const left = composerDraftKey;
    composerDraftKey = key;
    if (left !== key) dropScratch(left, true);
    clearImages();
    applyComposer(drafts.get(key));
  }
  // `/new` moves the rest of the command into the new scratch chat.
  function carryDraft(from: string, carried: DraftContent) {
    forgetDraft(from);
    dropScratch(from);
    applyComposer(carried);
    keepDraft(carried);
  }
  function resetDrafts() {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    drafts.clear();
    changedDrafts.clear();
    rewoundDrafts.clear();
    composerDraftKey = '';
    draftsReady = false;
    draftSaveFailed = false;
    scratches = [];
    scratchId = '';
    balanceSettled.clear();
  }
  async function loadSavedDrafts() {
    const session = workspaceSession;
    const scope = workspaceStorageScope();
    if (!scope) return;
    let saved = new Map<string, SavedDraft>();
    try {
      saved = readSavedDrafts(await loadDrafts(scope));
    } catch (error) {
      notice = `Saved drafts could not be read on this device. ${String(error).replace(/^Error: /, '')}`;
    }
    if (session !== workspaceSession || scope !== workspaceStorageScope()) return;
    for (const [key, draft] of saved) {
      if (key.startsWith('chat:')) {
        if (!drafts.has(key)) drafts.set(key, restoredDraft(draft));
        continue;
      }
      const scratch = savedScratch(draft);
      if (!scratch || scratches.some((s) => s.id === scratch.id)) continue;
      const next = draftKey.scratch(scratch.id);
      // An earlier release's new-chat draft for a folder or computer becomes a scratch chat.
      if (next !== key) {
        draftChanged(key);
        draftChanged(next);
      }
      drafts.set(next, restoredDraft(draft));
      scratches.push({
        ...scratch,
        title: scratchTitle({ text: draft.text, images: [] }),
        filled: true,
      });
    }
    draftsReady = true;
    if (loaded) continueScratch();
    if (changedDrafts.size) void saveDraftsNow();
  }
  function saveDraftsNow(): Promise<void> {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    if (!draftsReady || !changedDrafts.size) return draftSaves;
    const changes = new Map<string, DraftChange>();
    for (const [key, at] of changedDrafts) {
      const draft = savedDraft(key, drafts.get(key), scratchPlace(key));
      changes.set(key, draft ? { at: draft.updatedAt, draft } : { at });
    }
    changedDrafts.clear();
    const session = workspaceSession;
    const scope = workspaceStorageScope();
    draftSaves = draftSaves
      .catch(() => {})
      .then(async () => {
        if (session !== workspaceSession) return;
        let saved: Map<string, SavedDraft>;
        try {
          saved = readSavedDrafts(await loadDrafts(scope));
        } catch {
          // Without a readable saved copy, this window's drafts are the best copy to keep.
          saved = new Map(
            [...drafts].flatMap(([key, draft]) => {
              const value = savedDraft(key, draft, scratchPlace(key));
              return value ? [[key, value] as const] : [];
            }),
          );
        }
        await saveDrafts(mergeSavedDrafts(saved, changes), scope);
      })
      .then(
        () => {
          draftSaveFailed = false;
        },
        (error) => {
          if (session !== workspaceSession) return;
          for (const [key, change] of changes)
            if (!changedDrafts.has(key)) changedDrafts.set(key, change.at);
          if (!draftSaveFailed)
            notice = `Unsent drafts could not be saved on this device. ${String(error).replace(/^Error: /, '')}`;
          draftSaveFailed = true;
        },
      );
    return draftSaves;
  }
  // Images attached while earlier ones are still being read wait for them, in order.
  let attaching: Promise<void> = Promise.resolve();
  function attachImages(files: File[]) {
    if (!files.length) return;
    attachmentError = '';
    if (!imagesSupported) {
      attachmentError = 'Images need Codex or Claude.';
      return;
    }
    const generation = attachmentGeneration;
    attaching = attaching.then(() => readAttachments(files, generation));
    return attaching;
  }
  async function readAttachments(files: File[], generation: number) {
    if (generation !== attachmentGeneration) return;
    imagesLoading = true;
    try {
      const images = await Promise.all(files.map(readImage));
      if (generation !== attachmentGeneration) return;
      attachedImages = [...attachedImages, ...images];
    } catch (error) {
      if (generation === attachmentGeneration) attachmentError = (error as Error).message;
    } finally {
      if (generation === attachmentGeneration) {
        imagesLoading = false;
        followNotification();
      }
    }
  }
  function hasDraggedFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes('Files') || !!event.dataTransfer?.files.length;
  }
  function dragImagesOver(event: DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    imageDragDepth = Math.max(1, imageDragDepth);
    if (event.dataTransfer) event.dataTransfer.dropEffect = imagesSupported ? 'copy' : 'none';
  }
  function dropImages(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    imageDragDepth = 0;
    composerInput?.focus();
    void attachImages(files);
  }
  function returnQueuedToDraft(id: string, only?: string) {
    const items = queued[id] ?? [];
    const returning = only ? items.filter((m) => m.id === only) : items;
    if (!returning.length) return;
    const remaining = only ? items.filter((m) => m.id !== only) : [];
    if (remaining.length) queued[id] = remaining;
    else delete queued[id];
    if (activeId !== id) return;
    const restored = restoreToDraft(returning, prompt, attachedImages);
    prompt = restored.draft;
    for (const item of returning) restoreDraftMentions(item);
    attachedImages = restored.images;
    attachmentError = '';
    void tick().then(() => composerInput?.focus());
  }
  function restoreDraftMentions(item: QueuedMessage) {
    if (item.mentionConnectionId !== selectedSettings.connectionId)
      staleMentionTokens = [...staleMentionTokens, ...(item.mentions ?? []).map((m) => m.token)];
    else draftMentions = [...draftMentions, ...(item.mentions ?? []).map((m) => ({ ...m }))];
  }
  // Send the next queued message once the running reply completes. A stopped or failed
  // reply returns queued messages to the composer instead of sending into a broken state.
  $effect(() => {
    const id = activeId;
    const items = id ? queued[id] : undefined;
    const busy = activeRunning || activeStopping || activeSteering || (!!id && !!takingOver[id]);
    if (!id || !items?.length || busy) return;
    const last = active?.messages.at(-1);
    const ready = last?.role === 'assistant' && last.status === 'complete';
    const failed =
      !last || last.role !== 'assistant' || ['cancelled', 'error'].includes(last.status);
    const sendable = canSend;
    untrack(() => {
      if (ready && sendable) {
        const [next, ...rest] = items;
        if (rest.length) queued[id] = rest;
        else delete queued[id];
        void send(false, next);
      } else if (failed) returnQueuedToDraft(id);
    });
  });
  // Conversations that are not open send their next queued message once their reply completes.
  // Anything else keeps the queue until the conversation is opened: a stopped or failed reply
  // returns it to the draft there, and the composer explains changed mentions.
  $effect(() => {
    const open = activeId;
    const ready = Object.keys(queued).filter((id) => {
      if (id === open || takingOver[id]) return false;
      const conversation = workspace.conversations.find((c) => c.id === id);
      const next = queued[id]?.[0];
      const last = conversation?.messages.at(-1);
      return (
        !!conversation &&
        !!next &&
        last?.role === 'assistant' &&
        last.status === 'complete' &&
        (!next.mentions?.length ||
          next.mentionConnectionId === conversation.settings.connectionId) &&
        canSendQueued(conversation)
      );
    });
    if (ready.length) untrack(() => ready.forEach(sendQueued));
  });
  // A Claude reply that only waits for background work takes the next queued message at once,
  // open or not: it hands its process to the new reply and ends. A refused message waits.
  $effect(() => {
    for (const id of Object.keys(queued)) {
      const conversation = workspace.conversations.find((c) => c.id === id);
      const next = queued[id]?.[0];
      if (!conversation || !next || takingOver[id] || stopping[id]) continue;
      const target = takeOverTarget(conversation, takeOverRefused, heardWaits);
      if (
        target &&
        !steeringPending[target.reply.runId!] &&
        (!next.mentions?.length ||
          next.mentionConnectionId === conversation.settings.connectionId) &&
        readyToSend(conversation)
      )
        untrack(() => void takeOverQueued(conversation, target.reply, next));
    }
  });
  // The message and reply placeholder of a take-over this computer runs for another device,
  // added once as the host confirms it, exactly as that device adds them.
  function joinTakeOver(conversation: Conversation, request: RunRequest) {
    const added = request.takeOver?.messages.map((m) => messageSchema.safeParse(m));
    if (added?.length !== 2 || !added[0].success || !added[1].success) return;
    const [user, reply] = [added[0].data, added[1].data];
    if (
      user.role !== 'user' ||
      reply.role !== 'assistant' ||
      reply.id !== request.assistantId ||
      reply.runId !== request.runId ||
      conversation.messages.some((m) => m.id === user.id || m.id === reply.id)
    )
      return;
    conversation.messages.push(user, reply);
    conversation.updatedAt = reply.createdAt;
  }
  async function takeOverQueued(conversation: Conversation, reply: Message, next: QueuedMessage) {
    const id = conversation.id;
    takingOver[id] = next.id;
    const session = workspaceSession;
    let images: StoredImage[] = [];
    try {
      images = await storeChatImages(next.images);
    } catch {
      // It waits for the reply instead, like any queued message.
      if (session === workspaceSession) {
        const target = takeOverTarget(conversation, takeOverRefused, heardWaits);
        if (target?.reply === reply) takeOverRefused[reply.runId!] = target.wait;
        delete takingOver[id];
      }
      return;
    }
    if (session !== workspaceSession) return;
    const target = takeOverTarget(conversation, takeOverRefused, heardWaits);
    if (queued[id]?.[0]?.id !== next.id || target?.reply !== reply) {
      if (takingOver[id] === next.id) delete takingOver[id];
      return;
    }
    const { wait } = target;
    const now = new Date().toISOString();
    const { provider, model } = conversation.settings;
    const catalog = modelCache.get(modelScopeKey(conversation.settings))?.catalog ?? fallbackModels;
    void startReply(conversation, {
      now,
      modelName: selectedModelName(model, modelChoices(catalog, provider, model)),
      remember: activeId === id,
      takeOver: { reply, wait, user: userMessage({ ...next, images }, now), itemId: next.id },
    });
  }
  // The composer's checks for a saved conversation, without the composer's own state.
  function canSendQueued(conversation: Conversation) {
    return (
      !conversationRunning(conversation) &&
      !stopping[conversation.id] &&
      readyToSend(conversation)
    );
  }
  // Whether the conversation's computer and account can take its next message.
  function readyToSend(conversation: Conversation) {
    const { settings, location } = conversation;
    const target = replyConnection(settings);
    return (
      loaded &&
      (!location ||
        !!settings.connectionId ||
        executionHost(workspace.fleet, location.environmentId) === installation?.id) &&
      (!location?.path ||
        locationConnections(workspace.fleet, location).some(
          (c) => c.id === settings.connectionId,
        )) &&
      (desktop() || paired) &&
      (desktop() || online) &&
      (!target.remote || (paired && !syncError)) &&
      !!target.status?.installed &&
      target.status.auth === 'ready'
    );
  }
  async function sendQueued(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    const [next, ...rest] = queued[id] ?? [];
    if (!conversation || !next) return;
    if (rest.length) queued[id] = rest;
    else delete queued[id];
    const session = workspaceSession;
    let images: StoredImage[] = [];
    try {
      images = await storeChatImages(next.images);
    } catch {
      // The queue waits for the chat to be opened, as after a stopped reply.
      if (session === workspaceSession) queued[id] = [next, ...(queued[id] ?? [])];
      return;
    }
    if (session !== workspaceSession) return;
    const now = new Date().toISOString();
    if (conversation.archived) conversation.archived = false;
    delete conversation.rewind;
    rewoundDrafts.delete(conversation.id);
    addUserMessage(conversation, { ...next, images }, now);
    const { provider, model } = conversation.settings;
    const catalog = modelCache.get(modelScopeKey(conversation.settings))?.catalog ?? fallbackModels;
    void startReply(conversation, {
      now,
      modelName: selectedModelName(model, modelChoices(catalog, provider, model)),
    });
  }
  async function steer() {
    if (!canSteer || !observedReply?.runId) return;
    const reply = observedReply,
      runId = reply.runId!,
      draft = prompt,
      selected = activeId,
      session = workspaceSession;
    const text = draft.trim();
    if (steeringAttempt?.runId !== runId || steeringAttempt.text !== text)
      steeringAttempt = { runId, text, id: crypto.randomUUID() };
    const input = { id: steeringAttempt.id, text };
    steeringPending[runId] = true;
    attachmentError = '';
    try {
      await steerRun(runId, input, reply.settings?.connectionId);
      if (session !== workspaceSession) return;
      if (activeId === selected && prompt === draft) prompt = '';
      steeringAttempt = undefined;
      if (selected) saveSoon(selected);
    } catch (error) {
      if (session === workspaceSession && activeId === selected) attachmentError = String(error);
    } finally {
      delete steeringPending[runId];
    }
  }
  async function send(retry = false, queuedMessage?: QueuedMessage, compactRequest?: string) {
    if (activeSteering || readOnlyChat) return;
    if (preparingCommand) return;
    if (queuedMessage?.mentions?.length && queuedMessage.mentionConnectionId !== selectedSettings.connectionId) {
      const restored = restoreToDraft([queuedMessage], prompt, attachedImages);
      prompt = restored.draft;
      attachedImages = restored.images;
      restoreDraftMentions(queuedMessage);
      attachmentError = 'The account changed. Choose the queued mentions again before sending.';
      return;
    }
    const session = workspaceSession;
    let command: Awaited<ReturnType<ComposerCommands['submission']>>;
    if (!retry && !queuedMessage && !compactRequest) {
      const draft = prompt,
        selected = activeId;
      preparingCommand = true;
      try {
        command = await composerCommands?.submission();
      } finally {
        if (session === workspaceSession) preparingCommand = false;
      }
      if (session !== workspaceSession) return;
      if (!command || command.handled || prompt !== draft || activeId !== selected) return;
    }
    const compact = !!compactRequest || !!command?.compact || (retry && !!active?.messages.at(-1)?.compact);
    if (compact && (!canCompact || (!compactRequest && attachedImages.length))) {
      notice = 'Compaction needs an idle chat without attachments, and a reply since any account switch or rewind.';
      return;
    }
    const text = compactRequest ?? (queuedMessage ? queuedMessage.text : prompt.trim());
    const images = compactRequest ? [] : queuedMessage ? queuedMessage.images : attachedImages;
    const skills = queuedMessage ? queuedMessage.skills : command?.skills;
    const mentions = queuedMessage ? queuedMessage.mentions : command?.mentions;
    if (!retry && !queuedMessage && activeId && activeRunning) {
      // The reply is still running: hold this message and send it once the reply completes.
      if (!canQueue) return;
      const next = enqueueMessage(activeQueue, {
        text,
        images: structuredClone($state.snapshot(attachedImages)),
        skills,
        mentions,
        mentionConnectionId: selectedSettings.connectionId,
      });
      if (next.error) {
        attachmentError = next.error;
        return;
      }
      queued[activeId] = next.queue;
      prompt = '';
      clearImages();
      void tick().then(() => composerInput?.focus());
      return;
    }
    if (!canSend || (!retry && !text && !images.length)) return;
    // The images go to the image store before the message names them: this computer's on the
    // desktop, the relay's in a browser. A failure keeps them where they were.
    let stored: StoredImage[] = [];
    if (!retry && images.length) {
      const selected = activeId;
      imagesSending = true;
      try {
        stored = await storeChatImages(images);
      } catch (error) {
        if (session === workspaceSession)
          attachmentError = `The images could not be kept: ${(error as Error)?.message ?? error}`;
        return;
      } finally {
        if (session === workspaceSession) imagesSending = false;
      }
      if (session !== workspaceSession || activeId !== selected) return;
      // A draft edited while its images were kept goes out when it is sent again, which is
      // quick now that they are.
      if (!queuedMessage && (prompt.trim() !== text || attachedImages !== images)) return;
    }
    // A chat at its end, including one that fits in its view, glides to the new message and
    // follows the reply; a reading position above the end stays where it is.
    const scroll = chatScroll;
    if (scroll && !nearBottom)
      nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2;
    const glides = !!scroll && nearBottom && !reducedMotion();
    const now = new Date().toISOString();
    const isNewConversation = !active;
    const sentDraft = composerDraftKey;
    // A workflow chat's first message makes its workflow or mission first; a failure keeps it.
    let bound: Awaited<ReturnType<typeof bindWorkflowChat>> | undefined;
    const flow = !active && !retry && !queuedMessage ? currentScratch?.workflow : undefined;
    if (flow) {
      try {
        bound = await bindWorkflowChat(flow, text);
      } catch (error) {
        if (session === workspaceSession) notice = String(error).replace(/^Error: /, '');
        return;
      }
      if (session !== workspaceSession || activeId) return;
      // A mission another computer runs starts its own chat there.
      if (!bound.conversationId) {
        prompt = '';
        clearImages();
        forgetDraft(sentDraft);
        dropScratch(sentDraft);
        openWorkflow(bound.runId!);
        return;
      }
    }
    if (!active) {
      const c: Conversation = {
        id: bound?.conversationId ?? crypto.randomUUID(),
        settings: {
          ...structuredClone($state.snapshot(selectedSettings)),
          ...(bound ? { instructions: bound.instructions } : {}),
        },
        location: selectedLocation ? { ...selectedLocation } : undefined,
        title: text.slice(0, 80) || 'Image conversation',
        titleStatus: 'pending',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      if (bound) workflows.own(c.id);
      workspace.conversations.unshift(c);
      activeId = c.id;
    }
    const conversation = workspace.conversations.find((c) => c.id === activeId)!;
    if (glides) {
      // Armed before the message renders, so nothing jumps to it first.
      stopGlide();
      glide = { conversation: conversation.id, frame: 0, at: 0, start: 0, top: 0 };
      void tick().then(() => startGlide(conversation.id));
    }
    if (conversation.archived) {
      conversation.archived = false;
      // A workflow's chat stays under Workflows.
      if (!hiddenChats.has(conversation.id)) revealConversation(conversation);
    }
    // Any submission, including a retry, ends the chance to undo a rewind.
    delete conversation.rewind;
    rewoundDrafts.delete(conversation.id);
    if (retry && conversation.messages.at(-1)?.role === 'assistant') {
      if (conversation.messages.at(-1)?.steering?.length) {
        // Preserve the steered attempt and its accepted inputs for portable history.
        conversation.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          status: 'complete',
          createdAt: now,
          blocks: [
            {
              type: 'markdown',
              text: 'Continue the previous request, including my steering. Check existing results before repeating any work.',
            },
          ],
        });
      } else conversation.messages.pop();
    }
    if (!retry) {
      addUserMessage(conversation, { text, images: stored, skills, mentions }, now);
      if (!queuedMessage && !compactRequest) {
        prompt = '';
        clearImages();
        forgetDraft(sentDraft);
      }
    }
    // The scratch chat is now this conversation, whose composer continues as its draft.
    if (isNewConversation) {
      composerDraftKey = draftKey.chat(conversation.id);
      dropScratch(sentDraft);
    }
    await startReply(conversation, {
      now,
      modelName: selectedModelName(conversation.settings.model, availableModels),
      compact,
      created: isNewConversation,
      remember: !bound,
      ...(bound?.mission ? { mission: bound.mission } : {}),
    });
  }
  /**
   * What a workflow chat's first message makes (docs/WORKFLOWS.md): a new workflow whose
   * assistant the chat becomes, the assistant of an existing one, or a mission the chat
   * orchestrates. A mission another computer runs starts there, without this chat.
   */
  async function bindWorkflowChat(flow: ScratchWorkflow, text: string) {
    const conversationId = crypto.randomUUID();
    const actor = { kind: 'user' as const, ...(installation ? { environmentId: installation.id } : {}) };
    if (flow.mode === 'mission') {
      rememberWorkflowMode('mission');
      const settings = selectedSettings;
      const location = selectedLocation;
      const driver: RunDriverChoice = missionDriver ?? {
        preferred: workflowPickers.defaultDriver,
        elsewhere: true,
      };
      const here = driver.preferred === installation?.id;
      const runId = await workflows.startMission({
        title: '',
        text,
        ...(location?.path ? { location: { ...location } } : {}),
        orchestrator: {
          provider: settings.provider,
          connectionId: settings.connectionId ?? '',
          model: settings.model,
          reasoning: settings.reasoning,
        },
        driver,
        actor,
        ...(here && installation
          ? {
              chat: {
                conversationId,
                environmentId: installation.id,
                ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
              },
            }
          : {}),
      });
      workflowChatOpen[runId] = true;
      return {
        conversationId: here ? conversationId : undefined,
        runId,
        instructions: ORCHESTRATOR_INSTRUCTIONS,
        mission: { runId, role: 'orchestrator' as const },
      };
    }
    rememberWorkflowMode('workflow');
    let workflowId = flow.id;
    if (workflowId)
      await workflows.changeDefinition(workflowId, (d) => (d.assistant = { conversationId }));
    else {
      workflowId = crypto.randomUUID();
      const line = text.trim().split('\n')[0] ?? '';
      const name = line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New workflow';
      const result = await workflows.saveDefinition(workflowId, null, {
        ...newDefinition(name, actor),
        assistant: { conversationId },
      });
      if (!result.ok) throw new Error('The workflow could not be saved.');
    }
    workflowChatOpen[workflowId] = true;
    return {
      conversationId,
      runId: undefined,
      instructions: assistantInstructions(workflowId),
      mission: undefined,
    };
  }
  function addUserMessage(
    conversation: Conversation,
    input: Pick<QueuedMessage, 'text' | 'skills' | 'mentions'> & {
      images: StoredImage[];
      sentBy?: Message['sentBy'];
    },
    now: string,
  ) {
    // The chat goes on now, so the plan to go on after the limit that stopped it is used up, and
    // a rewind back to that reply leaves it waiting for the user.
    const limited = limitedReply(conversation);
    if (limited?.autoContinue && !limited.autoContinue.off) {
      limited.autoContinue = { ...limited.autoContinue, off: true, changedAt: now };
      marks.chat(conversation.id, limited.id);
    }
    conversation.messages.push(userMessage(input, now));
  }
  function userMessage(
    input: Pick<QueuedMessage, 'text' | 'skills' | 'mentions'> & {
      images: StoredImage[];
      sentBy?: Message['sentBy'];
    },
    now: string,
  ): Message {
    return {
      id: crypto.randomUUID(),
      role: 'user',
      ...(input.sentBy ? { sentBy: input.sentBy } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
      blocks: [
        {
          type: 'markdown',
          text: input.text,
        },
      ],
      ...(input.images.length ? { images: input.images.map(storedImage) } : {}),
      status: 'complete',
      createdAt: now,
    };
  }
  /**
   * Replies a reload of the window left running, in the order of their chats' messages: two of one
   * chat (a reply waiting for background work and the message that took it over) are followed in
   * turn, so the later one is the chat's running reply, as it was.
   */
  function liveInChatOrder(live: LiveRun[]): LiveRun[] {
    const places = new Map<string, number>();
    for (const conversation of workspace.conversations)
      for (const message of conversation.messages)
        if (message.status === 'running' && message.runId) places.set(message.runId, places.size);
    return [...live].sort((a, b) => (places.get(a.runId) ?? -1) - (places.get(b.runId) ?? -1));
  }
  /**
   * Follows again a reply this computer ran on through a reload of the window (reply_feed.rs).
   * One no chat holds as running, whose chat went or recorded its end, is stopped and let go.
   */
  function followLiveReply(runId: string) {
    for (const conversation of workspace.conversations) {
      const message = conversation.messages.find(
        (m) => m.role === 'assistant' && m.runId === runId,
      );
      if (!message) continue;
      if (message.status === 'running') {
        void startReply(conversation, {
          now: message.createdAt,
          modelName: message.modelName ?? '',
          resume: message,
        });
        return;
      }
      break;
    }
    void cancelRun(runId)
      .catch(() => {})
      .then(() => followRun(runId, () => {}))
      .catch(() => {});
  }
  // Answer the conversation's latest messages and follow the reply until it ends. A reply sent
  // from the queue of a conversation that is not open leaves remembered choices unchanged.
  // A message that takes over a reply waiting for background work (`takeOver`) joins the
  // conversation only once the host confirms that reply handed over its process; until then it
  // stays queued, and a refusal leaves it there. A reply this computer ran on through a reload of
  // the window (`resume`) is followed again from its start (src-tauri/src/reply_feed.rs).
  async function startReply(
    conversation: Conversation,
    options: {
      now: string;
      modelName: string;
      compact?: boolean;
      created?: boolean;
      remember?: boolean;
      takeOver?: { reply: Message; wait: number; user: Message; itemId: string };
      // The mission a workflow's orchestrator chat drives, which gives it the mission tools.
      mission?: { runId: string; role: 'orchestrator' };
      resume?: Message;
    },
  ) {
    const { now, compact, takeOver, resume } = options;
    const mission = options.mission ?? workflows.missionOf(conversation.id);
    const session = workspaceSession;
    // The reply taken over ends as it hands over, with the text it has now.
    const history = resume
      ? []
      : historyFor(
          takeOver
            ? {
                ...conversation,
                messages: [
                  ...conversation.messages.map((m) =>
                    m.id === takeOver.reply.id ? { ...m, status: 'complete' as const } : m,
                  ),
                  takeOver.user,
                ],
              }
            : conversation,
        );
    const assistantId = resume?.id ?? crypto.randomUUID();
    const responseSettings = structuredClone(
      $state.snapshot(resume?.settings ?? conversation.settings),
    );
    const runId = resume?.runId ?? crypto.randomUUID();
    // Legacy host bindings cannot tell an account switch from a moved chat by themselves.
    const accountSwitch =
      !!responseSettings.connectionId &&
      conversation.messages.some(
        (m) =>
          m.role === 'assistant' &&
          !!m.settings?.connectionId &&
          m.settings.connectionId !== responseSettings.connectionId,
      );
    if (options.remember) rememberSettings(workspace.preferences, responseSettings);
    const placeholder: Message = resume ?? {
      id: assistantId,
      role: 'assistant',
      settings: responseSettings,
      modelName: options.modelName,
      executionLabel: responseSettings.connectionId
        ? connectionLabel(workspace.fleet, responseSettings.connectionId)
        : `${statusFor(responseSettings.provider)?.location ?? 'This computer'} · CLI login`,
      runId,
      ...(compact ? { compact: true } : {}),
      ...(takeOver ? { tookOver: takeOver.reply.id } : {}),
      promptTokensEstimate: estimatePromptTokens(responseSettings, history),
      blocks: [],
      status: 'running',
      createdAt: now,
    };
    const added = takeOver
      ? [structuredClone($state.snapshot(takeOver.user)), structuredClone(placeholder)]
      : [];
    let joined = !takeOver;
    const join = () => {
      joined = true;
      if (takeOver) {
        const items = (queued[conversation.id] ?? []).filter((m) => m.id !== takeOver.itemId);
        if (items.length) queued[conversation.id] = items;
        else delete queued[conversation.id];
        delete takingOver[conversation.id];
        if (conversation.archived) {
          conversation.archived = false;
          if (activeId === conversation.id) revealConversation(conversation);
        }
        delete conversation.rewind;
        rewoundDrafts.delete(conversation.id);
        conversation.messages.push(takeOver.user);
      }
      if (!resume) {
        conversation.messages.push(placeholder);
        conversation.updatedAt = now;
      }
      runs[conversation.id] = runId;
      holdWork(conversation.id);
    };
    if (joined) join();
    const message = () => conversation.messages.find((m) => m.id === assistantId)!;
    const started = performance.now();
    // How long the reply has run: one followed again has run since it was sent.
    const elapsed = () =>
      resume ? Math.max(0, Date.now() - Date.parse(resume.createdAt)) : performance.now() - started;
    let reasoningSavedAt = 0;
    // The computer that runs a reply publishes its progress; a reply routed to another computer
    // is published by that computer, so this copy of it is only saved here.
    const publishes = runsHere(responseSettings.connectionId);
    // Events of a take-over wait for the host to confirm it.
    const early: RunEvent[] = [];
    try {
      if (joined && !resume) await within(persistChat(conversation.id), replySaveWait);
      if (session !== workspaceSession) return;
      // The folder's icon is chosen after the title, so a new chat starts one background
      // request at a time beside its reply.
      if (options.created)
        void nameConversation(
          conversation.id,
          responseSettings.provider,
          history[0].text || 'A conversation about attached images',
          conversation.title,
          responseSettings.connectionId,
        ).then(() =>
          chooseFolderIcon(
            session,
            conversation.id,
            conversation.location,
            responseSettings,
            history[0].text,
          ),
        );
      const instructions =
        responseSettings.provider === 'claude' ? claudeInstructions(workspace) : '';
      const receive = (event: RunEvent) => {
        if (joined) return apply(event);
        if (event.kind !== 'takeover') return void early.push(event);
        join();
        void persistChat(conversation.id);
        if (activeId === conversation.id) void scrollToEnd(true);
        for (const event of early.splice(0)) apply(event);
      };
      const onEvent = (event: RunEvent) => {
        if (session === workspaceSession) receive(event);
      };
      const result = stopping[conversation.id]
        ? 'cancelled'
        : resume
          ? await followRun(runId, onEvent)
          : await runAgent(
              {
                runId,
                ...(compact ? { compact: true } : {}),
                agent: responseSettings,
                ...(instructions.trim() ? { claudeInstructions: instructions } : {}),
                messages: history,
                conversationId: conversation.id,
                historyRevision: conversation.historyRevision,
                assistantId,
                location: conversation.location?.path ? { ...conversation.location } : undefined,
                ...(accountSwitch ? { accountSwitch: true } : {}),
                ...(conversation.forked ? { forked: true } : {}),
                ...(mission ? { mission } : {}),
                ...(takeOver
                  ? {
                      takeOver: {
                        runId: takeOver.reply.runId!,
                        wait: takeOver.wait,
                        messages: added,
                      },
                    }
                  : {}),
              },
              onEvent,
            );
      if (session !== workspaceSession || !joined) return;
      message().status = result;
      if (result === 'complete') {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) {
          s.auth = 'ready';
          s.detail = 'Connection verified by a completed response.';
        }
      }
    } catch (e) {
      if (session !== workspaceSession) return;
      if (!joined) {
        // The message stays queued for the reply's next idle stretch or its end.
        takeOverRefused[takeOver!.reply.runId!] = takeOver!.wait;
        delete takingOver[conversation.id];
        if (activeId === conversation.id && /new CLI process/.test(String(e)))
          notice = String(e).replace(/^Error: /, '');
        return;
      }
      message().status = 'error';
      message().error = String(e);
      if (String(e).includes('login needs attention')) {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) {
          s.auth = 'login';
          s.detail = 'Sign in through the CLI, then send another message.';
        }
      } else if (String(e).includes('Gemini connection could not be verified')) {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) s.auth = 'unknown';
      }
    } finally {
      if (session === workspaceSession && joined) {
        message().durationMs = message().accountUsage?.runDurationMs ?? elapsed();
        if (publishes) planContinue(conversation, message());
        delete message().backgroundWait;
        delete heardWaits[runId];
        delete questionDrafts[runId];
        conversation.updatedAt = new Date().toISOString();
        if (runs[conversation.id] === runId) {
          delete runs[conversation.id];
          delete stopping[conversation.id];
        }
        saveSoon(conversation.id);
        noteFinishedChats();
        // Publish the end of the reply at once rather than on the next poll: a window
        // behind others or minimized has its timers throttled to about once a minute,
        // which held back the phone alert for the chat by that long. A poll already under
        // way read the reply before it ended, so this one runs after it.
        if (paired) void syncNow(true);
        if (activeId === conversation.id) void scrollToEnd();
        void refreshUsage(responseSettings, true);
        // A workflow waiting for this reply goes on at once.
        workflows.nudge();
        if (releaseAfterReply.has(conversation.id))
          setTimeout(() => releaseWorkflowChat(conversation.id));
      } else if (session === workspaceSession && takingOver[conversation.id] === takeOver?.itemId)
        delete takingOver[conversation.id];
    }
    function apply(event: RunEvent) {
      hearWait(runId, event);
      if (stopping[conversation.id]) void cancelRun(runId).catch(() => {});
      if (hearDraft(runId, event)) {
        if (activeId === conversation.id) void scrollToEnd(true);
        return;
      }
      const m = message();
      // Only a question tool can start asking, so other calls skip reading every block
      // of a reply that may hold thousands.
      const questionTool =
        event.kind === 'tool' && !!event.tool && !event.tool.parentId && asksTheUser(event.tool.name);
      const hadQuestion = questionTool && requestsAttention(m);
      const clock = applyRunEvent(m, event) === 'clock';
      if (event.kind === 'screen' && event.screen) screenSaved(event.screen.environmentId);
      if (event.kind === 'publishedartifact' && event.open && event.publishedArtifact)
        openPublished(
          conversation.id,
          event.publishedArtifact,
          (m.settings ?? conversation.settings).connectionId,
        );
      localChanges++;
      // Every event goes out with the next sync, so other devices follow the text and
      // tool calls as they stream; saving to disk keeps its own, slower rate. Each changes this
      // one message, and a call's running time, which arrives every second, goes out without
      // hurry: a reply waiting on a long call no longer publishes its chat with every poll.
      if (!publishes) marks.received(conversation.id, m.id);
      else if (clock) marks.quiet(conversation.id, m.id);
      else marks.chat(conversation.id, m.id);
      const asks =
        event.kind === 'question' ||
        event.kind === 'elicitation' ||
        (questionTool && !hadQuestion && requestsAttention(m));
      if (
        savesAtOnce(event) ||
        asks ||
        (event.kind === 'reasoning' && Date.now() - reasoningSavedAt >= streamSaveInterval())
      ) {
        if (event.kind === 'reasoning') reasoningSavedAt = Date.now();
        if (publishes) saveSoon(conversation.id, m.id);
        else saveLocalSoon();
      }
      // A question waits for the reader, so it reaches the relay, and the phone alert,
      // at once rather than on a poll that a hidden window runs about once a minute.
      if (asks && publishes && paired) void syncNow(true);
      if (activeId === conversation.id) void scrollToEnd(true);
    }
  }
  async function nameConversation(
    id: string,
    provider: ProviderId,
    firstMessage: string,
    fallback: string,
    connectionId?: string,
  ) {
    const session = workspaceSession;
    try {
      let result: Awaited<ReturnType<typeof generateTitle>> | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await generateTitle(id, provider, firstMessage, connectionId);
          break;
        } catch (error) {
          // A computer names two new chats at a time; chats started together wait their turn.
          if (attempt >= 40 || !String(error).includes('Title generation is already busy'))
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (
          session !== workspaceSession ||
          workspace.conversations.find((c) => c.id === id)?.titleStatus !== 'pending'
        )
          return;
      }
      if (session !== workspaceSession) return;
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (
        !conversation ||
        conversation.titleStatus !== 'pending' ||
        conversation.title !== fallback
      )
        return;
      if (!result?.title?.trim()) throw new Error('No title returned');
      conversation.title = result.title;
      conversation.titleStatus = 'generated';
      conversation.titleSource = { provider: result.provider, model: result.model };
      saveSoon(conversation.id);
      void refreshUsage(conversation.settings, true);
    } catch {
      if (session !== workspaceSession) return;
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (conversation?.titleStatus === 'pending') {
        conversation.titleStatus = 'fallback';
        saveSoon(conversation.id);
      }
    }
  }
  // Folders this window asked a model to choose an icon for, so a failed choice is tried again
  // only after the window reloads.
  const folderIconRequests = new Set<string>();
  // The first conversation in a folder without an icon has a small model of its agent choose
  // one from the catalog, as it names the conversation; every device then shows it. `session` is
  // the workspace the conversation started in, which the choice never outlives.
  async function chooseFolderIcon(
    session: number,
    id: string,
    location: ChatLocation | undefined,
    settings: ChatSettings,
    firstMessage: string,
  ) {
    if (session !== workspaceSession || !location?.path) return;
    const key = folderIconKey(location);
    if (folderIconRequests.has(key) || iconsByFolder.has(key)) return;
    folderIconRequests.add(key);
    try {
      let result: Awaited<ReturnType<typeof generateFolderIcon>> | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await generateFolderIcon(
            id,
            settings.provider,
            location.path,
            firstMessage,
            settings.connectionId,
          );
          break;
        } catch (error) {
          // A computer chooses two icons at a time; folders started together wait their turn.
          if (attempt >= 40 || !String(error).includes('Folder icon choice is already busy'))
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (session !== workspaceSession) return;
      }
      // Another device may have chosen one meanwhile.
      if (session !== workspaceSession || folderIconOf(iconsByFolder, location)) return;
      const icon = folderIconSchema.parse({
        environmentId: location.environmentId,
        path: location.path,
        icon: result.icon,
        source: { provider: result.provider, model: result.model },
        chosenAt: new Date().toISOString(),
      });
      workspace.folderIcons = withFolderIcon($state.snapshot(workspace.folderIcons), icon);
      await persistSettings();
    } catch {
      // The folder keeps the folder mark until a chat there after a reload tries again.
    }
  }
  /**
   * A reply this computer ran that a usage limit stopped: its chat goes on by itself once the
   * limit resets (src/lib/auto-continue.ts). A workflow's chats are left to the workflow, which
   * waits for resets itself, and a /compact reply to the next /compact.
   */
  function planContinue(conversation: Conversation, reply: Message) {
    if (
      reply.autoContinue ||
      reply.compact ||
      limitedReply(conversation)?.id !== reply.id ||
      hiddenChats.has(conversation.id)
    )
      return;
    reply.autoContinue = startedPlan(Date.now());
    // Its time is often known at once, from the provider's line or the reading.
    setTimeout(continueLimitedChats);
  }
  /** Whether this computer runs a chat's next reply, and so makes it go on after a limit. */
  function drivesContinue(conversation: Conversation) {
    const { settings, location } = conversation;
    if (!desktop() || hiddenChats.has(conversation.id)) return false;
    if (settings.connectionId) return runsHere(settings.connectionId);
    return (
      !!location &&
      executionHost(workspace.fleet, location.executionEnvironmentId ?? location.environmentId) ===
        installation?.id
    );
  }
  // Chats on their way to going on after a usage limit, and when each last asked for a reading.
  const continuing = new Set<string>();
  const continueReads = new Map<string, number>();
  /** Takes the next step for each chat a usage limit stopped that this computer runs. */
  function continueLimitedChats() {
    if (!loaded || !desktop() || !installation) return;
    for (const conversation of workspace.conversations) {
      const plan = limitedReply(conversation)?.autoContinue;
      if (!plan || plan.off || continuing.has(conversation.id) || !drivesContinue(conversation))
        continue;
      const id = conversation.id;
      continuing.add(id);
      void continueChat(id)
        .catch(() => {})
        .finally(() => continuing.delete(id));
    }
  }
  async function continueChat(id: string) {
    const session = workspaceSession;
    const waiting = () => {
      const conversation = workspace.conversations.find((c) => c.id === id);
      const reply = conversation && limitedReply(conversation);
      return conversation && reply?.autoContinue && !reply.autoContinue.off
        ? { conversation, reply }
        : undefined;
    };
    let found = waiting();
    if (!found) return;
    // The usage of the account the chat's next message goes to.
    const { provider, connectionId } = found.conversation.settings;
    const account = { provider, model: '', connectionId };
    const reading = () => snapshotFor(usageSnapshots, account);
    let step = continueStep(found.conversation, reading(), Date.now());
    if (step.kind === 'read') {
      // A reading under way, or one asked for a moment ago, decides at the next look.
      if (usageLoading[usageKey(account)] || Date.now() - (continueReads.get(id) ?? 0) < 60_000)
        return;
      continueReads.set(id, Date.now());
      await refreshUsage(account, true);
      found = session === workspaceSession ? waiting() : undefined;
      if (!found || found.conversation.settings.connectionId !== connectionId) return;
      step = continueStep(found.conversation, reading(), Date.now(), true);
    }
    const { conversation, reply } = found;
    if (step.kind === 'plan') {
      reply.autoContinue = step.plan;
      saveSoon(conversation.id, reply.id);
    } else if (step.kind === 'send' && canSendQueued(conversation) && !takingOver[conversation.id])
      continueAfterLimit(conversation);
  }
  /** Sends a chat a usage limit stopped its next message, once the limit reset. */
  function continueAfterLimit(conversation: Conversation) {
    const now = new Date().toISOString();
    if (conversation.archived) {
      conversation.archived = false;
      if (activeId === conversation.id) revealConversation(conversation);
    }
    delete conversation.rewind;
    rewoundDrafts.delete(conversation.id);
    addUserMessage(conversation, { text: continueText, images: [], sentBy: 'limit' }, now);
    const { provider, model } = conversation.settings;
    const catalog = modelCache.get(modelScopeKey(conversation.settings))?.catalog ?? fallbackModels;
    void startReply(conversation, {
      now,
      modelName: selectedModelName(model, modelChoices(catalog, provider, model)),
    });
  }
  /** Keeps a chat from going on by itself after the usage limit that stopped its last reply. */
  function cancelContinue(conversationId: string, messageId: string) {
    const conversation = workspace.conversations.find((c) => c.id === conversationId);
    const reply = conversation && limitedReply(conversation);
    if (!reply || reply.id !== messageId || !reply.autoContinue || reply.autoContinue.off) return;
    reply.autoContinue = { ...reply.autoContinue, off: true, changedAt: new Date().toISOString() };
    saveSoon(conversationId, messageId);
    // The computer running the chat may be about to send it.
    if (paired) void syncNow(true);
  }
  /**
   * Ends the replies saved as running that this computer runs without holding their run, here and
   * on every device: nothing else would end one. Stop never changed one, steering found it ended and
   * a queued message waited for it for good (2026-10-15). `now` names a chat whose replies end at
   * the first check, as Stop asks.
   */
  async function endAbandonedReplies(now?: string) {
    if (!loaded || !paired) return;
    const session = workspaceSession;
    let ended: Awaited<ReturnType<typeof abandonedReplies>>;
    try {
      ended = await abandonedReplies(workspace.conversations, now);
    } catch {
      // The next check looks again.
      return;
    }
    if (session !== workspaceSession || !ended.length) return;
    for (const { conversationId, messageId } of ended) {
      const conversation = workspace.conversations.find((c) => c.id === conversationId);
      const message = conversation?.messages.find((m) => m.id === messageId);
      if (!conversation || message?.status !== 'running') continue;
      message.status = 'cancelled';
      message.error = abandonedReplyError;
      delete message.backgroundWait;
      delete heardWaits[message.runId!];
      delete questionDrafts[message.runId!];
      saveSoon(conversation.id, message.id);
    }
    noteFinishedChats();
    void syncNow(true);
  }
  async function stop() {
    const conversationId = activeId;
    const ownedRun = conversationId ? runs[conversationId] : undefined;
    const id = ownedRun ?? observedReply?.runId;
    if (!conversationId || !id || stopping[conversationId]) return;
    if (!ownedRun) {
      try {
        await cancelRun(id, observedReply?.settings?.connectionId);
        await endAbandonedReplies(conversationId);
      } catch (e) {
        notice = String(e);
      }
      return;
    }
    stopping[conversationId] = true;
    try {
      await cancelRun(id, observedReply?.settings?.connectionId);
    } catch (e) {
      notice = String(e);
      if (runs[conversationId] === ownedRun) delete stopping[conversationId];
    }
  }
  async function login(id: ProviderId, connectionId?: string) {
    try {
      // One opened on another computer goes on reporting to this window until it ends.
      const view = await signIn(id, connectionId, applySignIn);
      if (view) {
        notice = view.userCode
          ? `Open the sign-in page and enter ${view.userCode} to sign in to ${providers[id].name}.`
          : `Finish signing in to ${providers[id].name} in your browser.`;
        signInPrompt = { key: signInKey(view), text: notice };
        applySignIn(view);
        return;
      }
      // Antigravity signs in in a terminal of its own, so its account is followed instead.
      pendingSignIns.set(connectionId ?? id, {
        provider: id,
        connectionId,
        until: Date.now() + 10 * 60_000,
      });
      notice = `Finish signing in through ${providers[id].name}.`;
      signInPrompt = { key: connectionId ?? id, text: notice };
      void refresh();
    } catch (e) {
      notice = String(e);
      throw e;
    }
  }
  // The CLI reports how its sign-in ended. Once it saved a login, the account is checked at
  // once and reads connected; a sign-in that failed or expired says why on its account.
  function applySignIn(view: SignInView) {
    const key = signInKey(view);
    const update = signInUpdate(signIns[key], view);
    if (update === 'ignore') return;
    if (update === 'show' || update === 'ended') signIns[key] = view;
    else delete signIns[key];
    if (update !== 'show') endSignInPrompt(key);
    if (update === 'connected') {
      pendingSignIns.set(key, {
        provider: view.provider,
        connectionId: view.connectionId,
        until: Date.now() + 60_000,
      });
      void checkSignIn();
    } else if (update === 'ended') {
      const connection = workspace.fleet.connections.find((c) => c.id === view.connectionId);
      const account = workspace.fleet.accounts.find((a) => a.id === connection?.accountId);
      notice = `${providers[view.provider].name}${account ? ` · ${account.name}` : ''}: ${view.message}`;
    }
  }
  async function stopSignIn(view: SignInView) {
    const key = signInKey(view);
    if (signIns[key]?.id === view.id) {
      delete signIns[key];
      endSignInPrompt(key);
    }
    await cancelSignIn(view.id);
  }
  async function sendSignInCode(view: SignInView, code: string) {
    applySignIn(await submitSignInCode(view.id, code));
  }
  // An export stands on its own: its images carry their bytes, which the desktop reads from its
  // image store and a browser from the relay's. Images neither holds keep their references.
  const unexported = (missing: number) =>
    missing
      ? ` ${missing} ${missing === 1 ? 'image was' : 'images were'} not available and ${missing === 1 ? 'keeps its reference' : 'keep their references'}.`
      : '';
  async function exportWorkspace() {
    try {
      // Workflows go with the export, from their own store (docs/WORKFLOWS.md).
      const workflowStore = await workflows.exportAll().catch(() => undefined);
      if (desktop()) {
        const { invoke } = await import('@tauri-apps/api/core');
        const exported = await invoke<{ path: string; missingImages: number }>('export_workspace', {
          workspace: { ...$state.snapshot(workspace), ...(workflowStore ? { workflowStore } : {}) },
        });
        notice = `Workspace exported to ${exported.path}.${unexported(exported.missingImages)}`;
      } else {
        // A light Viewer puts back each chat's work from the relay as it writes the file.
        const { blob, missing } = await browserExport({
          ...$state.snapshot(workspace),
          ...(workflowStore ? { workflowStore } : {}),
        } as Workspace);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'agent-studio-workspace.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (missing) notice = `Workspace exported.${unexported(missing)}`;
      }
    } catch (e) {
      notice = String(e);
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Tab' && (editorOpen || contextOpen || deletion)) {
      const modal = document.querySelector(
        deletion ? '[role="alertdialog"]' : '[aria-modal="true"]',
      );
      const elements = modal?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, textarea, select, summary, [tabindex="0"]',
      );
      if (elements?.length) {
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          !modal?.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (event.key === 'Escape') {
      editorOpen = false;
      contextOpen = false;
      if (!deleting) deletion = null;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!deletion) newChat();
    }
  }
</script>

<svelte:head
  ><title>{desktop() ? 'Agent Studio' : 'Agent Studio Viewer'}</title><meta
    name="description"
    content="Your AI agents, together in one local workspace."
  /></svelte:head
>
<svelte:window
  bind:innerWidth={viewportWidth}
  onkeydown={(event) => {
    if (!desktop() && !paired) return;
    // Native modal dialogs own their keyboard navigation, including inside the drawer.
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    if (mobile && sidebarOpen && !deletion) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void toggleSidebar(false);
        return;
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(sidebarElement?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, [tabindex="0"]',
          ) ?? []),
        ].filter((element) => element.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    if (event.key === 'Escape') {
      imageDragDepth = 0;
      workflowMenu = false;
    }
    keyboard(event);
  }}
  ondragover={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
  }}
  ondrop={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
    imageDragDepth = 0;
  }}
  ondragend={() => (imageDragDepth = 0)}
  onblur={() => (imageDragDepth = 0)}
  onclickcapture={codeBlockClick}
  onpointerdown={(event) => {
    // The Make a workflow menu closes on a press outside it.
    if (workflowMenu && !(event.target instanceof Element && event.target.closest('.workflow-from-chat')))
      workflowMenu = false;
  }}
/>

<!-- A chat's row in the sidebar. A pinned chat's row, atop its tab, shows its folder's icon. -->
{#snippet conversationRow(c: Conversation, pinned?: PinnedChat)}{@const runningReply =
    c.messages.find((m) => m.status === 'running')}{@const finished =
    !runningReply && !!finishedChats[c.id]}{@const monitors = runningReply
    ? 0
    : runningMonitors(c.id)}{@const plan =
    runningReply && runningPlanProgress(c.messages)}{@const snoozed =
    snoozesByChat.has(c.id) && !!snoozeOf(c)}{@const notes = rowNotes(
    finished,
    monitors,
    plan,
    snoozed,
  )}
  <div class="conversation-row">
    <button
      class="conversation-item"
      class:pinned-item={!!pinned}
      class:current={activeId === c.id && view === 'chat'}
      aria-current={activeId === c.id && view === 'chat' ? 'page' : undefined}
      aria-haspopup="menu"
      data-conversation={c.id}
      oncontextmenu={(event) => openConversationMenu(event, c.id)}
      onkeydown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
          openConversationMenu(event, c.id);
      }}
      onpointerdown={(event) => startTouchMenu(event, c.id)}
      onpointermove={moveTouchMenu}
      onpointerup={cancelTouchMenu}
      onpointercancel={cancelTouchMenu}
      onclick={(event) => {
        if (longPressedConversation === c.id) {
          event.preventDefault();
          longPressedConversation = undefined;
        } else openConversation(c);
      }}
      title={[c.title, ...notes].join(' · ')}
      aria-label={notes.length
        ? [c.title, ...notes.map((note) => note.toLowerCase())].join(', ')
        : undefined}
      >{#if finished}<i class="conversation-finished" aria-hidden="true"
        ></i>{:else if pinned?.location?.path}<FolderIcon
          icon={folderIconOf(iconsByFolder, pinned.location)?.icon}
          size={13}
        />{:else if pinned}<MessageCircle size={13} aria-hidden="true" />{/if}<span>{c.title}</span
      >{#if plan}<small class="conversation-plan" aria-hidden="true"
          >{plan.count}/{plan.total}</small
        >{/if}{#if runningReply && awaitingAnswer(runningReply)}<MessageCircleQuestionMark
          size={14}
          class="conversation-waiting"
          aria-hidden="true"
        />{:else if runningReply}{@const started = Date.parse(
          runningReply.createdAt,
        )}{#if Number.isFinite(started)}<span class="conversation-running" aria-hidden="true"
            >{toolElapsed(Math.max(0, clock.now - started))}</span
          >{:else}<LoaderCircle
            size={14}
            class="spinning conversation-running"
            aria-hidden="true"
          />{/if}{:else if monitors}<Activity
          size={14}
          class="conversation-monitoring"
          aria-hidden="true"
        />{:else if snoozed}<AlarmClock
          size={14}
          class="conversation-snoozed"
          aria-hidden="true"
        />{/if}</button
    >{#if !c.archived && !conversationRunning(c)}<button
        class="conversation-archive"
        title="Move to history"
        aria-label={`Move ${c.title} to history`}
        onclick={(event) => archiveRow(event, c)}><Archive size={14} aria-hidden="true" /></button
      >{/if}
  </div>
{/snippet}

{#if !desktop() && !paired}
  <WorkspaceLogin
    checking={(!loaded || relayRestorePending) && !storageError && !syncError}
    ready={loaded}
    {online}
    error={storageError || syncError}
    retry={() => {
      if (storageError) window.location.reload();
      else void restoreRelayConnection();
    }}
    login={(key) => pair(window.location.origin, key)}
  />
{:else}
<div
  class="app-shell"
  class:drawer-dragging={drawerDrag !== undefined}
  class:drawer-settling={drawerSettling}
  data-console={consoles || undefined}
  style:--sidebar-width={sidebarWidth ? `${sidebarWidth}px` : undefined}
  style:--drawer-progress={drawerDrag}
>
  {#if mobile}<button
      class="sidebar-backdrop"
      class:mobile-open={sidebarOpen}
      aria-label="Close conversation menu"
      inert={!sidebarOpen}
      onclick={() => toggleSidebar(false)}
    ></button>{/if}
  <aside
    class="sidebar"
    class:mobile-open={mobile && sidebarOpen}
    id="conversation-sidebar"
    bind:this={sidebarElement}
    inert={mobile && (!sidebarOpen || !!deletion)}
    role={mobile ? 'dialog' : undefined}
    aria-modal={mobile && sidebarOpen ? true : undefined}
    aria-label="Conversations"
  >
    <button
      class="icon-button mobile-close"
      aria-label="Close conversations"
      onclick={() => toggleSidebar(false)}><X size={20} /></button
    >
    <button
      class="brand"
      class:draggable-brand={desktop()}
      data-tauri-drag-region={desktop() ? 'deep' : undefined}
      onclick={() => {
        view = 'chat';
        sidebarOpen = false;
      }}
      aria-label="Back to conversation"
      title="Back to conversation"
    >
      <BrandMark />
      <span>agent<span class="brand-light">studio</span></span>
      {#if !desktop()}<span class="viewer-label">Viewer</span>{/if}
    </button>
    <div class="sidebar-modes">
      <div class="mode-switch" role="tablist" aria-label="Mode">
        <button
          id="mode-agent"
          role="tab"
          aria-selected={sidebarMode === 'agent'}
          aria-controls={sidebarMode === 'agent' ? 'sidebar-agent' : undefined}
          tabindex={sidebarMode === 'agent' ? 0 : -1}
          disabled={!loaded}
          onclick={() => void switchMode('agent')}
          onkeydown={modeKey}
          ><Bot size={15} aria-hidden="true" /><span class="mode-label">Agent</span
          >{#if pendingChats > 0}<span
              class="pending-chat-count"
              title="Pending chats"
              aria-hidden="true">{pendingChats}</span
            >{/if}</button
        ><button
          id="mode-workflow"
          role="tab"
          aria-selected={sidebarMode === 'workflow'}
          aria-controls={sidebarMode === 'workflow' ? 'sidebar-workflow' : undefined}
          tabindex={sidebarMode === 'workflow' ? 0 : -1}
          disabled={!loaded}
          onclick={() => void switchMode('workflow')}
          onkeydown={modeKey}
          ><Workflow size={15} aria-hidden="true" /><span class="mode-label">Workflow</span
          >{#if workflowsInProgress}<span
              class="nav-count"
              class:attention={workflowsWaiting}
              title={workflowsWaiting ? 'Waiting for you' : 'In progress'}
              aria-label={`${workflowsInProgress} in progress`}>{workflowsInProgress}</span
            >{/if}</button
        >
      </div>
      <span
        class="pending-chats-status"
        role="status"
        aria-live="polite"
        aria-label={`${pendingChats} pending chats`}>{pendingChats || ''}</span
      >
      {#if sidebarMode === 'workflow'}<button
          class="icon-button"
          onclick={() => newWorkflowChat()}
          aria-label="New workflow"
          title="New workflow"
          disabled={!loaded}><Plus size={15} /></button
        >{:else}<button
          class="icon-button"
          onclick={() => newChat()}
          aria-label="New conversation"
          title="New conversation (Ctrl+N)"
          aria-keyshortcuts="Control+N Meta+N"
          disabled={!loaded}><Plus size={15} /></button
        >{/if}
    </div>
    <label class="search"
      ><Search size={14} /><input
        aria-label={sidebarMode === 'workflow' ? 'Search workflows' : 'Search conversations'}
        placeholder={sidebarMode === 'workflow'
          ? 'Search workflows'
          : conversationScope === 'screens'
            ? 'Search screens'
            : 'Search conversations'}
        bind:value={query}
      />{#if query}<button
          class="icon-button"
          onclick={() => (query = '')}
          aria-label="Clear search"><X size={12} /></button
        >{/if}</label
    >
    <!-- Each mode's list fills the sidebar, however many chats or workflows there are. -->
    {#if sidebarMode === 'workflow'}<div
        id="sidebar-workflow"
        class="conversation-list workflow-browser"
        role="tabpanel"
        aria-labelledby="mode-workflow"
      >
      <ul id="sidebar-workflows" class="workflow-list" aria-label="Workflows">
          {#each listedWorkflows as { summary, run } (summary.id)}{@const shown = workflowOnScreen(
              summary.id,
            )}{@const started = Date.parse(run?.createdAt ?? '')}<li>
              <button
                class="conversation-item workflow-item"
                class:current={shown}
                aria-current={shown ? 'page' : undefined}
                title={summary.title}
                onclick={() => openWorkflow(summary.id)}
                >{#if summary.mode === 'dynamic'}<Target
                    size={13}
                    aria-hidden="true"
                  />{:else}<Workflow size={13} aria-hidden="true" />{/if}<span>{summary.title}</span
                >{#if run && runActive(run.status)}{#if run.questions}<MessageCircleQuestionMark
                      size={14}
                      class="conversation-waiting"
                      aria-label="Waiting for you"
                    />{:else if run.status === 'paused'}<CirclePause
                      size={14}
                      class="conversation-paused"
                      aria-label="Paused"
                    />{:else if Number.isFinite(started)}<span
                      class="conversation-running"
                      aria-hidden="true">{toolElapsed(Math.max(0, clock.now - started))}</span
                    >{/if}{/if}</button
              >
            </li>{:else}<li>
              <SidebarEmpty
                icon={query ? SearchX : Workflow}
                title={query ? 'No matches' : 'No workflows'}
              />
            </li>{/each}
      </ul>
    </div>{:else}<div
        id="sidebar-agent"
        class="sidebar-panel"
        role="tabpanel"
        aria-labelledby="mode-agent"
      >
    <div class="conversation-tabs" role="tablist" aria-label="Conversations and screens">
      {#each conversationGroups as group}
        <button
          id={`conversation-tab-${group.id}`}
          role="tab"
          aria-selected={conversationScope === group.id}
          aria-controls={`conversation-panel-${group.id}`}
          tabindex={conversationScope === group.id ? 0 : -1}
          onclick={() => (conversationScope = group.id as 'active' | 'history')}
          onkeydown={conversationTabKey}
          ><span>{group.name}</span><span class="conversation-tab-count">{group.count}</span
          ></button
        >
      {/each}
      <button
        id="conversation-tab-screens"
        role="tab"
        aria-selected={conversationScope === 'screens'}
        aria-controls="conversation-panel-screens"
        aria-label="Screens"
        title="Screens"
        tabindex={conversationScope === 'screens' ? 0 : -1}
        onclick={() => (conversationScope = 'screens')}
        onkeydown={conversationTabKey}
        ><LayoutDashboard size={14} class="tab-icon" aria-hidden="true" /><span class="tab-label"
          >Screens</span
        >{#if screensChecked}<span class="conversation-tab-count">{screenCount}</span>{/if}</button
      >
    </div>
    <div class="conversation-list">
      {#each conversationGroups as group}
        <div
          id={`conversation-panel-${group.id}`}
          class="conversation-section"
          role="tabpanel"
          tabindex="0"
          aria-labelledby={`conversation-tab-${group.id}`}
          hidden={conversationScope !== group.id}
        >
          {#if group.id === 'active' && listedRuns.length}<section
              class="running-workflows"
              aria-labelledby="running-workflows-heading"
            >
              <h2 id="running-workflows-heading" class="snoozed-heading">
                <Workflow size={13} aria-hidden="true" />Workflows
              </h2>
              {#each listedRuns as s (s.id)}{@const started = Date.parse(
                  s.createdAt ?? '',
                )}{@const shown = runShown(s.id)}{@const state = s.questions
                  ? 'Waiting for you'
                  : s.status === 'paused'
                    ? 'Paused'
                    : s.detail || 'Running'}
                <div class="conversation-row">
                  <button
                    class="conversation-item workflow-run-item"
                    class:current={shown}
                    aria-current={shown ? 'page' : undefined}
                    title={`${s.title} · ${state}`}
                    aria-label={`${s.title}, ${state.toLowerCase()}`}
                    onclick={() => openWorkflow(s.id)}
                    >{#if s.mode === 'dynamic'}<Target
                        size={13}
                        aria-hidden="true"
                      />{:else}<Workflow size={13} aria-hidden="true" />{/if}<span>{s.title}</span
                    >{#if s.questions}<MessageCircleQuestionMark
                        size={14}
                        class="conversation-waiting"
                        aria-hidden="true"
                      />{:else if s.status === 'paused'}<CirclePause
                        size={14}
                        class="conversation-paused"
                        aria-hidden="true"
                      />{:else if Number.isFinite(started)}<span
                        class="conversation-running"
                        aria-hidden="true">{toolElapsed(Math.max(0, clock.now - started))}</span
                      >{:else}<LoaderCircle
                        size={14}
                        class="spinning conversation-running"
                        aria-hidden="true"
                      />{/if}</button
                  >
                </div>
              {/each}
            </section>{/if}
          {#if group.id === 'active' && listedSnoozes.length}<section
              class="snoozed-chats"
              aria-labelledby="snoozed-heading"
            >
              <h2 id="snoozed-heading" class="snoozed-heading">
                <AlarmClock size={13} aria-hidden="true" />Snoozed
              </h2>
              {#each listedSnoozes as c (c.id)}{@const location = conversationLocation(
                  c,
                  workspace.fleet,
                  installation,
                )}
                <div class="snoozed-chat" role="group" aria-label={c.title}>
                  <span class="snoozed-title" title={c.title}
                    >{#if location?.path}<FolderIcon
                        icon={folderIconOf(iconsByFolder, location)?.icon}
                        size={13}
                      />{:else}<MessageCircle size={13} aria-hidden="true" />{/if}<span
                      >{c.title}</span
                    ></span
                  >
                  <div class="snoozed-actions">
                    <button
                      class="snoozed-open"
                      title="Open"
                      aria-label="Open"
                      onclick={() => openSnoozed(c)}
                      ><MessageSquare size={14} aria-hidden="true" /></button
                    >
                    <button
                      title="Snooze again"
                      aria-label="Snooze again"
                      onclick={(event) => leaveSnoozed(event, c, true)}
                      ><AlarmClock size={14} aria-hidden="true" /></button
                    >
                    <button
                      title="Close"
                      aria-label="Close"
                      onclick={(event) => leaveSnoozed(event, c, false)}
                      ><X size={14} aria-hidden="true" /></button
                    >
                  </div>
                </div>
              {/each}
            </section>{/if}
          {#if group.pinned.length}<section
              class="pinned-chats"
              aria-labelledby={`pinned-heading-${group.id}`}
            >
              <h2 id={`pinned-heading-${group.id}`} class="snoozed-heading">
                <Pin size={13} aria-hidden="true" />Pinned
              </h2>
              <div class="pinned-conversations">
                {#each group.pinned as pinned (pinned.conversation.id)}{@render conversationRow(
                    pinned.conversation,
                    pinned,
                  )}{/each}
              </div>
            </section>{/if}
          {#each group.sections as section}
            {@const sectionKey = `${group.id}/${section.id}`}
            <div
              class={section.kind === 'computer' ? 'conversation-computer' : 'conversation-session'}
              aria-label={section.kind === 'computer'
                ? `${section.name} ${group.name.toLowerCase()} chats`
                : section.detail}
            >
              {#if section.kind === 'computer'}<div class="computer-group-row">
                  <button
                    class="computer-group-toggle"
                    title={section.name}
                    aria-expanded={!collapsedGroups[sectionKey]}
                    onclick={() => (collapsedGroups[sectionKey] = !collapsedGroups[sectionKey])}
                    ><Laptop size={13} /><span>{section.name}</span
                    >{#if !computerOnline(section.id)}<small class="computer-offline">Offline</small
                      >{/if}<ChevronRight
                      size={12}
                      class={!collapsedGroups[sectionKey] ? 'expanded-chevron' : ''}
                    /></button
                  >
                  <button
                    class="computer-new-chat"
                    title={`New conversation on ${section.name}`}
                    aria-label={`New conversation on ${section.name}`}
                    disabled={!loaded ||
                      selectingLocation ||
                      !computers.some((c) => c.id === section.id)}
                    onclick={() => newChat(undefined, undefined, undefined, section.id)}
                    ><Plus size={14} /></button
                  >
                </div>
              {:else}<div class="session-group-row">
                  <button
                    class="session-group-toggle"
                    title={section.detail}
                    aria-expanded={!collapsedGroups[sectionKey]}
                    onclick={() => (collapsedGroups[sectionKey] = !collapsedGroups[sectionKey])}
                    >{#if section.kind === 'session'}<RotateCcwClock
                        size={13}
                        aria-hidden="true"
                      />{:else}<CalendarDays size={13} aria-hidden="true" />{/if}<span
                      >{section.name}</span
                    ><ChevronRight
                      size={12}
                      class={!collapsedGroups[sectionKey] ? 'expanded-chevron' : ''}
                    /></button
                  >
                </div>{/if}
              {#if !collapsedGroups[sectionKey]}{#each section.folders as folder}
                  {@const folderKey = `${sectionKey}/${folder.id}`}
                  <div class="conversation-folder" aria-label={folder.detail}>
                    <div class="folder-group-row">
                      <button
                        class="folder-group-toggle"
                        title={folder.detail}
                        aria-expanded={!collapsedGroups[folderKey]}
                        onclick={() => (collapsedGroups[folderKey] = !collapsedGroups[folderKey])}
                        >{#if folder.location?.path}<FolderIcon
                            icon={folderIconOf(iconsByFolder, folder.location)?.icon}
                            size={14}
                          />{:else}<MessageCircle
                            size={14}
                          />{/if}<span>{folder.name}</span
                        >{#if section.kind !== 'computer' && section.computers > 1}<small
                            class="folder-computer">{folder.computerName}</small
                          >{/if}<ChevronRight
                          size={12}
                          class={!collapsedGroups[folderKey] ? 'expanded-chevron' : ''}
                        /></button
                      >
                      <button
                        class="folder-new-chat"
                        title={folder.location?.path
                          ? `New conversation in ${folder.name}`
                          : 'New standalone conversation'}
                        aria-label={folder.location?.path
                          ? `New conversation in ${folder.name} on ${folder.computerName}`
                          : `New standalone conversation on ${folder.computerName}`}
                        disabled={!loaded || selectingLocation || !folder.location}
                        onclick={() => newChat(undefined, undefined, folder.location)}
                        ><Plus size={14} /></button
                      >
                    </div>
                    {#if !collapsedGroups[folderKey]}<div class="folder-conversations">
                        {#each folder.scratches as s (s.id)}{@const current =
                            !activeId && scratchId === s.id && view === 'chat'}
                          <div class="conversation-row">
                            <button
                              class="scratch-item"
                              class:current
                              aria-current={current ? 'page' : undefined}
                              aria-haspopup="menu"
                              aria-label={`Unsent draft: ${s.title}`}
                              oncontextmenu={(event) => openConversationMenu(event, s.id, true)}
                              onkeydown={(event) => {
                                if (
                                  event.key === 'ContextMenu' ||
                                  (event.shiftKey && event.key === 'F10')
                                )
                                  openConversationMenu(event, s.id, true);
                              }}
                              onpointerdown={(event) => startTouchMenu(event, s.id, true)}
                              onpointermove={moveTouchMenu}
                              onpointerup={cancelTouchMenu}
                              onpointercancel={cancelTouchMenu}
                              onclick={(event) => {
                                if (longPressedConversation === s.id) {
                                  event.preventDefault();
                                  longPressedConversation = undefined;
                                } else openScratch(s);
                              }}
                              title={`Unsent draft · ${s.title}`}
                              ><PenLine size={13} aria-hidden="true" /><span>{s.title}</span
                              ></button
                            ><button
                              class="conversation-archive"
                              title="Discard draft"
                              aria-label={`Discard draft: ${s.title}`}
                              onclick={(event) => archiveRow(event, s)}
                              ><Archive size={14} aria-hidden="true" /></button
                            >
                          </div>{/each}
                        {#each folder.conversations as c}{@render conversationRow(c)}{/each}
                      </div>{/if}
                  </div>
                {/each}{/if}
            </div>
          {:else}{#if !group.pinned.length && (group.id !== 'active' || (!listedSnoozes.length && !listedRuns.length))}<SidebarEmpty
                icon={query ? SearchX : group.id === 'active' ? MessageSquare : HistoryIcon}
                title={query
                  ? 'No matches'
                  : group.id === 'active'
                    ? 'No active conversations'
                    : 'No conversations in History'}
              />{/if}{/each}
        </div>
      {/each}
      <div
        id="conversation-panel-screens"
        class="conversation-section"
        role="tabpanel"
        tabindex="0"
        aria-labelledby="conversation-tab-screens"
        hidden={conversationScope !== 'screens'}
      >
        {#each screenGroups as group (group.id)}
          {@const groupKey = `screens/${group.id}`}
          <div class="conversation-computer" aria-label={`${group.name} screens`}>
            <div class="computer-group-row">
              <button
                class="computer-group-toggle"
                title={group.name}
                aria-expanded={!collapsedGroups[groupKey]}
                onclick={() => (collapsedGroups[groupKey] = !collapsedGroups[groupKey])}
                ><Laptop size={13} /><span>{group.name}</span
                >{#if !computerOnline(group.id)}<small class="computer-offline">Offline</small
                  >{/if}<ChevronRight
                  size={12}
                  class={!collapsedGroups[groupKey] ? 'expanded-chevron' : ''}
                /></button
              >
            </div>
            {#if !collapsedGroups[groupKey]}<div class="folder-conversations screen-list">
                {#each group.screens as screen (screen.id)}{@const current =
                    view === 'screen' && openedScreen?.id === screen.id}{@const running =
                    screen.running ?? 0}
                  <div class="conversation-row">
                    <button
                      class="conversation-item screen-item"
                      class:current
                      aria-current={current ? 'page' : undefined}
                      title={[
                        screen.title,
                        screen.description,
                        screenFolderName(screen),
                        ...(running ? [`${running} running`] : []),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      aria-label={running ? `${screen.title}, ${running} running` : undefined}
                      onclick={() => openScreen(screen.environmentId, screen.id)}
                      ><LayoutDashboard size={13} aria-hidden="true" /><span>{screen.title}</span
                      >{#if running}<span class="screen-jobs" aria-hidden="true"
                          ><LoaderCircle size={12} class="spinning" /></span
                        >{/if}</button
                    >
                  </div>
                {/each}
              </div>{/if}
          </div>
        {:else}{#if screensLoading}<p class="sidebar-empty">Reading screens…</p>{:else}<SidebarEmpty
              icon={query ? SearchX : LayoutDashboard}
              title={query ? 'No matches' : 'No screens'}
            />{/if}{/each}
        {#each screenProblems as problem (problem.host)}<p class="sidebar-empty screen-problem">
            Could not read the screens of {problem.name}: {problem.error}
          </p>{/each}
      </div>
    </div>
    </div>{/if}
    <div class="sidebar-tools">
      {#if appUpdate?.phase === 'ready' || appUpdate?.phase === 'installing'}<button
          class="update-button"
          disabled={restartingForUpdate || !!restartBlocked(appUpdate)}
          title={restartBlocked(appUpdate) ?? `Version ${appUpdate.version} is ready.`}
          onclick={restartFromSidebar}
          ><RefreshCw size={14} aria-hidden="true" /><span
            >{restartingForUpdate || appUpdate.phase === 'installing'
              ? 'Restarting…'
              : 'Restart to update'}</span
          ></button
        >{/if}
      <button
        class="icon-button connections-button"
        class:active={view === 'connections'}
        aria-label="Connections"
        aria-pressed={view === 'connections'}
        title={view === 'connections' ? 'Back to conversation' : 'Connections'}
        onclick={() => {
          view = view === 'connections' ? 'chat' : 'connections';
          sidebarOpen = false;
        }}><Plug size={17} aria-hidden="true" /></button
      >
      <button
        class="icon-button settings-button"
        class:active={view === 'settings'}
        aria-label="Settings"
        aria-pressed={view === 'settings'}
        title={view === 'settings' ? 'Back to conversation' : 'Settings'}
        onclick={() => {
          view = view === 'settings' ? 'chat' : 'settings';
          sidebarOpen = false;
        }}><Settings size={17} aria-hidden="true" /></button
      >
      {#if desktop() && installation && !installation.server}<button
          class="icon-button shutdown-toggle"
          aria-label="Shut down when chats finish"
          aria-pressed={shutdown.on}
          title={shutdownTitle}
          onclick={toggleShutdown}><Power size={17} aria-hidden="true" /></button
        >{/if}
      {#if !desktop()}<BrowserStatus showConnection={false} compactInstall />{/if}
    </div>
    <SidebarResize onresize={(width) => (sidebarWidth = width)} />
  </aside>

  <main class="main-area" inert={mobile && sidebarOpen}>
    <WindowTitlebar
      title={viewTitle}
      onerror={(message) => (notice = message)}
      onmenu={() => toggleSidebar(true)}
      beforeclose={saveDraftsNow}
    />
    {#if storageError}<div class="error-banner" role="alert">
        <CircleAlert size={17} />{storageError}
      </div>{/if}
    {#if appNotAnswering}<div class="error-banner" role="alert">
        <CircleAlert size={17} />Agent Studio stopped answering this window.<button
          class="text-button"
          onclick={() => window.location.reload()}>Reload window</button
        >
      </div>{/if}
    {#if notice}<div class="notice" role="status">
        <span>{notice}</span><button
          class="icon-button"
          aria-label="Dismiss notification"
          onclick={() => (notice = '')}><X size={16} /></button
        >
      </div>{/if}
    {#if !desktop()}<BrowserStatus
        {paired}
        error={syncError}
        connect={() => (view = 'connections')}
        showInstallButton={false}
      />{/if}

    {#if view === 'chat'}
      <div
        class="chat-workspace card-layout"
        class:has-side-panel={artifactView?.mode === 'panel' || subagentShown}
        class:graph-first={graphFirst}
        class:chat-open={graphFirst && workflowChatShown}
        bind:clientWidth={chatWorkspaceWidth}
      >
        <section
          id="chat-area"
          class="chat-layout"
          class:workflow-chat-card={graphFirst}
          class:closed={graphFirst && !workflowChatShown}
          style:--chat-card-width={graphFirst && chatCardWidth ? `${chatCardWidth}px` : undefined}
          aria-label="Chat"
          ondragenter={(event) => {
            if (hasDraggedFiles(event)) {
              event.preventDefault();
              imageDragDepth++;
            }
          }}
          ondragover={dragImagesOver}
          ondragleave={() => (imageDragDepth = Math.max(0, imageDragDepth - 1))}
          ondrop={dropImages}
        >
          {#if imageDragDepth > 0}
            <div class="image-drop-overlay" role="status">
              <div>
                <Paperclip size={28} aria-hidden="true" />
                <strong
                  >{!imagesSupported
                    ? 'Images need Codex or Claude'
                    : imagesLoading
                      ? 'Reading images…'
                      : 'Drop images to attach'}</strong
                >
              </div>
            </div>
          {/if}
          {#if activeWorkflow && !chatWorkflow && !readOnlyChat}<div
              class="workflow-banner"
              role="note"
            >
              <Workflow size={14} aria-hidden="true" /><span
                >Workflow · <strong>{activeWorkflow.title}</strong></span
              ><button class="text-button" onclick={() => openWorkflow(activeWorkflow.id)}
                >Open workflow</button
              >
            </div>{/if}
          <div class="chat-toolbar" aria-label="Conversation settings">
            <div class="chat-configuration">
              <div class="chat-setting computer-setting">
                <ChoicePicker
                  label="Computer"
                  title={active ? 'Fixed for this conversation' : undefined}
                  value={selectedComputerId}
                  options={[
                    ...computers.map((c) => ({
                      id: c.id,
                      name: c.name,
                      detail: !computerOnline(c.id)
                        ? c.wsl
                          ? `Offline · On ${c.hostName}`
                          : 'Offline'
                        : c.wsl
                          ? `On ${c.hostName}`
                          : undefined,
                    })),
                    ...(selectedComputerId && !selectedComputer
                      ? [{ id: selectedComputerId, name: 'Unavailable computer' }]
                      : []),
                  ]}
                  disabled={!loaded || activeRunning || selectingLocation || !!active}
                  onchange={chooseComputer}
                >
                  {#snippet icon()}<Laptop size={16} />{/snippet}
                </ChoicePicker>
                {#if selectedComputerOffline}<span class="setting-badge">Offline</span>{/if}
              </div>
              <div class="chat-setting folder-setting">
                <ChoicePicker
                  label="Folder"
                  title={selectedLocation
                    ? selectedLocation.path || 'Standalone chat without a project folder'
                    : undefined}
                  value={selectedLocation
                    ? selectedLocation.path
                      ? locationKey(selectedLocation)
                      : 'standalone'
                    : 'browse'}
                  options={[
                    ...(standaloneChoice
                      ? [{
                          id: 'standalone',
                          name: 'Standalone',
                          title: 'Standalone chat without a project folder',
                        }]
                      : []),
                    ...savedLocations.filter((l) => l.path).map((l) => ({
                      id: locationKey(l),
                      name: folderName(l.path),
                      detail:
                        workspace.fleet.environments.find((e) => e.id === l.environmentId)?.name ??
                        'Environment',
                      title: l.path,
                    })),
                    ...(selectedLocation?.path &&
                    !savedLocations.some((l) => locationKey(l) === locationKey(selectedLocation))
                      ? [
                          {
                            id: locationKey(selectedLocation),
                            name: selectedLocation.path
                              ? folderName(selectedLocation.path)
                              : 'Standalone',
                            title:
                              selectedLocation.path || 'Standalone chat without a project folder',
                          },
                        ]
                      : []),
                    { id: 'browse', name: 'Browse folders…' },
                  ]}
                  disabled={!loaded ||
                    !selectedComputer ||
                    activeRunning ||
                    selectingLocation ||
                    !!active}
                  onchange={(id) => {
                    if (active) return;
                    if (id === 'standalone' && standaloneChoice) {
                      void chooseLocation(standaloneChoice, true).catch((e) => (notice = String(e)));
                      return;
                    }
                    const location = savedLocations.find((l) => locationKey(l) === id);
                    if (location) void chooseLocation(location).catch((e) => (notice = String(e)));
                    else folderBrowserOpen = true;
                  }}
                >
                  {#snippet icon()}
                    {#if selectedLocation && !selectedLocation.path}<MessageCircle
                        size={16}
                      />{:else}<FolderIcon
                        icon={folderIconOf(iconsByFolder, selectedLocation)?.icon}
                        size={16}
                      />{/if}
                  {/snippet}
                  {#snippet optionIcon(option)}
                    {#if option.id === 'standalone'}<MessageCircle
                        size={16}
                      />{:else if option.id === 'browse'}<FolderSearch
                        size={16}
                      />{:else}<FolderIcon
                        icon={folderChoiceIcons.get(option.id)}
                        size={16}
                      />{/if}
                  {/snippet}
                </ChoicePicker>
              </div>
              <div class="chat-setting agent-setting">
                <ChoicePicker
                  bind:this={agentPicker}
                  label="Agent"
                  title={`${
                    active
                      ? switchableConnections.length
                        ? 'Another account applies to the next message. '
                        : 'Fixed for this conversation. '
                      : balanceCandidates.length > 1
                        ? 'Account chosen by usage. '
                        : ''
                  }${selectedSettings.planMode ? 'Plan mode: proposes changes before making them.' : 'Full access: tools run without approval prompts.'}`}
                  bind:open={agentPickerOpen}
                  value={selectedAgentOption}
                  options={agentOptions}
                  width={agentPickerOpen && agentOptions.some((option) => listedUsage(option.id))
                    ? 560
                    : undefined}
                  fallbackToFirst={false}
                  placeholder={agentOptions.length ? 'Select agent' : 'No agents'}
                  disabled={!loaded ||
                    readOnlyChat ||
                    selectingLocation ||
                    (desktop() && !selectedLocation && !active) ||
                    (!!active && !switchableConnections.length)}
                  onchange={chooseAgent}
                >
                  {#snippet icon()}{#if selectedAccount}<AccountMark
                        glyph={selectedAccount.mark}
                        color={selectedAccount.color}
                        size="chip"
                      />{:else}<Bot size={16} />{/if}{/snippet}
                  {#snippet optionAside(option)}{@const usage = listedUsage(option.id)}{#if usage}<QuotaBars
                        {...usage}
                      />{/if}{/snippet}
                </ChoicePicker>
              </div>
              <div class="chat-setting model-setting">
                <ChoicePicker
                  bind:this={modelPicker}
                  label="Model"
                  value={selectedSettings.model}
                  options={availableModels}
                  disabled={!loaded ||
                    readOnlyChat ||
                    (desktop() && (locationPending || (!selectedLocation && !active)))}
                  onchange={chooseModel}
                >
                  {#snippet icon()}{#if selectedModelMark.line}<ModelMark
                        mark={selectedModelMark}
                        variant="chip"
                      />{:else}<Cpu size={16} />{/if}{/snippet}
                  {#snippet optionMark(option)}{@const mark = modelMarks.get(option.id)}{#if mark}<ModelMark
                        {mark}
                        variant="pill"
                      />{/if}{/snippet}
                </ChoicePicker>
              </div>
              <div class="chat-setting reasoning-setting">
                <ChoicePicker
                  bind:this={reasoningPicker}
                  label="Reasoning"
                  slider
                  value={selectedSettings.reasoning}
                  options={reasoningOptions}
                  disabled={!loaded ||
                    readOnlyChat ||
                    reasoningOptions.length < 2 ||
                    (desktop() && (locationPending || (!selectedLocation && !active)))}
                  onchange={(value) =>
                    changeSettings({ ...selectedSettings, reasoning: value as Reasoning })}
                >
                  {#snippet icon()}<Brain size={16} />{/snippet}
                </ChoicePicker>
              </div>
            </div>
            {#key activeId}<ToolbarActions>
              {#if active && !active.archived && !readOnlyChat && !chatWorkflow}<button
                  class="icon-button"
                  disabled={activeRunning}
                  onclick={() => archiveOpenChat()}
                  title="Move to history"
                  aria-label="Move to history"><Archive size={16} /></button
                >{/if}
              {#if active && !readOnlyChat && !chatWorkflow}{@const snoozed = !!snoozeOf(active)}<button
                  class="icon-button snooze-toggle"
                  disabled={activeRunning}
                  aria-pressed={snoozed}
                  onclick={toggleOpenSnooze}
                  title={snoozed ? 'Cancel snooze' : 'Snooze until the app restarts'}
                  aria-label="Snooze"><AlarmClock size={16} /></button
                >{/if}
              {#if active && !readOnlyChat && !chatWorkflow}{@const chat = active}{@const pinned =
                  pinsByChat.has(chat.id)}<button
                  class="icon-button pin-toggle"
                  aria-pressed={pinned}
                  onclick={() => togglePin(chat)}
                  title={pinned ? 'Unpin' : 'Pin'}
                  aria-label="Pin"><Pin size={16} /></button
                >{/if}
              {#if workflowFromChatShown && active}{@const chat = active}<div class="workflow-from-chat">
                  <button
                    class="icon-button"
                    disabled={activeRunning || makingWorkflow}
                    aria-haspopup="menu"
                    aria-expanded={workflowMenu}
                    title="Make a workflow"
                    aria-label="Make a workflow"
                    onclick={() => (workflowMenu = !workflowMenu)}><Workflow size={16} /></button
                  >
                  {#if workflowMenu}<div class="menu workflow-from-menu" role="menu" aria-label="Make a workflow">
                      <button role="menuitem" onclick={() => void workflowFromChat(chat, 'workflow')}
                        ><Workflow size={15} aria-hidden="true" />Static</button
                      ><button
                        role="menuitem"
                        disabled={!dynamicFromChat}
                        onclick={() => void workflowFromChat(chat, 'mission')}
                        ><Target size={15} aria-hidden="true" />Dynamic</button
                      >
                    </div>{/if}
                </div>{/if}
              {#if active && !readOnlyChat}<button
                  class="icon-button"
                  disabled={forking || imagesLoading || forkPoint(active) < 0}
                  onclick={() => active && void forkChat(active.id)}
                  title="Fork conversation"
                  aria-label="Fork conversation"><GitFork size={16} /></button
                >{/if}
              <button
                class="icon-button"
                title="Model context"
                aria-label="Model context"
                disabled={!loaded || locationPending || (desktop() && !selectedLocation && !active)}
                onclick={async () => {
                  await saveQueue;
                  contextOpen = true;
                }}><BookOpen size={16} /></button
              >
              <button
                class="icon-button"
                onclick={() => (editorOpen = true)}
                disabled={!loaded || activeRunning || readOnlyChat}
                title="Chat instructions"
                aria-label="Chat instructions"><SlidersHorizontal size={16} /></button
              >
            </ToolbarActions>{/key}
            {#if graphFirst && chatWorkflow}<button
                class="icon-button card-close"
                title="Close"
                aria-label="Close the chat"
                onclick={() => chatWorkflow && (workflowChatOpen[chatWorkflow] = false)}
                ><X size={16} /></button
              >{/if}
          </div>
          {#if accountSwitchPending || nextReplyChanged}
            <p class="next-reply-settings" role="status">
              Next message: {#if accountSwitchPending}<span
                  class="account-dot"
                  style:--account-color={connectionColor(selectedSettings.connectionId)}
                  aria-hidden="true"
                ></span>{accountName(workspace.fleet, selectedSettings.connectionId) ?? 'Another'} account{#if nextReplyChanged}{' · '}{/if}{/if}{#if nextReplyChanged}{selectedModelName(
                  selectedSettings.model,
                  availableModels,
                )} · {reasoningName(selectedSettings.reasoning)} reasoning{#if !!observedReply?.settings?.fastMode !== !!selectedSettings.fastMode}{' · '}{fastModeName(
                    selectedSettings,
                  )}{/if}{/if}
            </p>
          {/if}
          <div
            class="chat-scroll"
            bind:this={chatScroll}
            onscroll={scrolled}
          >
            <div
              class="message-column"
              class:empty={!active?.messages.length}
              bind:this={chatColumn}
            >
              {#if active?.messages.length}
                {#each active.messages as m, i (m.id)}{@const day = dayStarts.get(m.id)}{#if day}<div
                      class="message-day"
                      role="separator"
                      aria-label={day.name}
                    >
                      <span title={day.date}>{day.name}</span>
                    </div>{/if}<MessageView
                    message={m}
                    questionDrafts={m.runId ? questionDrafts[m.runId] : undefined}
                    idle={waitsForWork(m)}
                    background={messageBackgroundWork(m, hostBackground[active.id])}
                    {chatChanges}
                    folder={active.location?.path}
                    timeTotal={timeTotals.get(m.id)}
                    switchNotice={switchNotices.get(m.id)}
                    switchColor={connectionColor(accountSwitches.get(m.id))}
                    agent={active.settings}
                    canRetry={!readOnlyChat &&
                      i === active.messages.length - 1 &&
                      (m.status === 'error' || m.status === 'cancelled') &&
                      !activeRunning}
                    retry={() => void send(true)}
                    retryDisabled={!canSend}
                    switchAccount={!readOnlyChat &&
                    i === active.messages.length - 1 &&
                    switchableConnections.length &&
                    !activeRunning
                      ? () => agentPicker?.showPicker()
                      : undefined}
                    continuation={i === active.messages.length - 1
                      ? continuationOf(active, m)
                      : undefined}
                    rewind={m.role === 'user' && !readOnlyChat ? () => openRewind(m.id) : undefined}
                    undoEdits={!readOnlyChat && m.runId && m.fileChanges?.edits.length
                      ? () => openUndoFiles(m.runId)
                      : undefined}
                    historyDisabled={activeRunning || historyBusy || !!activeQueue.length}
                    fork={!readOnlyChat && m.role === 'assistant' && m.status !== 'running'
                      ? () => active && void forkChat(active.id, m.id)
                      : undefined}
                    forkDisabled={forking || imagesLoading}
                    {openArtifact}
                    inherited={carriedWork?.inherited.get(m.id)}
                    carried={!!carriedWork?.carried.has(m.id)}
                    openSubagent={(agentId, messageId = m.id) => openSubagent(messageId, agentId)}
                    openedSubagent={subagentShown ? subagentView : undefined}
                    openScreen={(card) => openScreen(card.environmentId, card.id)}
                    openPage={claudePagesInApp()
                      ? (card) =>
                          active &&
                          openPage(active.id, card, (m.settings ?? active.settings).connectionId)
                      : undefined}
                  />{/each}
                {#if jumpShown}<div class="jump-to-end-rail">
                    <button
                      type="button"
                      class="jump-to-end"
                      class:live={activeRunning}
                      title="Jump to latest"
                      aria-label="Jump to latest"
                      onclick={jumpToEnd}><ArrowDown size={16} /></button
                    >
                  </div>{/if}
              {:else}<div class="chat-empty">
                  {#if selectedAccount}<div class="welcome-account">
                      <AccountMark
                        glyph={selectedAccount.mark}
                        color={selectedAccount.color}
                        size="large"
                      />
                    </div>{:else}<span
                      class="large-provider"
                      style:--provider-color={providers[selectedAgent.provider].color}
                      >{providers[selectedAgent.provider].mark}</span
                    >{/if}<span class="eyebrow"
                    >A conversation with {selectedAccount?.name ?? selectedAgent.name}</span
                  >
                  <h1>
                    {currentScratch?.workflow
                      ? currentScratch.workflow.id
                        ? 'What should change?'
                        : currentScratch.workflow.mode === 'mission'
                          ? 'What’s the goal?'
                          : 'What should it do?'
                      : 'What’s on your mind?'}
                  </h1>
                  {#if currentScratch?.workflow && !currentScratch.workflow.id}{@const mode =
                      currentScratch.workflow.mode}<div
                      class="workflow-kind"
                      role="radiogroup"
                      aria-label="Create"
                      tabindex="-1"
                      onkeydown={(event) => workflowKindKey(event, mode)}
                    >
                      <button
                        type="button"
                        role="radio"
                        data-kind="workflow"
                        aria-checked={mode === 'workflow'}
                        tabindex={mode === 'workflow' ? 0 : -1}
                        onclick={() => setWorkflowMode('workflow')}
                        ><Workflow size={15} aria-hidden="true" />Static</button
                      ><button
                        type="button"
                        role="radio"
                        data-kind="mission"
                        aria-checked={mode === 'mission'}
                        tabindex={mode === 'mission' ? 0 : -1}
                        onclick={() => setWorkflowMode('mission')}
                        ><Target size={15} aria-hidden="true" />Dynamic</button
                      >
                    </div>{/if}
                </div>{/if}
            </div>
            <div class="chat-virtual-space" aria-hidden="true" bind:this={chatSpace}></div>
          </div>
          <div class="composer-area" bind:this={composerArea}>
            {#if readOnlyChat}<div class="workflow-owned" role="note">
                {#if workflowHome}<button
                    class="text-button back"
                    onclick={() => workflowHome && openWorkflowChat(workflowHome.id)}
                    ><ArrowLeft size={14} aria-hidden="true" />{workflows.summaries.get(
                      chatWorkflow ?? '',
                    )?.kind === 'definition'
                      ? 'Assistant'
                      : 'Orchestrator'}</button
                  >{:else if activeWorkflow?.mode === 'dynamic'}<Target
                    size={15}
                    aria-hidden="true"
                  />{:else}<Workflow size={15} aria-hidden="true" />{/if}<span
                  >Part of <strong>{activeWorkflow?.title ?? 'a workflow'}</strong></span
                >
              </div>
            {:else}{#if active?.rewind}<div class="setup-hint neutral" role="status">
                <Rewind size={15} aria-hidden="true" /><span
                  >Conversation rewound; files unchanged.</span
                ><button
                  class="text-button"
                  disabled={historyBusy || activeRunning}
                  onclick={() => void changeHistory().catch((e) => (historyError = String(e)))}
                  >Undo rewind</button
                >
              </div>{/if}
            {#if historyError}<p class="attachment-notice" role="alert">{historyError}</p>{/if}
            {#if selectedComputerOffline}<div class="setup-hint">
                <Laptop size={15} />{selectedComputer?.name} is offline.
              </div>
            {:else if locationPending || (!selectedLocation && !active)}<div class="setup-hint">
                <Laptop size={15} />{selectedComputer
                  ? 'This computer has no available execution environment.'
                  : 'Choose a computer.'}
              </div>
            {:else if !active && !selectedSettings.connectionId && selectedComputer?.wsl && desktop()}<div
                class="setup-hint"
              >
                <Plug size={15} />{providers[selectedAgent.provider].name} needs to be set up.<button
                  class="text-button"
                  onclick={() => openConnections()}
                  >Open Connections<ArrowRight size={13} /></button
                >
              </div>
            {:else if !selectedStatus && desktop()}<div class="setup-hint">
                {#if selectedRemote}<Laptop size={15} />Computer offline or relay disconnected.
                {:else if selectedSettings.connectionId && !selectedConnection}<Plug
                    size={15}
                  />This connection is no longer available.
                {:else}<RefreshCw size={15} class="spinning" />Checking this computer’s CLIs…{/if}
              </div>
            {:else if !selectedStatus?.installed && !selectedCheckFailed && desktop()}<div
                class="setup-hint"
              >
                <Plug size={15} />{providers[selectedAgent.provider].name} needs to be set up.<button
                  class="text-button"
                  onclick={() => openConnections(selectedSettings.connectionId)}
                  >Open Connections<ArrowRight size={13} /></button
                >
              </div>
            {:else if selectedStatus && (selectedStatus.installed || selectedCheckFailed) && selectedStatus.auth !== 'ready'}<div
                class="setup-hint"
                role="status"
              >
                <Plug size={15} />
                {#if selectedStatus.auth === 'login'}Sign in to {agentOptions.find(
                    (option) => option.id === selectedAgentOption,
                  )?.name ?? providers[selectedAgent.provider].name}.
                {:else}We couldn't verify your {providers[selectedAgent.provider].name} connection.{/if}
                <button
                  class="text-button"
                  onclick={() => openConnections(selectedSettings.connectionId)}
                  >Open Connections<ArrowRight size={13} /></button
                >
              </div>{/if}
            <form
              class="composer"
              aria-label="Message composer"
              onsubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {#if activeQueue.length}<ul
                  class="queued-messages"
                  role="list"
                  aria-label="Queued messages"
                >
                  {#each activeQueue as item (item.id)}<li class="queued-message" role="listitem">
                      <span class="queued-badge"
                        >{activeId && takingOver[activeId] === item.id
                          ? 'Sending now'
                          : activeRunning
                            ? 'After this reply'
                            : 'Queued'}</span
                      >
                      <span class="queued-text" title={item.text}>{queuedPreview(item)}</span>
                      <button
                        type="button"
                        class="queued-remove"
                        aria-label="Return queued message to the composer"
                        title="Return to the composer"
                        onclick={() => {
                          if (activeId) returnQueuedToDraft(activeId, item.id);
                        }}><X size={13} /></button
                      >
                    </li>{/each}
                </ul>{/if}
              {#if attachedImages.length}<ImageAttachments
                  images={attachedImages}
                  remove={(id) => {
                    attachedImages = attachedImages.filter((image) => image.id !== id);
                    attachmentError = '';
                  }}
                />{/if}
              <input
                bind:this={imageInput}
                type="file"
                accept={imageTypes.join(',')}
                multiple
                hidden
                aria-label="Image files"
                onchange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void attachImages(files);
                }}
              />
              <textarea
                bind:this={composerInput}
                aria-label="Message"
                placeholder={activeRunning && !waitingReply
                  ? `Message ${selectedAgent.name} after this reply…`
                  : currentScratch?.workflow && !currentScratch.workflow.id
                    ? currentScratch.workflow.mode === 'mission'
                      ? 'Describe the goal…'
                      : 'Describe the workflow…'
                    : `Message ${selectedAgent.name}…`}
                bind:value={prompt}
                rows="3"
                onpaste={(event) => {
                  const files = Array.from(event.clipboardData?.files ?? []);
                  if (files.length) {
                    event.preventDefault();
                    void attachImages(files);
                  }
                }}
                onkeydown={(e) => {
                  if (composerCommands?.keydown(e)) return;
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobile) {
                    e.preventDefault();
                    void send();
                  }
                }}></textarea>
              <ComposerCommands
                conversationId={active?.id}
                forked={active?.forked}
                bind:this={composerCommands}
                bind:references={draftMentions}
                bind:staleTokens={staleMentionTokens}
                bind:referenceSelection={mentionSelection}
                input={composerInput}
                bind:prompt
                settings={selectedSettings}
                location={selectedLocation?.path ? selectedLocation : undefined}
                available={selectedConnectionAvailable &&
                  !!selectedStatus?.installed &&
                  selectedStatus.auth === 'ready'}
                busy={activeRunning}
                scope={activeId ?? draftKey.scratch(scratchId)}
                oncommand={(name) => {
                  if (name === 'model') void tick().then(() => modelPicker?.showPicker());
                  else if (name === 'reasoning')
                    void tick().then(() => reasoningPicker?.showPicker());
                  else if (name === 'instructions') editorOpen = true;
                  else if (name === 'fast' || name.startsWith('fast:')) commandFastMode(name);
                  else if (name === 'context') contextOpen = true;
                  else if (name === 'usage') usageExpanded = true;
                  else if (name === 'rewind') openRewind();
                  else if (name === 'undo') openUndoFiles();
                  else if (name === 'connections') view = 'connections';
                  else if (name === 'screens') {
                    conversationScope = 'screens';
                    if (mobile) void toggleSidebar(true);
                  } else if (name === 'settings') view = 'settings';
                  else if (name === 'import') openImport();
                  else if (name === 'new') {
                    const remaining = composerContent(),
                      from = composerDraftKey;
                    newChat(
                      selectedSettings.provider,
                      selectedSettings.connectionId,
                      selectedLocation,
                      selectedComputerId,
                      true,
                      false,
                    );
                    // The rest of the command moves into the new conversation's draft.
                    if (composerDraftKey !== from) carryDraft(from, remaining);
                  }
                }}
              />
              {#if imagesLoading}<p class="attachment-notice" role="status">Reading images…</p>{/if}
              {#if imagesSending}<p class="attachment-notice" role="status">{desktop() ? 'Saving images…' : 'Uploading images…'}</p>{/if}
              {#if attachmentError}<p class="attachment-notice" role="alert">{attachmentError}</p>
              {:else if attachedImages.length && !imagesSupported}<p
                  class="attachment-notice"
                  role="alert"
                >
                  Images need Codex or Claude.
                </p>{/if}
              <div class="composer-bottom">
                <div class="composer-tools">
                  {#if currentScratch?.workflow && !currentScratch.workflow.id}
                    {#if currentScratch.workflow.mode === 'mission'}<DriverPicker
                        compact
                        drivers={workflowPickers.drivers}
                        value={missionDriver ?? {
                          preferred: workflowPickers.defaultDriver,
                          elsewhere: true,
                        }}
                        onchange={(next) => (missionDriver = next)}
                      />{/if}
                  {:else}<PlanModePicker settings={selectedSettings} disabled={!loaded || activeRunning} change={changeSettings} />{/if}
                  {#if fastOffered}<button
                      type="button"
                      class="fast-toggle"
                      class:blocked={!!fastModeBlock(currentModel)}
                      aria-label="Fast mode"
                      aria-pressed={!!selectedSettings.fastMode}
                      title={fastModeTitle(currentModel)}
                      disabled={!loaded}
                      onclick={() =>
                        changeSettings({ ...selectedSettings, fastMode: !selectedSettings.fastMode })}
                      ><Zap size={16} aria-hidden="true" />Fast</button
                    >{/if}
                  <button
                    type="button"
                    class="attach-button"
                    aria-label="Attach images"
                    title={imagesSupported ? 'Attach images' : 'Images need Codex or Claude'}
                    disabled={!imagesSupported}
                    onclick={() => imageInput?.click()}><Paperclip size={17} /></button
                  >
                  <button
                    type="button"
                    class="template-button"
                    disabled={!loaded}
                    onclick={() => (templatesOpen = true)}><FileText size={16} />Templates</button
                  >
                </div>
                {#if activeRunning}
                  {#if steeringSupported}<button type="button" class="steer-button" disabled={!canSteer} onclick={steer}
                    title={attachedImages.length || hasComposerMentions || prompt.trimStart().startsWith('/') ? 'Images, mentions and commands wait for the next reply' : 'Send to the running reply'}
                    >{activeSteering ? 'Sending…' : 'Steer now'}</button>{/if}
                  <button
                    class="stop-button"
                    type="button"
                    onclick={stop}
                    disabled={activeStopping}
                    ><CircleStop size={16} />{activeStopping
                      ? 'Stopping…'
                      : 'Stop response'}</button
                  ><button
                    class="send-button"
                    type="submit"
                    disabled={!canQueue || (!prompt.trim() && !attachedImages.length)}
                    aria-label={waitingReply ? 'Send message' : 'Queue message'}
                    title={waitingReply ? 'Send now' : 'Send after this reply'}><ArrowUp size={19} /></button
                  >{:else}<button
                    class="send-button"
                    type="submit"
                    disabled={!canSend || (!prompt.trim() && !attachedImages.length)}
                    aria-label="Send message"><ArrowUp size={19} /></button
                  >{/if}
              </div>
            </form>
            <UsagePanel
              {canCompact}
              compact={() => void send(false, undefined, '/compact')}
              changeAutoCompact={(autoCompactTokens) => changeSettings({ ...selectedSettings, autoCompactTokens })}
              compactionSettingsDisabled={activeRunning}
              bind:expanded={usageExpanded}
              conversation={active}
              settings={selectedSettings}
              model={currentModel}
              snapshot={selectedUsage}
              loading={selectedUsageChecking}
              error={usageErrors[selectedUsageKey] ?? ''}
              preview={!desktop() && !paired}
              accountName={workspace.fleet.accounts.find(a => a.id === workspace.fleet.connections.find(c => c.id === selectedSettings.connectionId)?.accountId)?.name}
              accountUnavailable={!canQueryConnection(selectedSettings.connectionId, selectedSettings.provider)}
            />{/if}
          </div>
        </section>
        <!-- The gap between a workflow's chat card and its graph resizes the card. -->
        {#if graphFirst && workflowChatShown && viewportWidth > 760}<PanelResize
            gutter={16}
            side="right"
            availableWidth={chatWorkspaceWidth}
            share={0.36}
            onresize={(width) => (chatCardWidth = width)}
            storageKey="agent-studio.workflow-chat-share"
            label="Resize chat"
            controls="chat-area"
          />{/if}
        {#if artifactView && panelChat}{@const chat = panelChat}{#if 'page' in artifactView}{@const shown = artifactView}{#key `${chat}:${shown.page.id}`}<ClaudePageViewer
                view={shown}
                accountName={workspace.fleet.accounts.find((a) => a.id === shown.account)?.name}
                accountColor={accountColorValue(colorsByAccount.get(shown.account)?.color)}
                takeFocus={shown.focus}
                changeMode={(mode) => showArtifactAs(chat, mode)}
                reload={() => (shown.load = crypto.randomUUID())}
                close={() => delete artifactViews[chat]}
              />{/key}{:else}{#key `${chat}:${artifactView.artifact.id}`}<ArtifactViewer
              artifact={artifactView.artifact}
              mode={artifactView.mode}
              takeFocus={artifactView.focus}
              changeMode={(mode) => showArtifactAs(chat, mode)}
              close={() => delete artifactViews[chat]}
            />{/key}{/if}{/if}
        {#if graphFirst && chatWorkflow}{@const workflowId = chatWorkflow}{#await workflowView() then { default: WorkflowView }}{#key `${workspaceSession}/${workflowId}`}<div
                class="workflow-main"
              >
                <WorkflowView
                  client={workflows}
                  id={workflowId}
                  pickers={workflowPickers}
                  conversation={(id) => workspace.conversations.find((c) => c.id === id)}
                  openChat={openWorkflowChat}
                  openDoc={openWorkflow}
                  deleteChats={deleteWorkflowChats}
                  closed={() => newChat()}
                  chat={workflowHasChat(workflowId) ? () => toggleWorkflowChat(workflowId) : undefined}
                  chatShown={workflowChatShown}
                  bind:run={panelRuns[workflowId]}
                  {webhookUrl}
                />
              </div>{/key}{/await}{:else if workflowDraft && currentScratch?.workflow}{@const mode =
            currentScratch.workflow.mode}{#await workflowDraftView() then { default: WorkflowDraft }}<div
              class="workflow-main"
            >
              <WorkflowDraft {mode} orchestrator={draftOrchestrator} />
            </div>{/await}{/if}
        {#if subagentShown && subagentReply && subagentView && panelChat}{@const chat = panelChat}{#key chat}<SubagentPanel
              message={subagentReply}
              agentId={subagentView.agentId}
              takeFocus={subagentView.focus}
              folder={active?.location?.path}
              connectionId={(subagentReply.settings ?? active?.settings)?.connectionId}
              carried={!!carriedWork?.carried.has(subagentReply.id)}
              open={(agentId) => subagentReply && openSubagent(subagentReply.id, agentId)}
              close={() => delete subagentViews[chat]}
            />{/key}{/if}
        <FileViewer viewer={shownFiles} />
      </div>
    {:else if view === 'connections'}
      <div class="page-card">
      {#key workspaceSession}
        <FleetManager
          bind:workspace
          {installation}
          {wslDiscovery}
          {wslError}
          {cliInventories}
          {cliUpdates}
          {usageSnapshots}
          {usageLoading}
          {usageErrors}
          bind:statuses={connectionStatuses}
          {presence}
          reconnecting={relayRestorePending && !!syncError}
          {syncStatus}
          {syncError}
          {syncNotice}
          {paired}
          save={persist}
          refresh={() => refresh(true)}
          connect={pair}
          disconnect={unpair}
          resolveConflict={async () => {
            const backup = await resolveRelaySettings();
            notice = `Local workspace backed up to ${backup}. Using the relay’s computer and account settings.`;
            await syncNow();
          }}
          chat={(provider, connectionId, computerId) =>
            newChat(provider, connectionId, undefined, computerId)}
          providerStatuses={statuses}
          {login}
          {signIns}
          cancelSignIn={stopSignIn}
          {sendSignInCode}
          running={localRunning}
          highlight={connectionsHighlight}
        />
      {/key}
      </div>
    {:else if view === 'settings'}
      <div class="page-card">
      {#key workspaceSession}
        <SettingsPage
          {paired}
          {workspaceSession}
          {exportWorkspace}
          {appUpdate}
          {restartToUpdate}
          {cliUpdates}
          {applyCliUpdates}
          environmentName={(id) =>
            workspace.fleet.environments.find((environment) => environment.id === id)?.name ??
            'This computer'}
          balanceAccounts={!!workspace.preferences.balanceAccounts}
          {setBalanceAccounts}
          {balanceChoices}
          {setBalanceIncluded}
          claudeInstructions={workspace.claudeInstructions}
          {saveClaudeInstructions}
          importChats={desktop() ? openImport : undefined}
        />
      {/key}
      </div>
    {:else if view === 'screen' && openedScreen}
      <!-- The screen shows below, among the screens this window keeps open. -->
    {:else if view === 'workflow' && openedWorkflow}
      {#await workflowView() then { default: WorkflowView }}
        {#key `${workspaceSession}/${openedWorkflow}`}
          <WorkflowView
            client={workflows}
            id={openedWorkflow}
            pickers={workflowPickers}
            conversation={(id) => workspace.conversations.find((c) => c.id === id)}
            openChat={openWorkflowChat}
            openDoc={openWorkflow}
            deleteChats={deleteWorkflowChats}
            closed={() => {
              openedWorkflow = undefined;
              newChat();
            }}
            bind:run={openedWorkflowRun}
            chat={(() => {
              const shown = openedWorkflow ? workflows.summaries.get(openedWorkflow) : undefined;
              return shown && (shown.kind === 'definition' || shown.mode === 'dynamic')
                ? () => openWorkflow(shown.id)
                : undefined;
            })()}
            {webhookUrl}
          />
        {/key}
      {:catch error}
        <p class="error-banner" role="alert">{String(error).replace(/^Error: /, '')}</p>
      {/await}
    {/if}
    {#each keptScreens as kept (kept.key)}
      {@const shown = view === 'screen' && openedScreen?.id === kept.id}
      {@const summary = screenSummary(kept.id)}
      {@const environment = workspace.fleet.environments.find((e) => e.id === kept.environmentId)}
      {@const creator = workspace.conversations.find((c) => c.id === summary?.conversationId)}
      <div class="screen-kept" hidden={!shown}>
        <ScreenView
          environmentId={kept.environmentId}
          id={kept.id}
          {summary}
          {shown}
          shell={screenShell(kept.environmentId)}
          computerName={(environment &&
            computers.find((c) => c.id === computerViewId(environment))?.name) ??
            'Its computer'}
          online={environmentOnline(kept.environmentId)}
          openConversation={creator ? () => openConversation(creator) : undefined}
          chat={chatFromScreen}
          changed={noteScreen}
          runningChanged={(count) => {
            const listed = screenSummary(kept.id);
            if (listed && (listed.running ?? 0) !== count) listed.running = count;
          }}
          deleted={screenDeleted}
        />
      </div>
    {/each}
  </main>
</div>
{#if folderBrowserOpen && !active}
  <FolderBrowser
    computerId={selectedComputer?.computerId ?? selectedComputerId}
    computerName={selectedComputer?.name ?? 'Computer'}
    environments={computerEnvironments}
    executionEnvironmentId={selectedExecutionEnvironment?.id}
    initialEnvironment={selectedLocation?.environmentId ?? selectedConnection?.environmentId}
    initialLocation={selectedLocation}
    recent={savedLocations}
    browse={listFolders}
    choose={(location) => chooseLocation(location, true)}
    close={() => (folderBrowserOpen = false)}
  />
{/if}
{#if contextOpen}<ModelContext
    running={activeRunning}
    conversationId={active?.id}
    forked={active?.forked}
    settings={selectedSettings}
    location={selectedLocation?.path ? selectedLocation : undefined}
    modelName={selectedModelName(selectedSettings.model, availableModels)}
    accountName={workspace.fleet.accounts.find((a) => a.id === selectedConnection?.accountId)
      ?.name ?? 'Existing CLI login'}
    computerName={selectedComputer?.name ?? 'This computer'}
    close={() => (contextOpen = false)}
    useSkill={(name, path) => {
      prompt = `Use the skill ${JSON.stringify(name)} at ${JSON.stringify(path)} for this request.\n\n${prompt}`;
      contextOpen = false;
      void tick().then(() =>
        document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus(),
      );
    }}
  />{/if}
{#if editorOpen}<ChatInstructions
    instructions={selectedSettings.instructions}
    outputSchema={selectedSettings.outputSchema}
    maxThinkingTokens={selectedSettings.maxThinkingTokens}
    fallbackModel={selectedSettings.fallbackModel}
    provider={selectedSettings.provider}
    close={() => (editorOpen = false)}
    save={(instructions, outputSchema, maxThinkingTokens, fallbackModel) => {
      changeSettings({
        ...selectedSettings, instructions, outputSchema, maxThinkingTokens, fallbackModel,
      });
      editorOpen = false;
    }}
  />{/if}
{#if templatesOpen && view === 'chat'}
  <InputTemplates
    templates={workspace.inputTemplates ?? []}
    draft={prompt}
    close={closeTemplates}
    save={(template, previous) => updateInputTemplate(template, previous)}
    remove={(template) => updateInputTemplate(undefined, template)}
    insert={(text) => {
      prompt = appendTemplateInput(prompt, text);
      closeTemplates();
      void tick().then(() => composerInput?.setSelectionRange(prompt.length, prompt.length));
    }}
  />
{/if}
{#if conversationMenu && menuConversation}
  {#key conversationMenu}
    <ConversationContextMenu
      x={conversationMenu.x}
      y={conversationMenu.y}
      name={menuConversation.title}
      trigger={conversationMenu.trigger}
      close={closeConversationMenu}
      remove={requestConversationDeletion}
      fork={() => menuConversation && void forkChat(menuConversation.id)}
      forkDisabled={forking || imagesLoading || forkPoint(menuConversation) < 0}
      snooze={snoozeFromMenu}
      snoozed={!!snoozeOf(menuConversation)}
      snoozeDisabled={conversationRunning(menuConversation)}
      pin={pinFromMenu}
      pinned={pinsByChat.has(menuConversation.id)}
    />
  {/key}
{:else if conversationMenu && menuScratch}
  {#key conversationMenu}
    <ConversationContextMenu
      x={conversationMenu.x}
      y={conversationMenu.y}
      name={`Unsent draft: ${menuScratch.title}`}
      trigger={conversationMenu.trigger}
      close={closeConversationMenu}
      remove={requestScratchDiscard}
      removeLabel="Discard draft"
    />
  {/key}
{/if}
{#if importOpen}
  {#key workspaceSession}
    <ImportChats
      fleet={workspace.fleet}
      close={() => (importOpen = false)}
      save={saveImported}
      open={openImported}
    />
  {/key}
{/if}
{#if historyAction && active?.id === historyAction.conversationId}
  {@const action = historyAction}
  {#key `${workspaceSession}:${active.id}:${historyAction.kind}:${historyAction.runId ?? ''}`}
    {#if historyAction.kind === 'rewind'}
      <RewindDialog
        conversation={active}
        close={() => {
          if (historyAction === action) historyAction = undefined;
        }}
        apply={(id) => changeHistory(id)}
      />
    {:else if historyAction.runId}
      {@const conversationId = active.id}
      {@const runId = historyAction.runId}
      <UndoFilesDialog
        {conversationId}
        {runId}
        connectionId={active.settings.connectionId}
        close={() => {
          if (historyAction === action) historyAction = undefined;
        }}
        prepare={() => prepareUndo(conversationId, action.session)}
        applied={() => markFilesUndone(conversationId, runId, action.session)}
      />
    {/if}
  {/key}
{/if}
{#if deletion}<div class="modal-backdrop confirmation-backdrop" role="presentation">
    <div
      class="modal small-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      tabindex="-1"
      use:focusDeletionDialog
    >
      {#if deletion.type === 'draft'}<h2 id="delete-title">Discard draft?</h2>
        <p>“{deletion.name}” will be discarded. This cannot be undone.</p>
      {:else}<h2 id="delete-title">Delete {deletion.type}?</h2>
        <p>
          “{deletion.name}” will be removed from this workspace. This cannot be undone.
        </p>{/if}
      {#if deletingConversation && conversationRunning(deletingConversation)}<p>
          Its running reply will be stopped first.
        </p>{/if}
      {#if deletionError}<p role="alert">{deletionError}</p>{/if}
      <footer>
        <button class="secondary" disabled={deleting} onclick={() => (deletion = null)}
          >Cancel</button
        ><button
          class="danger"
          disabled={(deletion.type === 'conversation' && !deletingConversation) || deleting}
          onclick={remove}
          >{deleting
            ? 'Deleting…'
            : deletion.type === 'draft'
              ? 'Discard draft'
              : `Delete ${deletion.type}`}</button
        >
      </footer>
    </div>
  </div>{/if}
  {#if shutdown.state.phase === 'counting' || shutdown.state.phase === 'shutting'}<ShutdownCountdown
      watch={shutdown}
      onerror={(message) => (notice = message)}
    />{/if}
{/if}
