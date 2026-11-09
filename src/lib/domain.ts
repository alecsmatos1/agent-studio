import { z } from 'zod';
import { fallbackModelSetting } from './claude-options.ts';
import { outputSchemaSetting } from './structured-output.ts';
import { mentionSchema, type Mention } from './mentions.ts';
import { compactionsSchema, type Compaction } from './compaction.ts';
import { accountUsageSchema, type AccountUsage } from './spend.ts';
import { emptyFleet, fleetSchema, type Fleet } from './fleet.ts';
import { toolActivitySchema, type ToolActivity } from './activity.ts';
import { imageSchema, type ChatImage } from './images.ts';
import { planSchema, type Plan } from './plans.ts';
import { proposedPlansSchema, proposedPlanHistory, type ProposedPlan } from './proposed-plans.ts';
import { visualizationsSchema, type Visualization } from './visualizations.ts';
import { artifactRecordsSchema, type ArtifactRecord } from './artifact-records.ts';
import {
  publishedArtifactsSchema,
  publishedHistory,
  type PublishedArtifact,
} from './published-artifacts.ts';
import {
  extraSentFileGroupsSchema,
  laterSentFileGroupsSchema,
  sentFileGroupsSchema,
  type SentFiles,
} from './sent-files.ts';
import { screenCardsSchema, type ScreenCard } from './screens.ts';
import { fileChangesSchema, type FileChanges } from './file-changes.ts';
import { reasoningBlockSchema } from './reasoning.ts';
import { questionsSchema, questionHistory, type QuestionRequest } from './questions.ts';
import type { QuestionDraft } from './question-drafts.ts';
import { elicitationReceiptsSchema, type ElicitationReceipt } from './elicitations.ts';
import {
  steeringSchema,
  steeringPlacesSchema,
  steeringHistory,
  type SteeringReceipt,
} from './steering.ts';
import { autoContinueSchema, usageLimitSchema, type UsageLimit } from './usage-limits.ts';
import { inputTemplatesSchema } from './input-templates.ts';
import { claudeInstructionsSchema } from './claude-instructions.ts';
import { appSessionsSchema } from './app-sessions.ts';
import { folderIconsSchema } from './folder-icons.ts';
import { accountColorsSchema } from './account-colors.ts';
import { snoozesSchema } from './snoozes.ts';
import { pinsSchema } from './pins.ts';
import { sidebarOrderSchema } from './sidebar-order.ts';
import {
  workflowSchema,
  workflowProgressSchema,
  nativeWorkflowsSchema,
  type NativeWorkflows,
  type WorkflowProgress,
} from './workflows.ts';

export const providerIds = ['codex', 'claude', 'gemini'] as const;
export type ProviderId = (typeof providerIds)[number];
export const providers = {
  codex: {
    name: 'Codex',
    company: 'OpenAI',
    account: 'ChatGPT',
    mark: 'O',
    color: '#b9ddcc',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  },
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    account: 'Claude',
    // The selector asks for the text glyph. Without it Apple's engines can draw the green emoji,
    // which would cover the color of an account's mark.
    mark: '✳\uFE0E',
    color: '#dda987',
    install: 'irm https://claude.ai/install.ps1 | iex',
    login: 'claude auth login',
  },
  gemini: {
    name: 'Gemini',
    company: 'Google',
    account: 'Google',
    mark: '✦',
    color: '#a9bff0',
    install: 'irm https://antigravity.google/cli/install.ps1 | iex',
    login: 'agy',
  },
} satisfies Record<
  ProviderId,
  {
    name: string;
    company: string;
    account: string;
    mark: string;
    color: string;
    install: string;
    login: string;
  }
>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  provider: z.enum(providerIds),
  model: z.string(),
  instructions: z.string(),
  description: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;
