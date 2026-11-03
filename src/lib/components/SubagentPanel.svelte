<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Bot, Check, CircleAlert, Layers, LoaderCircle, X } from '@lucide/svelte';
  import { activityDisplayStatus, type ActivityDisplayStatus } from '$lib/activity';
  import { recalled, shownRecall } from '$lib/chat-recall';
  import type { Message } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { panelRoom, showPanel } from '$lib/side-panels';
  import { openLink } from '$lib/transport';
  import {
    delegatingSubagent,
    findSubagent,
    interruptedMessage,
    nestedSubagents,
    replyTools,
    subagentReplyStatus,
    subagentTimeline,
  } from '$lib/subagents';
  import PanelResize from './PanelResize.svelte';
  import ToolActivity from './ToolActivity.svelte';
  // A sub-agent's conversation beside the chat: the task it was given, its messages among its
  // own calls, the sub-agents it started and its result. It follows the reply as it runs.
  let {
    message,
    agentId,
    takeFocus = true,
    folder,
    connectionId,
    carried = false,
    open,
    close,
  }: {
    /** The reply that started the sub-agent. */
    message: Message;
    agentId: string;
    /** A later reply that took that reply over runs, and waits for its sub-agents. */
    carried?: boolean;
    /** False for a panel shown again with its chat. */
    takeFocus?: boolean;
    folder?: string;
    connectionId?: string;
    /** Shows another sub-agent of the same reply, such as one this one started. */
    open: (agentId: string) => void;
    close: () => void;
  } = $props();
  const labels: Record<ActivityDisplayStatus, string> = {
    running: 'Running',
    complete: 'Completed',
    error: 'Failed',
    blocked: 'Blocked',
    cancelled: 'Stopped',
    unknown: 'Outcome unconfirmed',
    background: 'Running in the background',
    left: 'Left running',
  };
  const tools = $derived(replyTools(message));
  const found = $derived(findSubagent(tools, agentId));
  const agent = $derived(found?.agent);
  // The reply's sub-agents work on while it runs, or while a reply that took it over runs.
  const replyStatus = $derived(carried ? 'running' : message.status);
  // Its conversation is live while it runs, in the background too.
  const live = $derived(agent?.status === 'running' && replyStatus === 'running');
  const status = $derived(agent ? activityDisplayStatus(agent, replyStatus) : 'unknown');
  const parent = $derived(found && delegatingSubagent(found.holder, found.agent));
  const calls = $derived(tools.filter((tool) => tool.parentId === agentId));
  const nested = $derived(found && nestedSubagents(found.holder, found.agent));
  // The calls of the sub-agents it started say what they are doing in its live rows.
  const nestedCalls = $derived(
    nested
      ? tools.filter((tool) => nested.agents.some((child) => child.id === tool.parentId))
      : [],
  );
  const result = $derived(live ? undefined : agent?.result?.trim());
  const blocks = $derived(agent ? subagentTimeline(agent, calls, { nested, result }) : []);
  const shownTools = $derived([...calls, ...(nested ? [nested, ...nestedCalls] : [])]);
  let viewportWidth = $state(0);
  let workspaceWidth = $state(0);
  let panelWidth = $state<number>();
  const docked = $derived(viewportWidth >= 1100 && workspaceWidth >= 780);
  let dialog = $state<HTMLDialogElement>();
  let mounted = $state(false);
  let scroller = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let linkError = $state('');
  // Beside the chat on wide windows, and a drawer over it otherwise.
  let shown = false;
  $effect(() => {
    if (!mounted || !dialog) return;
    const dock = docked;
    const box = dialog;
    untrack(() => showPanel(box, dock, '[aria-label="Close sub-agent"]', !shown && !takeFocus));
    shown = true;
    untrack(placeConversation);
  });
  // Closing returns focus to what had it when the panel opened; hidden with its chat, the panel
  // leaves focus where the reader moved it.
  let dismissed = false;
  function dismiss() {
    dismissed = true;
    close();
  }
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    const workspace = dialog?.parentElement;
    const observer = new ResizeObserver(() => {
      if (workspace) workspaceWidth = panelRoom(workspace);
    });
    if (workspace) {
      workspaceWidth = panelRoom(workspace);
      observer.observe(workspace);
    }
    mounted = true;
    return () => {
      observer.disconnect();
      if (dismissed && focused?.isConnected) focused.focus();
    };
  });
  // A running sub-agent opens at its latest update and follows new ones while the reader stays
  // at the end; a finished one opens at its task. Shown again with its chat, its conversation
  // opens where the reader left it (`src/lib/chat-recall.ts`).
  const chat = shownRecall();
  const remembered = $derived(recalled(chat, `subagent/${message.id}/${agentId}`));
  let following = false;
  // A closed dialog has nothing to scroll, so each sub-agent's conversation is placed once the
  // panel shows it.
  let placed: string | undefined;
  function placeConversation() {
    if (!scroller || !dialog?.open || placed === agentId) return;
    placed = agentId;
    const left = remembered.get<{ top: number; following: boolean }>('scroll');
    following = left ? left.following : live;
    scroller.scrollTop = following ? scroller.scrollHeight : (left?.top ?? 0);
  }
  $effect(() => {
    void agentId;
    untrack(placeConversation);
  });
  $effect(() => {
    if (!content || !scroller) return;
    const box = scroller;
    const observer = new ResizeObserver(() => {
      if (following) box.scrollTop = box.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  });
  function scrolled() {
    if (!scroller) return;
    following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    remembered.set('scroll', { top: scroller.scrollTop, following });
  }
  // Opening a call near the end reveals it below, where the reader keeps their place.
  function clicked(event: MouseEvent) {
    if ((event.target as Element).closest('summary')) following = false;
  }
  function linkClick(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      void openLink(link.href).catch(() => (linkError = 'Could not open this link.'));
    }
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} />
<!-- Docked, the gap between the chat and the panel resizes it. -->
{#if docked}<PanelResize
    gutter={12}
    availableWidth={workspaceWidth}
    onresize={(width) => (panelWidth = width)}
    storageKey="agent-studio.subagent-panel-width"
    label="Resize sub-agent panel"
    controls="subagent-panel"
  />{/if}
<dialog
  bind:this={dialog}
  id="subagent-panel"
  class="subagent-panel"
  class:docked
  style:--subagent-panel-width={panelWidth ? `${panelWidth}px` : undefined}
  aria-modal={docked ? undefined : 'true'}
  aria-labelledby="subagent-title"
  onkeydown={(event) => {
    if (docked && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  }}
  oncancel={(event) => {
    event.preventDefault();
    dismiss();
  }}
>
  <header>
    <span class="agent-mark" aria-hidden="true"><Bot size={18} /></span>
    <div class="heading">
      <h2 id="subagent-title">{agent?.name ?? 'Sub-agent'}</h2>
      <p class="meta">
        <span class="status" class:live class:failed={status === 'error' || status === 'blocked'}
          >{#if live}<LoaderCircle size={13} class="spinning" aria-hidden="true" />
          {:else if status === 'complete'}<Check size={13} aria-hidden="true" />
          {:else if status === 'left'}<Layers size={13} aria-hidden="true" />
          {:else}<CircleAlert size={13} aria-hidden="true" />{/if}{labels[status]}</span
        >
        <span>{parent ? `Delegated by ${parent.name}` : 'Sub-agent'}</span>
        <span>{calls.length === 1 ? '1 call' : `${calls.length} calls`}</span>
      </p>
    </div>
    <button class="icon-button" onclick={dismiss} aria-label="Close sub-agent" title="Close"
      ><X size={19} /></button
    >
  </header>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Only watches disclosure clicks, which have their own keyboard handling.) -->
  <div class="panel-scroll" bind:this={scroller} onscroll={scrolled} onclickcapture={clicked}>
    <div class="panel-content" bind:this={content}>
      {#if agent}{#key agentId}
          {#if agent.task}<section class="task" aria-label="Task">
              <span class="section-label">Task</span>
              <p>{agent.task}</p>
            </section>{/if}
          <ToolActivity
            tools={shownTools}
            replyStatus={subagentReplyStatus(agent, replyStatus)}
            {blocks}
            runId={message.runId}
            {connectionId}
            {folder}
            fileChanges={message.fileChanges}
            history={false}
            owner={agent.id}
            openSubagent={open}
            scope={`subagent/${message.id}/${agentId}`}
          />{/key}
        {#if live && !blocks.length}<p class="note" role="status">
            Waiting for the sub-agent’s first update…
          </p>{/if}
        {#if agent.messagesTruncated}<p class="note">
            Older versions kept only 16 of its messages.
          </p>{/if}
        {#if interruptedMessage(agent)}<p class="note">
            A message stopped before it finished.
          </p>{/if}
        {#if !live}
          {#if result}<section class="result" class:divided={blocks.length > 0} aria-label="Result">
              <!-- Sanitized markdown; links open through the app at this boundary. -->
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="prose" onclick={linkClick}>{@html renderMarkdown(result)}</div>
            </section>
          {:else}<p class="note">No result was reported for this sub-agent.</p>{/if}
        {/if}
        {#if linkError}<p class="note" role="alert">{linkError}</p>{/if}
      {/if}
    </div>
  </div>
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--surface-overlay);
    padding: 0;
    top: var(--mobile-top, 0px);
    margin: 0 0 0 auto;
    width: min(620px, 100vw);
    height: var(--mobile-height, 100dvh);
    max-width: none;
    max-height: none;
    overflow: hidden;
    border: 0;
    border-left: 1px solid var(--border-strong);
    border-radius: 0;
    box-shadow: var(--shadow-xl);
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
    animation: fade-in var(--duration) ease;
  }
  dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  dialog.docked {
    position: relative;
    inset: auto;
    align-self: stretch;
    flex: 0 0 var(--subagent-panel-width, 42%);
    width: var(--subagent-panel-width, 42%);
    min-width: 360px;
    height: auto;
    min-height: 0;
    margin: 0;
    border-left-color: var(--border);
    box-shadow: none;
    background: var(--bg-sidebar);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 14px 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  .agent-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-secondary);
  }
  .heading {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 12px;
    margin: 3px 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .status.live {
    color: var(--accent-text);
  }
  .status.failed {
    color: var(--danger);
  }
  .panel-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .panel-content {
    display: grid;
    gap: 4px;
    min-width: 0;
    padding: 16px 20px 24px;
  }
  .task {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    margin-bottom: 8px;
  }
  .section-label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
  }
  .task p {
    max-width: min(92%, 560px);
    margin: 0;
    padding: 10px 15px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 18px 18px 6px 18px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    color: var(--text);
  }
  .note {
    margin: 4px 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .result.divided {
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .result .prose > :global(:first-child) {
    margin-top: 0;
  }
  .result .prose > :global(:last-child) {
    margin-bottom: 0;
  }
  @media (max-width: 600px) {
    header {
      padding: 12px;
    }
    .panel-content {
      padding: 12px 12px 20px;
    }
  }
</style>
