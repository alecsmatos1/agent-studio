<script lang="ts">
  import {
    RotateCcw,
    CircleAlert,
    ArrowRightLeft,
    GitFork,
    Rewind,
    Undo2,
    LoaderCircle,
    Hourglass,
    MessageCircleQuestionMark,
    LayoutDashboard,
    AppWindow,
    ExternalLink,
    ShipWheel,
    TimerReset,
    Workflow,
  } from '@lucide/svelte';
  import { messageText, providers, type Message, type ChatSettings } from '$lib/domain';
  import { awaitingAnswer } from '$lib/questions';
  import { recall } from '$lib/chat-recall';
  import { draftRequest, shownQuestionDrafts, type QuestionDraft } from '$lib/question-drafts';
  import { replyContent, highlightCode } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import {
    replyModelMismatch,
    replyModelName,
    switchedTo,
    type ReplyTimeTotal,
  } from '$lib/replies';
  import { replyUsageLimit, savedLimitComment } from '$lib/usage-limits';
  import { continueLabel } from '$lib/auto-continue';
  import { clock as ticks } from '$lib/clock';
  import { modelMark } from '$lib/model-marks';
  import ModelMark from './ModelMark.svelte';
  import { separateMemory, summarizeFileChanges, type SeparatedChanges } from '$lib/file-changes';
  import ToolActivity from './ToolActivity.svelte';
  import { closingComment, replyParts } from '$lib/activity-groups';
  import { placedSteering } from '$lib/steering';
  import { compactionLabel, compactionTokens } from '$lib/compaction';
  import ReplyFooter from './ReplyFooter.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  import type { BackgroundRun } from '$lib/background-work';
  import { replyTools, runningSubagents, type RunningSubagent } from '$lib/subagents';
  import VisualizationView from './VisualizationView.svelte';
  import SentFilesView from './SentFilesView.svelte';
  import { messageFiles } from '$lib/sent-files';
  import QuestionForm from './QuestionForm.svelte';
  import PlanApproval from './PlanApproval.svelte';
  import ProposedPlan from './ProposedPlan.svelte';
  import ElicitationForm from './ElicitationForm.svelte';
  import { artifactKey, messageArtifacts, recordArtifact, type Artifact } from '$lib/artifacts';
  import type { ScreenCard } from '$lib/screens';
  import type { PublishedArtifact } from '$lib/published-artifacts';
  let {
    message,
    questionDrafts,
    agent,
    retry,
    rewind,
    undoEdits,
    historyDisabled = false,
    canRetry = false,
    retryDisabled = false,
    switchNotice = '',
    switchColor,
    timeTotal,
    chatChanges,
    folder,
    openArtifact,
    fork,
    forkDisabled = false,
    background = [],
    inherited,
    carried = false,
    openSubagent,
    openedSubagent,
    idle = false,
    switchAccount,
    continuation,
    openScreen,
    openPage,
  }: {
    message: Message;
    /** Questions Claude is still writing in this reply, which this window heard. */
    questionDrafts?: QuestionDraft[];
    agent: ChatSettings;
    retry: () => void;
    rewind?: () => void;
    undoEdits?: () => void;
    historyDisabled?: boolean;
    canRetry?: boolean;
    retryDisabled?: boolean;
    switchNotice?: string;
    /** The color of the account this reply switched to, which the notice names first. */
    switchColor?: string;
    timeTotal?: ReplyTimeTotal;
    chatChanges?: SeparatedChanges;
    folder?: string;
    openArtifact: (artifact: Artifact, mode?: 'modal' | 'panel') => void;
    fork?: () => void;
    forkDisabled?: boolean;
    /** Background work this reply started that still runs. */
    background?: BackgroundRun[];
    /** Sub-agents of replies this one took over, which it waits for while they run. */
    inherited?: RunningSubagent[];
    /** A later reply that took this one over runs, and waits for its sub-agents. */
    carried?: boolean;
    /** Opens a sub-agent in the side panel: one of this reply's, or of the reply named. */
    openSubagent?: (agentId: string, messageId?: string) => void;
    /** The sub-agent whose conversation the side panel shows, and the reply that holds it. */
    openedSubagent?: { messageId: string; agentId: string };
    /** It runs, but its turn ended and it only waits for background work. */
    idle?: boolean;
    /** Opens the Agent picker to choose another account for the next message. */
    switchAccount?: () => void;
    /**
     * The chat goes on by itself once the usage limit that stopped this reply resets: when, and
     * what cancels it.
     */
    continuation?: { at: string; cancel?: () => void };
    /** Opens a screen this reply saved, from the computer that keeps it. */
    openScreen?: (card: ScreenCard) => void;
    /** Opens a claude.ai artifact inside the window; without it, the browser opens it. */
    openPage?: (artifact: PublishedArtifact) => void;
  } = $props();
  const responseChanges = $derived(separateMemory(summarizeFileChanges([message])));
  const allChanges = $derived(chatChanges ?? responseChanges);
  // A usage limit that stopped the reply: its Work history stays open, and a card of its own
  // follows it instead of the provider's line standing in for the answer.
  const limit = $derived(replyUsageLimit(message));
  // Replies saved before 2026-09-30 kept that line among their progress comments.
  const blocks = $derived(
    limit && !message.usageLimit
      ? message.blocks.filter((block) => !savedLimitComment(block))
      : message.blocks,
  );
  let linkError = $state('');
  // What the reader opened in the message, as its chat recalls it (`src/lib/chat-recall.ts`).
  const remembered = recall(() => message.id);
  const author = $derived(message.settings ?? agent);
  // The model that ran, as the picker shows it: its version on its family's tint.
  const mark = $derived(modelMark(author.provider, replyModelName(message)));
  const mismatch = $derived(message.role === 'assistant' ? replyModelMismatch(message) : undefined);
  // What the user sent while the reply ran, with where each arrived in its work.
  const steers = $derived(placedSteering(message.steering, message.steeringPlaces));
  const text = $derived(
    messageText(message) ||
      (message.status !== 'running' &&
      !limit &&
      !message.proposedPlans?.length &&
      !message.settings?.outputSchema
        ? closingComment(message.blocks, steers)
        : ''),
  );
  const tools = $derived(replyTools(message));
  // A /compact reply is its compaction; any other reply's are entries of its work.
  const parts = $derived(
    replyParts(blocks, tools, text, message.compact ? undefined : message.compactions, steers),
  );
  // A steer nothing has followed yet: the reply is about to go on from it.
  const steered = $derived(parts.length > 1 && !parts.at(-1)!.entries.length);
  // The first part that shows, which opens the reply.
  const opening = $derived(
    parts.findIndex((part, index) => index === parts.length - 1 || part.entries.length > 0),
  );
  const clock = (time?: string) => {
    const date = time ? new Date(time) : undefined;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
  };
  const sent = $derived(clock(message.createdAt));
  // What was written a moment ago fades in: a message just sent, the reply it starts, a steer
  // the reply just took. What a chat already holds when it opens shows at once, and so does a
  // message from a computer whose clock is far from this one's.
  const fresh = (time?: string) => {
    const age = time ? Date.now() - Date.parse(time) : NaN;
    return Math.abs(age) < 1500;
  };
  // A message a workflow wrote: an update's first event, without the chat ids written for the
  // orchestrator, and how many more it lists (one a line, before the agents' replies), or else
  // its first line of substance. Updates written before 2026-10-19 begin [Mission update].
  const update = $derived.by(() => {
    if (message.sentBy !== 'workflow') return '';
    const lines = text.split('\n');
    const heading = (line: string) => /^\[(Workflow|Mission) update\]$/.test(line.trim());
    const start = lines.findIndex(heading);
    const events: string[] = [];
    for (const line of start < 0 ? [] : lines.slice(start + 1)) {
      if (!line.startsWith('- ')) break;
      events.push(line);
    }
    const first = (
      events[0] ??
      lines.find((line) => line.trim() && !heading(line)) ??
      ''
    )
      .replace(/^[-#\s]+/, '')
      .replace(/\s*\([0-9a-f]{8}-[0-9a-f-]{27}\)/gi, '')
      .trim();
    return events.length > 1 ? `${first} · ${events.length - 1} more` : first;
  });
  // Its own sub-agents still running, then those of the replies it took over that it waits for.
  const subagents = $derived.by(() => {
    const own = runningSubagents(tools, message.status);
    return inherited?.length ? [...own, ...inherited] : own;
  });
  // This reply's sub-agent the side panel shows, which its rows mark.
  const opened = $derived(
    openedSubagent?.messageId === message.id ? openedSubagent.agentId : undefined,
  );
  // Shown where the question will be, so it appears as Claude writes it.
  const drafts = $derived(
    message.status === 'running' && questionDrafts?.length
      ? shownQuestionDrafts(questionDrafts, tools)
      : [],
  );
  // Their calls' live rows say the question is being written; this changes as a draft starts
  // or ends, not with each streamed word.
  const writingIds = $derived(drafts.map((draft) => `claude:${draft.id}`).join('\n'));
  const writing = $derived(new Set(writingIds ? writingIds.split('\n') : []));
  const structured = $derived(!!message.settings?.outputSchema && !message.compact);
  // A structured reply's text is its JSON, shown whole above; its visuals and files follow it.
  // The answer shows its artifacts as cards in place of their code, and one it is still writing
  // as the card it becomes.
  const content = $derived(
    replyContent(
      structured ? '' : text,
      message.visualizations,
      messageFiles(message),
      message.status === 'running',
      message.artifacts,
    ),
  );
  // The artifacts the answer does not show: html and svg blocks it shows as code, and those of
  // the reply's earlier comments, which a short closing status can follow.
  const artifacts = $derived(
    messageArtifacts(message).filter((artifact) => !content.cards.has(artifactKey(artifact))),
  );
  const jsonHighlight = $derived(structured ? highlightCode(text, 'json') : null);
  const waiting = $derived(awaitingAnswer(message));
  function linkClick(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      void openLink(link.href).catch(() => (linkError = 'Could not open this link.'));
    }
  }
</script>

{#snippet liveLabel()}
  <span
    class="live-label"
    class:waiting
    class:idle={!waiting && idle}
    title={!waiting && idle ? 'A message sent now goes at once.' : undefined}
    >{#if waiting}<MessageCircleQuestionMark size={13} aria-hidden="true" />Waiting for you{:else if idle}<Hourglass
        size={13}
        aria-hidden="true"
      />Waiting for background work{:else}<LoaderCircle
        size={13}
        class="spinning"
        aria-hidden="true"
      />{message.compact || message.compactions?.at(-1)?.status === 'running'
        ? 'Compacting context'
        : 'Responding'}{/if}</span
  >
{/snippet}

<!-- What a reply shows after its work: its answer and everything that came with it. -->
{#snippet outcome()}
  <!-- A /compact reply is its compaction; any other reply's are entries of its work above. -->
  {#if message.compact && message.compactions?.length}
    <div class="compaction-history" aria-label="Context compaction">
      {#each message.compactions as item (item.id)}
        {@const sizes = compactionTokens(item)}
        <p role="status">
          {compactionLabel(item, message.status)}{#if sizes}<span>{` · ${sizes}`}</span>{/if}
        </p>
      {/each}
    </div>
  {/if}
  {#if structured && text}
    <div class="prose" aria-label="Structured output">
      <pre><code class="hljs language-json">{#if jsonHighlight}{@html jsonHighlight.html}{:else}{text}{/if}</code></pre>
    </div>
  {/if}
  {#each content.parts as part (part.key)}
    {#if part.type === 'visual'}
      <VisualizationView visual={part.visual} messageId={message.id} {openArtifact} />
    {:else if part.type === 'artifact'}
      <!-- A page the reply showed with its show_artifact tool, as a card like a fence's. -->
      {@const artifact = recordArtifact(message.id, part.artifact)}
      <div class="artifact-card artifact-placed">
        <button class="secondary artifact-open" onclick={() => openArtifact(artifact, 'modal')}
          ><span>{artifact.title}</span><small>Open {artifact.language.toUpperCase()}</small></button
        ><button
          class="secondary artifact-side"
          aria-label={`Open ${artifact.title} in side panel`}
          title="Open in side panel"
          onclick={() => openArtifact(artifact, 'panel')}
        ></button>
      </div>
    {:else if part.type === 'files'}
      <SentFilesView groups={part.groups} connectionId={author.connectionId} />
    {:else}
      <!-- Links are handled at this boundary; sanitized output is restricted to presentation tags. -->
      <!-- Nested anchors provide keyboard behavior; their click events bubble here. -->
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="prose" onclick={linkClick}>{@html part.html}</div>
    {/if}
  {/each}
  {#each message.questions ?? [] as request (request.id)}
    {#if request.planApproval}
      <PlanApproval
        {request}
        runId={message.runId}
        connectionId={author.connectionId}
        running={message.status === 'running'}
      />
    {:else}
      <QuestionForm
        {request}
        runId={message.runId}
        connectionId={author.connectionId}
        running={message.status === 'running'}
      />
    {/if}
  {/each}
  {#each drafts as draft (draft.id)}
    <QuestionForm request={draftRequest(draft)} runId={message.runId} running writing />
  {/each}
  {#each message.proposedPlans ?? [] as proposal (proposal.id)}
    <ProposedPlan
      text={proposal.text}
      complete={proposal.complete}
      truncated={proposal.truncated}
      running={message.status === 'running'}
    />
  {/each}
  {#each message.elicitations ?? [] as receipt (receipt.id)}
    <ElicitationForm
      {receipt}
      runId={message.runId}
      connectionId={author.connectionId}
      running={message.status === 'running'}
    />
  {/each}
  {#if !content.parts.length && !(structured && text) && message.status === 'running' && (!message.blocks.length || steered) && !drafts.length}<div
      class="reply-waiting"
    >
      <span></span><span></span><span></span>
    </div>{/if}
  {#if limit}<div class="usage-limit" role="status">
      <div class="usage-limit-line">
        <Hourglass size={15} aria-hidden="true" />
        <div class="usage-limit-text">
          <p>{limit.text}</p>
          {#if continuation}<p class="usage-limit-continue">
              <span>{continueLabel(continuation.at, ticks.now)}</span>{#if continuation.cancel}<button
                  type="button"
                  class="text-button"
                  aria-label="Cancel continuing"
                  onclick={continuation.cancel}>Cancel</button
                >{/if}
            </p>{/if}
        </div>
      </div>
      {#if switchAccount}<button type="button" class="secondary" onclick={switchAccount}
          ><ArrowRightLeft size={14} aria-hidden="true" />Switch account</button
        >{/if}
    </div>
  {:else if message.error}<div class="message-error" role="status">
      <CircleAlert size={15} />{message.error}
    </div>{/if}
  {#if message.status === 'cancelled' && !message.error}<p class="muted small">
      Response stopped.
    </p>{/if}
  {#if artifacts.length || message.screens?.length || message.publishedArtifacts?.length}<div
      class="response-extras"
    >
      {#if message.publishedArtifacts?.length}<div
          class="response-screens"
          aria-label="Artifacts on claude.ai"
        >
          <!-- Claude Code published or opened these on claude.ai: they open beside the chat, in
               the window's own claude.ai session, or else in the browser. -->
          {#each message.publishedArtifacts as card (card.id)}{#if openPage}<div class="published-card">
                <button class="secondary screen-open" onclick={() => openPage(card)}
                  ><AppWindow size={16} aria-hidden="true" /><span>{card.title}</span><small
                    >claude.ai</small
                  ></button
                ><button
                  class="secondary published-browser"
                  aria-label={`Open ${card.title} in browser`}
                  title="Open in browser"
                  onclick={() =>
                    void openLink(card.url).catch(() => (linkError = 'Could not open this link.'))}
                  ><ExternalLink size={15} aria-hidden="true" /></button
                >
              </div>{:else}<button
                class="secondary screen-open"
                onclick={() =>
                  void openLink(card.url).catch(() => (linkError = 'Could not open this link.'))}
                ><AppWindow size={16} aria-hidden="true" /><span>{card.title}</span><small
                  >Open on claude.ai</small
                ></button
              >{/if}{/each}
        </div>{/if}
      {#if message.screens?.length}<div class="response-screens" aria-label="Saved screens">
          {#each message.screens as card (card.id)}<button
              class="secondary screen-open"
              disabled={!openScreen}
              title={openScreen ? `Open ${card.title}` : undefined}
              onclick={() => openScreen?.(card)}
              ><LayoutDashboard size={16} aria-hidden="true" /><span>{card.title}</span><small
                >Open screen</small
              ></button
            >{/each}
        </div>{/if}
      {#if artifacts.length}<div class="response-artifacts" aria-label="Response artifacts">
          <!-- The cards an answer shows in place of an artifact's code look the same (styles.css). -->
          {#each artifacts as artifact (artifact.id)}<div class="artifact-card">
              <button class="secondary artifact-open" onclick={() => openArtifact(artifact, 'modal')}
                ><span>{artifact.title}</span><small>Open {artifact.language.toUpperCase()}</small
                ></button
              ><button
                class="secondary artifact-side"
                aria-label={`Open ${artifact.title} in side panel`}
                title="Open in side panel"
                onclick={() => openArtifact(artifact, 'panel')}
              ></button>
            </div>{/each}
        </div>{/if}
    </div>{/if}
  <!-- Elapsed time, then plan, workflow, sub-agent and background work toggles in the same row. -->
  <ReplyFooter
    {message}
    {timeTotal}
    responseChanges={responseChanges.files}
    chatChanges={allChanges.files}
    responseMemory={responseChanges.memory}
    chatMemory={allChanges.memory}
    {folder}
    {background}
    {subagents}
    {openSubagent}
    {openedSubagent}
    scope={message.id}
  />
  {#if message.status !== 'running' && (fork || (canRetry && !message.workflowDefinition) || linkError || undoEdits || message.filesUndone)}<div
      class="message-actions"
    >
      {#if linkError}<span role="alert">{linkError}</span>{/if}
      {#if message.filesUndone}<span class="muted">File edits undone</span>
      {:else if undoEdits}<button class="text-button" disabled={historyDisabled} onclick={undoEdits}
          ><Undo2 size={13} />Undo edits</button
        >{/if}
      {#if fork}<button
          class="text-button"
          onclick={fork}
          disabled={forkDisabled}
          title="Start a separate chat through this reply"
          ><GitFork size={13} />Fork from here</button
        >{/if}
      {#if canRetry && !message.workflowDefinition}<button
          class="text-button"
          onclick={retry}
          disabled={retryDisabled}><RotateCcw size={13} />Retry</button
        >{/if}
    </div>{/if}
{/snippet}

<article
  class="message"
  class:user={message.role === 'user' && message.sentBy !== 'limit'}
  class:continued={message.sentBy === 'limit'}
  class:entering={fresh(message.createdAt)}
  data-testid="message"
  data-message-id={message.id}
  data-status={message.status}
>
  {#if switchNotice && message.role === 'assistant'}
    <p class="reply-switch" role="status">
      <ArrowRightLeft
        size={13}
        aria-hidden="true"
      />{#if switchColor && switchNotice.startsWith(switchedTo)}<span
          >{switchedTo}<span
            class="account-dot"
            style:--account-color={switchColor}
            aria-hidden="true"
          ></span>{switchNotice.slice(switchedTo.length)}</span
        >{:else}{switchNotice}{/if}
    </p>
  {/if}
  {#if message.role === 'user' && message.sentBy === 'limit'}
    <!-- The message Agent Studio sent once the usage limit that stopped the chat reset. -->
    <p class="reply-switch">
      <TimerReset size={13} aria-hidden="true" />Continued after the usage limit reset
    </p>
  {:else if message.role === 'user' && message.sentBy === 'workflow'}
    <div class="message-avatar workflow-avatar"><Workflow size={15} aria-hidden="true" /></div>
    <div class="message-content">
      <div class="message-heading">
        <strong>Workflow</strong>{#if sent}<span>{sent}</span>{/if}
      </div>
      <details
        class="workflow-update"
        open={remembered.get<boolean>('update')}
        ontoggle={(event) => remembered.set('update', event.currentTarget.open || undefined)}
      >
        <summary title={update}>{update || 'Update'}</summary>
        <div class="user-text">{text}</div>
      </details>
    </div>
  {:else if message.role === 'user'}
    <div class="message-avatar" style:--provider-color={providers[author.provider].color}>Y</div>
    <div class="message-content">
      <div class="message-heading">
        <strong>You</strong>{#if sent}<span>{sent}</span>{/if}
      </div>
      {#if message.images?.length}<ImageAttachments images={message.images} />{/if}
      {#if text}<div class="user-text">{text}</div>{/if}
    </div>
    {#if rewind}<div class="message-actions user-actions">
        <button class="text-button" disabled={historyDisabled} onclick={rewind}
          ><Rewind size={13} />Rewind here</button
        >
      </div>{/if}
  {:else}
    <!-- The reply's work divides where the user steered it: each steer stands between two parts
         as a message of the user's own, and the reply goes on below it under its own heading. -->
    {#each parts as part, index (part.steer?.id ?? '')}
      {@const last = index === parts.length - 1}
      {@const entering = fresh(part.steer?.at)}
      {#if part.steer}
        {@const confirmed = clock(part.steer.at)}
        <div class="steer-message" class:entering role="group" aria-label="Steering message">
          <span class="steer-sender">You{confirmed ? ` ${confirmed}` : ''}</span>
          <span class="steer-mark"><ShipWheel size={13} aria-hidden="true" />Steer</span>
          <div class="user-text">{part.steer.text}</div>
        </div>
      {/if}
      <!-- A part without work shows only as the steer that began it, unless the reply ends there. -->
      {#if last || part.entries.length}
        {@const began = part.steer ? clock(part.steer.at) : sent}
        <div class="message-avatar model" class:entering><ModelMark {mark} variant="tile" /></div>
        <div class="message-content" class:entering>
          <div class="message-heading">
            <strong>{replyModelName(message)}</strong>{#if began}<span>{began}</span
              >{/if}{#if last && message.status === 'running'}{@render liveLabel()}{/if}
          </div>
          {#if mismatch && index === opening}<p class="model-mismatch">
              <CircleAlert size={13} aria-hidden="true" />Ran {mismatch.ran} instead of {mismatch.picked}
            </p>{/if}
          <ToolActivity
            {tools}
            replyStatus={message.status}
            work={part.entries}
            continued={!last}
            limited={!!limit}
            runId={message.runId}
            connectionId={author.connectionId}
            {folder}
            fileChanges={message.fileChanges}
            {carried}
            {openSubagent}
            openedSubagent={opened}
            {writing}
            scope={`${message.id}/${part.steer?.id ?? ''}`}
          />
          {#if last}{@render outcome()}{/if}
        </div>
      {/if}
    {/each}
  {/if}
</article>

<style>
  /* Opacity only: the chat measures what it holds to keep its place, and a send already
     glides the conversation to the new message. */
  .entering {
    animation: fade-in var(--duration) var(--ease-out);
  }
  /* Quiet below your bubble until hovered or focused; always shown on touch screens. */
  .user-actions {
    margin-top: 4px;
    opacity: 0;
    transition: opacity var(--duration-fast) ease;
  }
  .message.user:hover .user-actions,
  .message.user:focus-within .user-actions {
    opacity: 1;
  }
  @media (hover: none) {
    .user-actions {
      opacity: 1;
    }
  }
  .compaction-history {
    margin: 8px 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .compaction-history p {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    color: inherit;
  }
  .compaction-history p::before {
    content: '';
    flex: 0 0 14px;
    height: 1px;
    background: var(--border-strong);
  }
  /* A steer is a message of the user's own between two parts of the reply: their bubble at the
     right edge of the conversation, marked as a steer above it. */
  .steer-message {
    position: relative;
    grid-column: 1 / -1;
    justify-self: end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    max-width: min(86%, 680px);
    /* The reply goes on as far below the bubble as a reply begins below any other message. */
    margin: 14px 0 48px;
  }
  /* Nothing of the reply shows above a steer that came before its work. */
  .steer-message:first-child,
  .reply-switch + .steer-message {
    margin-top: 0;
  }
  /* Steers the reply took one after the other stay together. */
  .steer-message + .steer-message {
    margin-top: -24px;
  }
  .steer-message .user-text {
    border-color: var(--accent-border);
  }
  .steer-mark {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1;
  }
  .steer-mark > :global(svg) {
    color: var(--accent-strong);
  }
  /* Who sent it and when stay for assistive technology, as on the user's other messages. */
  .steer-sender {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 650px) {
    .steer-message {
      max-width: 92%;
    }
  }
  /* The usage limit that stopped a reply follows its open Work history, in place of an error.
     Its words are centred with the button beside them, and its icon stays by their first line. */
  .usage-limit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin: 12px 0 4px;
    padding: 10px 13px;
    border: 1px solid var(--warning-border);
    border-radius: var(--radius-lg);
    background: var(--warning-soft);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .usage-limit-line {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex: 1 1 220px;
    min-width: 0;
  }
  /* A 12px line at this leading is 19.2px tall, so the 15px icon sits 2px down. */
  .usage-limit-line > :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--warning);
  }
  .usage-limit-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .usage-limit-text p {
    margin: 0;
    color: var(--text);
    font-weight: 500;
  }
  .usage-limit-text .usage-limit-continue {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 10px;
    color: var(--text-muted);
    font-weight: 400;
  }
  .usage-limit > button {
    margin-left: auto;
  }
  /* The message sent once a usage limit reset stands just above the reply it starts. */
  .message.continued {
    padding: 14px 0 0;
    margin-bottom: -6px;
  }
  .message.continued .reply-switch {
    margin: 0;
  }
  .response-extras {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 8px;
    margin: 16px 0 4px;
  }
  .response-artifacts,
  .response-screens {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    flex: 1 1 auto;
  }
  .screen-open {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    justify-content: flex-start;
    text-align: left;
    border-radius: var(--radius-lg);
  }
  .screen-open > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  .screen-open span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  /* A claude.ai artifact opens beside the chat, and from its end in the browser. */
  .published-card {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
  }
  .published-card > .screen-open {
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  }
  .published-browser {
    flex-shrink: 0;
    margin-left: -1px;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    padding-inline: 10px;
    color: var(--text-muted);
  }
  .response-artifacts .artifact-card {
    flex: 1 1 auto;
  }
  /* A page the reply showed sits between its paragraphs as a fence's card does. */
  .artifact-placed {
    margin: 14px 0;
  }
  .screen-open small {
    margin-left: auto;
    padding-left: 8px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: 500;
    white-space: nowrap;
  }
  .workflow-avatar {
    display: grid;
    place-items: center;
    color: var(--accent-text);
    background: var(--surface-2);
  }
  .workflow-update {
    max-width: 100%;
    color: var(--text-secondary);
  }
  .workflow-update summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .workflow-update[open] summary {
    margin-bottom: 6px;
  }
</style>