export const reasoningSchema = z.enum([
  '',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export type Reasoning = z.infer<typeof reasoningSchema>;
export const chatSettingsSchema = z.object({
  fastMode: z.boolean().optional(),
  fallbackModel: fallbackModelSetting.optional(),
  // Any budget; a provider that accepts less reports its own limit.
  maxThinkingTokens: z.number().int().nonnegative().optional(),
  outputSchema: outputSchemaSetting.optional(),
  planMode: z.boolean().optional(),
  autoCompactTokens: z.number().int().positive().optional(),
  connectionId: z.string().uuid().optional(),
  provider: z.enum(providerIds),
  model: z.string(),
  reasoning: reasoningSchema,
  instructions: z.string(),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const locationSchema = z.object({
  computerId: z.string().uuid(),
  environmentId: z.string().uuid(),
  // Folder ownership and CLI execution can differ for Desktop + a WSL folder.
  executionEnvironmentId: z.string().uuid().optional(),
  path: z.string(),
});
export type ChatLocation = z.infer<typeof locationSchema>;
export const preferencesSchema = z.object({
  recentLocations: z.array(locationSchema).max(30).optional(),
  connectionByProvider: z.partialRecord(z.enum(providerIds), z.string().uuid()).optional(),
  lastProvider: z.enum(providerIds),
  modelByProvider: z.partialRecord(z.enum(providerIds), z.string()),
  reasoningByProvider: z.partialRecord(z.enum(providerIds), z.record(z.string(), reasoningSchema)),
  // Every account each WSL distribution this computer manages has had, so adding its accounts
  // there never brings back one removed there (`addHostAccounts`). Kept on this device only.
  distributionAccounts: z.record(z.string().uuid(), z.array(z.string().uuid())).optional(),
  // New chats start on the account of their agent that has used the least, instead of the one
  // last chosen (`src/lib/account-balance.ts`). Off unless set, on this device only.
  balanceAccounts: z.boolean().optional(),
  // The accounts that leaves out: a new chat starts on one of them only when it is chosen.
  balanceExcluded: z.array(z.string().uuid()).optional(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
// One part of a message: reasoning, text, or a call, comment or note of the work.
export const blockSchema = z.discriminatedUnion('type', [
  reasoningBlockSchema,
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({
    type: z.literal('activity'),
    text: z.string(),
    tool: toolActivitySchema.optional(),
    progress: z.object({ id: z.string(), revision: z.number().int().nonnegative() }).optional(),
    order: z.number().int().nonnegative().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof blockSchema>;
const tokenCount = z.number().nonnegative().nullable().optional();
export const tokenUsageSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  input: tokenCount,
  output: tokenCount,
  cachedInput: tokenCount,
  reasoningOutput: tokenCount,
  contextInput: tokenCount,
  contextWindow: tokenCount,
  costUsd: z.number().nonnegative().nullable().optional(),
  scope: z.enum(['session', 'reply']).optional(),
  sessionCredits: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  sessionCostUsd: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  model: z.string().nullable().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export const skillReferenceSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_:.-]+$/),
  path: z
    .string()
    .min(1)
    .refine((path) => !/[\u0000-\u001f]/.test(path)),
});
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export const messageSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant']),
    blocks: z.array(blockSchema),
    images: z.array(imageSchema).optional(),
    skills: z.array(skillReferenceSchema).optional(),
    mentions: z.array(mentionSchema).optional(),
    status: z.enum(['complete', 'running', 'error', 'cancelled']),
    createdAt: z.string(),
    error: z.string().optional(),
    usage: tokenUsageSchema.optional(),
    accountUsage: accountUsageSchema.optional(),
    promptTokensEstimate: z.number().nonnegative().optional(),
    durationMs: z.number().optional(),
    settings: chatSettingsSchema.optional(),
    modelName: z.string().optional(),
    authorName: z.string().optional(),
    executionLabel: z.string().optional(),
    runId: z.string().uuid().optional(),
    plan: planSchema.optional(),
    proposedPlans: proposedPlansSchema.optional(),
    visualizations: visualizationsSchema.optional(),
    // The artifact pages the reply showed with its show_artifact tool, with their source.
    artifacts: artifactRecordsSchema.optional(),
    // The claude.ai artifacts the reply published or opened, which their cards open beside the
    // chat in the account's own claude.ai session on Windows, and in the browser elsewhere.
    publishedArtifacts: publishedArtifactsSchema.optional(),
    sentFiles: sentFileGroupsSchema.optional(),
    // Groups showing a table, a document or a video, which releases before them cannot read:
    // apart from sentFiles, which those releases validate strictly, so they drop these alone.
    extraSentFiles: extraSentFileGroupsSchema.optional(),
    // Groups showing audio, or any kind a later release adds, apart from extraSentFiles for the
    // same reason; this field takes every kind, so no later one makes a release refuse it.
    laterSentFiles: laterSentFileGroupsSchema.optional(),
    // The screens the reply saved, which their cards open from the computer that keeps them.
    screens: screenCardsSchema.optional(),
    questions: questionsSchema.optional(),
    elicitations: elicitationReceiptsSchema.optional(),
    steering: steeringSchema.optional(),
    // Where each of those steers arrived among the reply's work, which divides there.
    steeringPlaces: steeringPlacesSchema.optional(),
    compact: z.boolean().optional(),
    compactions: compactionsSchema.optional(),
    fileChanges: fileChangesSchema.optional(),
    filesUndone: z.boolean().optional(),
    workflow: workflowProgressSchema.optional(),
    workflowDefinition: workflowSchema.optional(),
    nativeWorkflows: nativeWorkflowsSchema.optional(),
    // A running Claude reply whose turn ended while background work it waits for continues:
    // the number of that idle stretch, in which the next message takes the reply over.
    backgroundWait: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    // The reply this one took over, by id: it goes on waiting for that reply's sub-agents, whose
    // records stay with that reply.
    tookOver: z.string().uuid().optional(),
    // The usage limit that stopped the reply, in the provider's words; never replayed.
    usageLimit: usageLimitSchema.optional(),
    // When the chat goes on by itself once that limit resets, or that it no longer will.
    autoContinue: autoContinueSchema.optional(),
    // A message the user did not write: a workflow's, such as a mission's update, or the one
    // Agent Studio sends once a usage limit that stopped the chat resets (`limit`).
    sentBy: z.enum(['workflow', 'limit']).optional(),
  })
  .refine(
    (message) =>
      !message.accountUsage ||
      (message.role === 'assistant' && message.accountUsage.runId === message.runId),
    { message: 'Account observation does not match its response run' },
  )
  .refine(
    (message) =>
      !message.steering?.length ||
      (message.role === 'assistant' && message.steering.every((s) => s.runId === message.runId)),
    { message: 'Steering does not match its response run' },
  )
  .refine(
    (message) =>
      !message.elicitations?.length ||
      (message.role === 'assistant' &&
        message.elicitations.every((e) => e.runId === message.runId)),
    { message: 'MCP input does not match its response run' },
  )
  .refine(
    (message) =>
      !message.sentFiles?.length ||
      (message.role === 'assistant' &&
        message.sentFiles.every((group) => group.runId === message.runId)),
    { message: 'Shown files do not match their response run' },
  )
  .refine(
    (message) =>
      !message.extraSentFiles?.length ||
      (message.role === 'assistant' &&
        message.extraSentFiles.every((group) => group.runId === message.runId)),
    { message: 'Shown files do not match their response run' },
  )
  .refine(
    (message) =>
      !message.laterSentFiles?.length ||
      (message.role === 'assistant' &&
        message.laterSentFiles.every((group) => group.runId === message.runId)),
    { message: 'Shown files do not match their response run' },
  );
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  id: z.string().uuid(),
  // A portable history copy starts a new Standalone folder even with prior messages.
  forked: z.literal(true).optional(),
  // The chats it was copied from, nearest first, whose native sessions its first reply forks.
  forkedFrom: z.array(z.string().uuid()).optional(),
  location: locationSchema.optional(),
  archived: z.boolean().optional(),
  settings: chatSettingsSchema,
  title: z.string(),
  titleStatus: z.enum(['pending', 'generated', 'fallback']).optional(),
  titleSource: z.object({ provider: z.enum(providerIds), model: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
  historyRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  rewind: z
    .object({
      removed: z.array(messageSchema).min(1),
      createdAt: z.string(),
    })
    .optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const workspaceSchema = z.object({
  version: z.literal(3),
  fleet: fleetSchema,
  preferences: preferencesSchema,
  legacyAgents: z.array(agentSchema).optional(),
  conversations: z.array(conversationSchema),
  workflows: z.array(workflowSchema).optional(),
  inputTemplates: inputTemplatesSchema.optional(),
  claudeInstructions: claudeInstructionsSchema.optional(),
  // Starts of the desktop app, which History groups chats by.
  appSessions: appSessionsSchema.optional(),
  // The icon a model chose for each project folder.
  folderIcons: folderIconsSchema.optional(),
  // The color that marks each account wherever it is named.
  accountColors: accountColorsSchema.optional(),
  // Chats snoozed until the desktop app starts again.
  snoozes: snoozesSchema.optional(),
  // Chats pinned to the top of the Active or History tab they are in.
  pins: pinsSchema.optional(),
  // The order the reader gave the sidebar's chats, folders and computers.
  sidebarOrder: sidebarOrderSchema.optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type ProviderStatus = {
  id: ProviderId;
  installed: boolean;
  version: string | null;
  auth: 'ready' | 'login' | 'unknown';
  detail: string;
  location?: string | null;
  // Signed-in identity reported by the CLI itself (Claude's account email); session-only metadata.
  account?: string | null;
  // The check itself failed, as its detail says, so installation and sign-in are unknown.
  checkFailed?: boolean;
  // Why a separate Claude profile is not sharing this computer's Claude directory yet.
  sharing?: string | null;
  // Windows' one-time permission would let it share settings.json and CLAUDE.md too.
  sharingPermission?: boolean;
};
export type RunEvent = TokenUsage & {
  kind:
    | 'skillschanged'
    | 'text'
    | 'activity'
    | 'usage'
    | 'accountusage'
    | 'error'
    | 'tool'
    | 'progress'
    | 'reasoning'
    | 'plan'
    | 'proposedplan'
    | 'filechanges'
    | 'visualization'
    | 'artifact'
    | 'publishedartifact'
    | 'sentfiles'
    | 'screen'
    | 'question'
    | 'questiondraft'
    | 'elicitation'
    | 'steering'
    | 'compaction'
    | 'workflow'
    | 'nativeworkflow'
    | 'backgroundwait'
    | 'takeover'
    | 'usagelimit';
  id?: string;
  accountUsage?: AccountUsage;
  revision?: number;
  // The idle stretch a Claude reply waits in for background work, or null once a turn started.
  wait?: number | null;
  text?: string;
  truncated?: boolean;
  tool?: ToolActivity;
  plan?: Plan;
  proposedPlan?: ProposedPlan;
  visualization?: Visualization;
  artifact?: ArtifactRecord;
  publishedArtifact?: PublishedArtifact;
  // A claude.ai artifact the reply created or opened, which the window that runs it opens.
  open?: boolean;
  sentFiles?: SentFiles;
  screen?: ScreenCard;
  question?: QuestionRequest;
  // The call whose draft a recorded question replaces.
  draft?: string;
  questionDraft?: QuestionDraft;
  elicitation?: ElicitationReceipt;
  steering?: SteeringReceipt;
  // When the reply's computer confirmed that steer.
  at?: string;
  compaction?: Compaction;
  fileChanges?: FileChanges;
  workflow?: WorkflowProgress;
  nativeWorkflows?: NativeWorkflows;
  usageLimit?: UsageLimit;
};
export type RunRequest = {
  compact?: boolean;
  location?: ChatLocation;
  conversationId?: string;
  historyRevision?: number;
  assistantId?: string;
  runId: string;
  // An earlier reply in this conversation used another account of the same agent. The
  // host starts a fresh native session for the selected account from the saved messages.
  accountSwitch?: boolean;
  forked?: boolean;
  forkedFrom?: string[];
  // The reply this message follows, the end of which a rewound chat or a new fork continues from
  // in a fork of the native session that holds it.
  lastReply?: { runId: string; steering?: string[] };
  // A rewind came before this message, which the history alone cannot tell when the same message
  // is sent again.
  rewound?: boolean;
  agent: ChatSettings;
  // Workspace-wide Claude chat instructions, appended to the CLI's system prompt.
  claudeInstructions?: string;
  // The mission this conversation orchestrates (docs/WORKFLOWS.md), which gives it the mission
  // tools; part of the parked process's identity.
  mission?: { runId: string; role: 'orchestrator' };
  // A message sent while the conversation's Claude reply only waits for background work: that
  // reply hands this one its process and ends. `messages` are the user message and the reply
  // placeholder the conversation gains once the host confirms, on the executing host as well.
  takeOver?: { runId: string; wait: number; messages: Message[] };
  messages: {
    role: 'user' | 'assistant';
    text: string;
    images?: ChatImage[];
    skills?: SkillReference[];
    mentions?: Mention[];
    visualizations?: Visualization[];
    artifacts?: ArtifactRecord[];
  }[];
};

export function initialWorkspace(): Workspace {
  return {
    version: 3,
    fleet: emptyFleet(),
    preferences: { lastProvider: 'codex', modelByProvider: {}, reasoningByProvider: {} },
    conversations: [],
  };
}
export const messageText = (message: Message) =>
  message.blocks
    .filter((b) => b.type === 'markdown')
    .map((b) => b.text)
    .join('\n\n');
/** What a file Undo adds to a reply's saved text, which the host recognizes in a binding's history. */
export const filesUndoneMark =
  '\n\n[The user undid this response’s recorded file edits after the response. Check the current files before continuing.]';
export function historyFor(conversation: Conversation): RunRequest['messages'] {
  // Interrupted and failed responses never become fabricated assistant history.
  return conversation.messages
    .filter(
      (m) =>
        m.role === 'user' ||
        m.status === 'complete' ||
        questionHistory(m.questions) ||
        m.steering?.length,
    )
    .map((m) => ({
      role: m.role === 'assistant' && m.status !== 'complete' ? ('user' as const) : m.role,
      text:
        (m.role === 'assistant' && m.status !== 'complete' ? '' : messageText(m)) +
        (m.filesUndone ? filesUndoneMark : '') +
        (m.role === 'assistant'
          ? questionHistory(m.questions) +
            steeringHistory(m.steering) +
            (m.status === 'complete'
              ? proposedPlanHistory(m.proposedPlans) + publishedHistory(m.publishedArtifacts)
              : '')
          : ''),
      ...(m.role === 'user' && m.images?.length ? { images: m.images } : {}),
      ...(m.role === 'user' && m.skills?.length ? { skills: m.skills } : {}),
      ...(m.role === 'user' && m.mentions?.length ? { mentions: m.mentions } : {}),
      ...(m.role === 'assistant' && m.status === 'complete' && m.visualizations?.length
        ? { visualizations: m.visualizations }
        : {}),
      ...(m.role === 'assistant' && m.status === 'complete' && m.artifacts?.length
        ? { artifacts: m.artifacts }
        : {}),
    }))
    .filter(
      (m) => m.text.trim() || m.images?.length || m.visualizations?.length || m.artifacts?.length,
    );
}
/** The conversation's latest reply as a run request names it (`lastReply`). */
export function lastReplyOf(conversation: Pick<Conversation, 'messages'>) {
  const reply = conversation.messages.findLast((m) => m.role === 'assistant' && m.runId);
  if (!reply?.runId) return undefined;
  const steering = reply.steering?.map((input) => input.id) ?? [];
  return { runId: reply.runId, ...(steering.length ? { steering } : {}) };
}
// Loading a saved workspace cannot regain a run that was live when the app stopped.
export const interruptedReplyError = 'This response was interrupted when the app closed.';
/** A conflict copy's reply, whose run went on in the chat it was copied from. */
export const copiedReplyError = 'This response went on in the original chat.';
/** A reply saved as running that its computer holds no run for, which nothing else would end. */
export const abandonedReplyError = 'This response is no longer running.';
/**
 * Whether a reply ended without an end of its own: a conflict copy's, or one its computer found it
 * no longer runs. Each is the record catching up, never news, so neither alerts anyone.
 */
export const endedWithoutRun = (message: Pick<Message, 'error'>) =>
  message.error === copiedReplyError || message.error === abandonedReplyError;
/**
 * A saved workspace, migrated and validated. Replies saved as running were interrupted with the
 * app, unless `followsRuns`: the Viewer runs none, so its reload stops nothing, and it keeps
 * following each one as its computer reports it.
 */
/**
 * A saved workspace, ready to use. Replies saved as running stopped with the app that ran them,
 * so they read as interrupted, unless this device follows runs other computers report (the
 * Viewer), or names the replies that stopped (`runsHere`: a server's restart leaves the replies
 * of other computers running, and a reload of the window those its computer still runs).
 */
export function restoreWorkspace(
  value: unknown,
  {
    followsRuns = false,
    runsHere,
  }: {
    followsRuns?: boolean;
    runsHere?: (conversation: Conversation, message: Message, fleet: Fleet) => boolean;
  } = {},
): Workspace {
  const oldSchema = z.object({
    version: z.literal(1),
    agents: z.array(agentSchema).min(1),
    conversations: z.array(
      conversationSchema.omit({ settings: true }).extend({ agent: agentSchema }),
    ),
  });
  let data: Workspace;
  if ((value as { version?: number } | null)?.version === 1) {
    const old = oldSchema.parse(value);
    data = initialWorkspace();
    data.legacyAgents = old.agents;
    data.conversations = old.conversations.map(({ agent, ...conversation }) => {
      const settings = migrateSettings(agent);
      return {
        ...conversation,
        settings,
        messages: conversation.messages.map((message) => ({
          ...message,
          ...(message.role === 'assistant'
            ? { settings: { ...settings }, authorName: agent.name }
            : {}),
        })),
      };
    });
    const remember = (settings: ChatSettings) => {
      rememberSettings(data.preferences, settings);
      rememberAgent(data.preferences, settings);
    };
    for (const agent of old.agents) remember(migrateSettings(agent));
    for (const conversation of [...data.conversations].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    ))
      remember(conversation.settings);
  } else if ((value as { version?: number } | null)?.version === 2) {
    const old = workspaceSchema
      .omit({ version: true, fleet: true })
      .extend({ version: z.literal(2) })
      .parse(value);
    data = workspaceSchema.parse({ ...old, version: 3, fleet: emptyFleet() });
  } else data = workspaceSchema.parse(value);
  for (const c of data.conversations) {
    if (c.titleStatus === 'pending') c.titleStatus = 'fallback';
    if (!followsRuns)
      for (const m of c.messages)
        if (m.status === 'running' && (!runsHere || runsHere(c, m, data.fleet))) {
          m.status = 'cancelled';
          m.error = interruptedReplyError;
          delete m.backgroundWait;
        }
  }
  return data;
}

function migrateSettings(agent: Agent): ChatSettings {
  let model = agent.model;
  let reasoning: Reasoning = '';
  if (agent.provider === 'gemini') {
    const match = model.match(/^(gemini-.+)-(low|medium|high)$/);
    model = match?.[1] ?? (model || 'gemini-3.8-flash');
    reasoning = (match?.[2] as Reasoning) ?? (model.includes('-pro') ? 'high' : 'medium');
  }
  return { provider: agent.provider, model, reasoning, instructions: agent.instructions };
}

// The model per provider and the reasoning per provider and model, from any chat's settings.
export function rememberSettings(preferences: Preferences, settings: ChatSettings) {
  preferences.modelByProvider[settings.provider] = settings.model;
  preferences.reasoningByProvider[settings.provider] = {
    ...preferences.reasoningByProvider[settings.provider],
    [settings.model]: settings.reasoning,
  };
}
// The agent and account the user last chose, which new chats start with. Replies and other
// settings of existing chats never replace it; a choice without an account keeps the one
// remembered for that agent.
export function rememberAgent(
  preferences: Preferences,
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
) {
  preferences.lastProvider = settings.provider;
  if (settings.connectionId)
    preferences.connectionByProvider = {
      ...preferences.connectionByProvider,
      [settings.provider]: settings.connectionId,
    };
}

export function settingsFor(
  preferences: Preferences,
  provider = preferences.lastProvider,
): ChatSettings {
  const model =
    preferences.modelByProvider[provider] ?? (provider === 'gemini' ? 'gemini-3.8-flash' : '');
  return {
    ...(preferences.connectionByProvider?.[provider]
      ? { connectionId: preferences.connectionByProvider[provider] }
      : {}),
    provider,
    model,
    reasoning:
      preferences.reasoningByProvider[provider]?.[model] ?? (provider === 'gemini' ? 'medium' : ''),
    instructions: '',
  };
}
