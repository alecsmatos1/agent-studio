<script lang="ts">
  import {
    Brain,
    Bot,
    LoaderCircle,
    Check,
    CircleAlert,
    ChevronDown,
    ChevronUp,
    CornerDownRight,
    ExternalLink,
    FoldVertical,
    Layers,
    PanelRightOpen,
  } from '@lucide/svelte';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    safeSourceUrl,
    activityDisplayStatus,
    toolDisplayStatus,
    toolElapsed,
    toolProgressLabel,
    type ActivityDisplayStatus,
    type ToolActivity,
  } from '$lib/activity';
  import {
    activityEntries,
    activityGroupSummary,
    childIssueLabel,
    groupActivityEntries,
    groupIcon,
    liveAction,
    liveGroupItems,
    liveMemory,
    type ActivityEntry,
    type ActivitySource,
    type LiveGroupItem,
  } from '$lib/activity-groups';
  import { compactionLabel, compactionTokens, type Compaction } from '$lib/compaction';
  import type { Message } from '$lib/domain';
  import { relativeFilePath, type FileChanges } from '$lib/file-changes';
  import { renderMarkdown, type ArtifactCards } from '$lib/markdown';
  import { toolVisual } from '$lib/tool-presentation';
  import { openLink } from '$lib/transport';
  import { recall } from '$lib/chat-recall';
  import { revealedDisclosures } from '$lib/disclosures';
  import DiffTable from './DiffTable.svelte';
  import ToolIcon from './ToolIcon.svelte';
  import ToolResult from './ToolResult.svelte';
  let {
    tools,
    replyStatus,
    blocks = [],
    compactions,
    finalText = '',
    work,
    continued = false,
    runId,
    connectionId,
    folder,
    fileChanges,
    history = true,
    limited = false,
    owner,
    carried = false,
    openSubagent,
    openedSubagent,
    writing,
    scope,
  }: {
    tools: ToolActivity[];
    replyStatus: Message['status'];
    blocks?: ActivitySource[];
    /** Compactions of the reply's context, shown where each began among its work. */
    compactions?: Compaction[];
    finalText?: string;
    /** One part of a steered reply's work, arranged by the reply, instead of `blocks`. */
    work?: ActivityEntry[];
    /** A steer follows this part: the reply went on in the next, which ends it. */
    continued?: boolean;
    /** The reply's run, which finds results kept on the computer that ran it. */
    runId?: string;
    connectionId?: string;
    folder?: string;
    fileChanges?: FileChanges;
    /** A finished reply keeps its activity in a collapsed Work history disclosure. */
    history?: boolean;
    /** The reply stopped at a usage limit, so its Work history stays open as the reply left it. */
    limited?: boolean;
    /** The sub-agent whose conversation this is; its own calls need no attribution. */
    owner?: string;
    /** A later reply that took this one over runs, so the sub-agents still running work on. */
    carried?: boolean;
    /** Opens a sub-agent's conversation in the side panel. */
    openSubagent?: (agentId: string) => void;
    /** The sub-agent whose conversation the side panel shows. */
    openedSubagent?: string;
    /** Question calls whose question Claude is still writing. */
    writing?: ReadonlySet<string>;
    /** Names this work within its chat, which recalls what the reader opened in it. */
    scope?: string;
  } = $props();
  let linkError = $state('');
  const labels = {
    running: 'Running',
    complete: 'Completed',
    error: 'Failed',
    blocked: 'Blocked',
    cancelled: 'Stopped',
    unknown: 'Outcome unconfirmed',
    background: 'In background',
    left: 'Left running',
  };
  const kindLabels = { added: 'Added', modified: 'Edited', deleted: 'Deleted', renamed: 'Renamed' };
  const entries = $derived(work ?? activityEntries(blocks, tools, finalText, compactions));
  // The reply's own comments show its artifacts as cards; a sub-agent's text keeps its code.
  const artifactCards = $derived<ArtifactCards | undefined>(
    owner ? undefined : replyStatus === 'running' ? 'writing' : 'cards',
  );
  const groups = $derived(groupActivityEntries(entries));
  // As the reader left them when the chat was last shown (`src/lib/chat-recall.ts`): the live
  // activity of a running reply and the Work history it becomes each recall their own.
  const disclosures = revealedDisclosures(
    recall(() => scope),
    () => (replyStatus === 'running' ? 'live' : 'history'),
  );
  // The sub-agents these calls hold, whose own calls show in their conversations.
  const agentIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const tool of tools)
      if (tool.agents.length) for (const agent of tool.agents) ids.add(agent.id);
    return ids;
  });
  function topLevel(tool: ToolActivity) {
    return !tool.parentId || !agentIds.has(tool.parentId);
  }
  // While the reply runs, each call shows what it is doing in a row of its own until it folds
  // into its group's summary.
  const live = $derived(replyStatus === 'running');
  const memory = liveMemory();
  // The latest entry showing anything; its latest call keeps its row until the agent moves on,
  // or the user steers the reply, which begins its next part.
  const lastKey = $derived(
    continued
      ? undefined
      : groups.findLast((group) => group.kind !== 'tools' || group.tools.some(topLevel))?.key,
  );
  // What a running sub-agent is doing: its latest call.
  function latestChild(tool: ToolActivity) {
    const running = new Set(tool.agents.filter((a) => a.status === 'running').map((a) => a.id));
    return running.size
      ? tools.findLast((t) => !!t.parentId && running.has(t.parentId))
      : undefined;
  }
  // A row the reader opened stays until they close it, even after its call would fold.
  const opened = new SvelteSet<string>();
  function liveToggle(id: string) {
    const reveal = disclosures.opened(`tool:${id}`, false);
    return (event: Event) => {
      reveal(event);
      if ((event.currentTarget as HTMLDetailsElement).open) opened.add(id);
      else opened.delete(id);
    };
  }
  // Each group's summary and rows while the reply runs.
  const liveItems = $derived.by(() => {
    const items = new Map<string, LiveGroupItem[]>();
    if (live)
      for (const group of groups) {
        const visible = group.kind === 'tools' ? group.tools.filter(topLevel) : [];
        if (visible.length)
          items.set(
            group.key,
            liveGroupItems(group.key, visible, group.key === lastKey, replyStatus, memory, opened),
          );
      }
    return items;
  });
  const newFile = (tool: ToolActivity) => {
    const edit = editOf(tool);
    return edit?.files.length === 1 && edit.files[0].kind === 'added';
  };
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let root = $state<HTMLElement>();
  // Where each row sat in its group before an update that folds rows away, relative to the
  // group so that scrolling in between does not matter.
  const places = new WeakMap<Element, { x: number; y: number }>();
  const place = (item: Element) => {
    const box = item.getBoundingClientRect(),
      group = item.parentElement!.getBoundingClientRect();
    return { x: box.left - group.left, y: box.top - group.top };
  };
  let shown = new Map<string, LiveGroupItem[]>();
  let folding = false;
  // Only updates that fold rows measure them, never every update of the reply.
  $effect.pre(() => {
    const next = liveItems;
    const leaving = [...shown].some(([key, items]) => {
      const now = next.get(key);
      return !!now && now !== items && items.some((item) => !now.some((n) => n.key === item.key));
    });
    shown = next;
    if (!leaving || !root) return;
    for (const item of root.querySelectorAll('.live-item')) places.set(item, place(item));
    folding = true;
  });
  // Rows below a folded call slide up to close its gap.
  $effect(() => {
    void liveItems;
    if (!folding || !root) return;
    folding = false;
    if (reducedMotion()) return;
    for (const item of root.querySelectorAll<HTMLElement>('.live-item')) {
      const was = places.get(item);
      if (item.inert || !was) continue;
      const moved = was.y - place(item).y;
      if (Math.abs(moved) >= 0.5)
        item.animate([{ transform: `translateY(${moved}px)` }, { transform: 'none' }], {
          duration: 260,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
    }
  });
  // A folded call's row leaves the flow and fades where it was, over its successor, rising
  // toward the summary. Svelte places a leaving row after the rows that replace it.
  function fold(node: HTMLElement): TransitionConfig {
    if (reducedMotion()) return { duration: 0 };
    for (const animation of node.getAnimations()) animation.cancel();
    const { width, height } = getComputedStyle(node);
    Object.assign(node.style, { position: 'absolute', width, height });
    const was = places.get(node);
    const now = place(node);
    const base = was ? `translate(${was.x - now.x}px, ${was.y - now.y}px)` : '';
    return {
      duration: 260,
      easing: cubicOut,
      css: (t, u) => `opacity: ${t * t}; transform: ${base} translateY(${-10 * u}px)`,
    };
  }
  function backgroundNote(tool: ToolActivity) {
    if (tool.status !== 'running') return 'Ran in the background.';
    return replyStatus === 'running'
      ? 'Running in the background.'
      : 'Left running; its outcome was not recorded.';
  }
  const editOf = (tool: ToolActivity) => fileChanges?.edits.find((edit) => edit.id === tool.id);
  // The command's exit code now travels with its output; older calls kept it as a fact.
  const facts = (tool: ToolActivity) =>
    (tool.facts ?? []).filter((fact) => !(fact.label === 'Exit code' && tool.output));
  function progressLink(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) void visit(event, link.href);
  }
  async function visit(event: MouseEvent, url: string) {
    event.preventDefault();
    const safe = safeSourceUrl(url);
    if (safe)
      try {
        await openLink(safe);
      } catch {
        linkError = 'Could not open this source.';
      }
  }
  // Expanded history also closes from its end. Its summary takes the focus the control had,
  // and its place unless the start of the history was in view (virtual-space.ts).
  function collapseHistory(event: MouseEvent) {
    const control = event.currentTarget as HTMLButtonElement;
    const history = control.closest('details')!;
    const focused = document.activeElement === control;
    history.open = false;
    if (focused)
      history.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
  }
</script>

{#snippet statusMark(current: ActivityDisplayStatus, label = labels[current])}
  <span
    class="tool-status"
    class:failed={current === 'error' || current === 'blocked'}
    class:live={current === 'running'}
    class:done={current === 'complete'}
    title={current === 'complete' ? labels.complete : undefined}
  >
    {#if current === 'running'}<LoaderCircle size={13} class="spinning" />
    {:else if current === 'complete'}<Check size={13} />
    {:else if current === 'background' || current === 'left'}<Layers size={13} />
    {:else}<CircleAlert size={13} />{/if}<span class:sr-only={current === 'complete'}
      >{label}</span
    >
  </span>
{/snippet}

{#snippet toolCard(tool: ToolActivity)}
  {@const status = toolDisplayStatus(tool, replyStatus)}
  {@const visual = toolVisual(tool, { folder, newFile: newFile(tool) })}
  <details
    class="tool-card"
    data-category={tool.category}
    open={disclosures.open(`tool:${tool.id}`)}
    ontoggle={disclosures.opened(`tool:${tool.id}`)}
  >
    <summary onclick={disclosures.reveal(`tool:${tool.id}`)}>
      <ToolIcon icon={visual.icon} />
      <span class="tool-title"
        ><span
          class="tool-label"
          class:code={visual.code}
          title={visual.code ? visual.hint : undefined}>{visual.title}</span
        >{#if visual.detail}<span class="query-preview" title={visual.hint ?? visual.detail}
            >{visual.detail}</span
          >{/if}</span
      >
      <span class="tool-state">
        <!-- The Background work toggle below the reply shows its running time, not here. -->
        {#if tool.elapsedMs != null && status !== 'background' && status !== 'left'}<span
            class="tool-elapsed"
            title="Elapsed time recorded on the execution computer"
            aria-label={`Tool elapsed time: ${toolElapsed(tool.elapsedMs)}`}
            >{toolElapsed(tool.elapsedMs)}</span
          >{/if}
        {@render statusMark(status)}
      </span>
      <ChevronDown size={13} class="disclosure" />
    </summary>
    {@render toolBody(tool)}
  </details>
{/snippet}

<!-- A call's recorded details, rendered once its row is first expanded. -->
{#snippet toolBody(tool: ToolActivity)}
  {@const edit = editOf(tool)}
  {@const visual = toolVisual(tool, { folder, newFile: newFile(tool) })}
  <!-- A description the row already shows is not repeated. -->
  {@const showDetail =
    !!tool.detail && visual.title !== tool.detail && visual.detail !== tool.detail}
  {#if disclosures.has(`tool:${tool.id}`)}<div class="tool-body">
      {#if tool.progress}<p class="tool-progress">
          {toolProgressLabel(tool)} at {toolElapsed(tool.progress.atElapsedMs)}
        </p>{/if}
      {#if tool.parentId && tool.parentId !== owner}<p class="tool-note">
          By {tools.flatMap((t) => t.agents).find((a) => a.id === tool.parentId)?.name ??
            'sub-agent'}
        </p>{/if}
      {#if showDetail}<p class="tool-detail">{tool.detail}</p>{/if}
      {#if tool.background}<p class="tool-note">{backgroundNote(tool)}</p>{/if}
      {#if tool.query || tool.path || facts(tool).length}<dl class="tool-facts">
          {#if tool.query}<div>
              <dt class="metadata-label">
                {tool.operation === 'glob' || tool.operation === 'grep' ? 'Pattern' : 'Query'}
              </dt>
              <dd class="tool-query">{tool.query}</dd>
            </div>{/if}
          {#if tool.path}<div>
              <dt class="metadata-label">
                {tool.operation === 'glob' || tool.operation === 'grep' ? 'Folder' : 'Path'}
              </dt>
              <dd><code class="tool-path">{tool.path}</code></dd>
            </div>{/if}
          {#each facts(tool) as fact}<div>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>{/each}
        </dl>{/if}
      {#if edit}
        {#each edit.files as file (file.path)}
          <section class="tool-diff" aria-label={`Changes in ${file.path}`}>
            {#if edit.files.length > 1 || !tool.path}<div class="diff-heading">
                <span class="diff-path" title={file.path}
                  >{relativeFilePath(file.path, folder)}</span
                ><span class="diff-kind">{kindLabels[file.kind]}</span>
              </div>{/if}
            {#if file.hunks?.length}<DiffTable {file} />{:else}<p class="tool-note">
                {file.kind === 'renamed'
                  ? 'File renamed without recorded text changes.'
                  : file.kind === 'deleted'
                    ? 'File deleted.'
                    : 'No text diff recorded.'}
              </p>{/if}
          </section>
        {/each}
      {/if}
      {#if tool.command || tool.input || tool.output}<ToolResult
          {tool}
          {runId}
          {connectionId}
          {replyStatus}
          scope={scope && `${scope}/tool:${tool.id}`}
        />{/if}
      {#if !tool.query && !tool.path && !showDetail && !tool.command && !tool.input && !tool.output && !edit && !tool.background && !facts(tool).length && !tool.sources.length && !tool.agents.length}
        <p class="tool-note">
          {tool.status === 'running' && replyStatus === 'running'
            ? 'Waiting for tool details…'
            : tool.commandRun || tool.operation === 'command'
              ? 'Command not recorded.'
              : 'No details recorded.'}
        </p>
      {/if}
      {#if tool.category === 'search' && !tool.sources.length && tool.status === 'complete'}
        <p class="tool-note">No source links.</p>
      {/if}
      {#if tool.sources.length}<ul class="tool-sources">
          {#each tool.sources.filter((s) => safeSourceUrl(s.url)) as source}
            <li>
              <a
                href={safeSourceUrl(source.url)}
                onclick={(event) => visit(event, source.url)}
                title={source.url}
              >
                <span>{source.title || source.url}</span><ExternalLink
                  size={12}
                  aria-hidden="true"
                />
              </a>
            </li>
          {/each}
        </ul>{/if}
      {#if tool.agents.length}{@render subagentRows(tool)}{/if}
    </div>{/if}
{/snippet}

<!-- Each sub-agent opens its own conversation in the side panel beside the chat. -->
{#snippet subagentRows(tool: ToolActivity)}
  <ul class="subagents" aria-label="Sub-agents">
    {#each tool.agents as agent (agent.id)}
      {@const parent = agent.parentId
        ? tool.agents.find((a) => a.id === agent.parentId)
        : undefined}
      <li>
        <button
          type="button"
          class="subagent-row"
          class:delegated={!!parent}
          aria-current={openedSubagent === agent.id ? 'true' : undefined}
          title="Open this sub-agent’s conversation beside the chat"
          onclick={() => openSubagent?.(agent.id)}
        >
          <Bot size={14} aria-hidden="true" />
          <span class="subagent-text">
            <span class="subagent-name">{agent.name}</span>
            {#if parent}<span class="subagent-detail">Delegated by {parent.name}</span>
            {:else if agent.task}<span class="subagent-detail">{agent.task}</span>{/if}
          </span>
          {@render statusMark(activityDisplayStatus(agent, carried ? 'running' : replyStatus))}
          <PanelRightOpen size={14} class="subagent-open" aria-hidden="true" />
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<!-- `calls` are the group's own calls and those of its sub-agents; `counted` animates the label. -->
{#snippet groupRow(key: string, visible: ToolActivity[], calls: ToolActivity[], counted = false)}
  {@const summary = activityGroupSummary(visible, replyStatus, tools)}
  {@const active = calls.filter((tool) => tool.status === 'running' && !tool.background)}
  {@const elapsed = Math.max(-1, ...active.map((tool) => tool.elapsedMs ?? -1))}
  {@const progressTool = active.findLast((tool) => tool.progress)}
  <details class="activity-group" open={disclosures.open(key)} ontoggle={disclosures.opened(key)}>
    <summary title="Expand for tool details" onclick={disclosures.reveal(key)}>
      {#if summary.running}<LoaderCircle size={16} class="spinning" aria-label="Running" />
      {:else}<ToolIcon icon={groupIcon(visible)} size={16} />{/if}
      {#if counted}{#key summary.label}<span class="group-label counted">{summary.label}</span
          >{/key}
      {:else}<span class="group-label">{summary.label}</span>{/if}
      {#if summary.running && elapsed >= 0}<span class="group-progress">
          {#if progressTool}<span>{toolProgressLabel(progressTool)}</span>{/if}
          <span
            class="tool-elapsed"
            title="Longest currently running tool; parallel times are not added"
            aria-label={`Longest running tool: ${toolElapsed(elapsed)}`}
            >{toolElapsed(elapsed)}</span
          >
        </span>{/if}
      {#if summary.issue}{@render statusMark(summary.issue)}
      {:else if summary.childIssue}{@render statusMark(
          summary.childIssue.status,
          childIssueLabel(summary.childIssue),
        )}{/if}
      <ChevronDown size={13} class="disclosure" aria-hidden="true" />
    </summary>
    {#if disclosures.has(key)}<div class="group-tools">
        {#each visible as tool (tool.id)}
          <!-- The call that holds sub-agents lists them directly, one row each. -->
          {#if tool.category === 'agent' && tool.agents.length}{@render subagentRows(tool)}
            {#if tool.detail}<p class="tool-note group-note">{tool.detail}</p>{/if}
          {:else}{@render toolCard(tool)}{/if}
        {/each}
      </div>{/if}
  </details>
{/snippet}

{#snippet liveMark(current: ActivityDisplayStatus)}
  <span
    class="live-status"
    class:live={current === 'running'}
    class:failed={current === 'error' || current === 'blocked'}
    class:unfinished={current === 'cancelled' || current === 'unknown'}
  >
    {#if current === 'complete'}<Check size={13} />
    {:else if current === 'background' || current === 'left'}<Layers size={13} />
    {:else if current !== 'running'}<CircleAlert size={13} />{/if}<span
      class:sr-only={!['error', 'blocked', 'cancelled', 'unknown'].includes(current)}
      >{labels[current]}</span
    >
  </span>
{/snippet}

<!-- What a call is doing now, or has just done, before it folds into its group. -->
{#snippet liveRow(tool: ToolActivity)}
  {@const status = toolDisplayStatus(tool, replyStatus)}
  {@const act = liveAction(tool, status, {
    folder,
    newFile: newFile(tool),
    writing: writing?.has(tool.id),
  })}
  {@const child = tool.category === 'agent' && status === 'running' ? latestChild(tool) : undefined}
  <details
    class="live-row"
    class:running={status === 'running'}
    data-status={status}
    data-category={tool.category}
    ontoggle={liveToggle(tool.id)}
  >
    <summary onclick={disclosures.reveal(`tool:${tool.id}`)}>
      <ToolIcon icon={act.icon} size={16} />
      <span class="live-line" title={act.hint}>
        {#if act.verb}<span class="live-verb"
            >{act.verb}{#if status === 'running'}<span
                class="live-sheen"
                data-text={act.verb}
                aria-hidden="true"
              ></span>{/if}</span
          >{/if}
        {#if act.target}<span class="live-target" class:code={act.code}>{act.target}</span>{/if}
      </span>
      <span class="live-meta">
        {#if status === 'running' && tool.progress}<span>{toolProgressLabel(tool)}</span>{/if}
        <!-- The Background work toggle below the reply shows its running time, not here. -->
        {#if tool.elapsedMs != null && tool.elapsedMs >= 1000 && status !== 'background' && status !== 'left'}<span
            class="tool-elapsed"
            title="Elapsed time recorded on the execution computer"
            aria-label={`Tool elapsed time: ${toolElapsed(tool.elapsedMs)}`}
            >{toolElapsed(tool.elapsedMs)}</span
          >{/if}
        {#key status}{@render liveMark(status)}{/key}
      </span>
      <ChevronDown size={13} class="disclosure" aria-hidden="true" />
      {#if child}
        {@const doing = liveAction(child, toolDisplayStatus(child, replyStatus), { folder })}
        {#key child.id}<span class="live-child" title={doing.hint}
            ><CornerDownRight size={12} aria-hidden="true" />{#if doing.verb}<span
                >{doing.verb}</span
              >{/if}{#if doing.target}<span class="live-target" class:code={doing.code}
                >{doing.target}</span
              >{/if}</span
          >{/key}
      {/if}
    </summary>
    {@render toolBody(tool)}
  </details>
{/snippet}

{#snippet liveGroup(key: string, items: LiveGroupItem[])}
  <div class="live-group">
    {#each items as item (item.key)}
      <div class="live-item" out:fold>
        {#if item.kind === 'summary'}{@render groupRow(key, item.tools, item.tools, true)}
        {:else if item.kind === 'call'}{@render liveRow(item.tool)}
        {:else}<p class="live-more">{item.count} more running</p>{/if}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet timeline()}
  <div class="activity-timeline">
    {#each groups as group (group.key)}
      {#if group.kind === 'tools' && live}
        {@const items = liveItems.get(group.key)}
        {#if items}{@render liveGroup(group.key, items)}{/if}
      {:else if group.kind === 'tools'}
        {@const visible = group.tools.filter(topLevel)}
        {#if visible.length}{@render groupRow(group.key, visible, group.tools)}{/if}
      {:else if group.kind === 'reasoning'}
        <div class="reasoning-entry" role="group" aria-label="Reasoning">
          <span class="reasoning-mark" title="Reasoning reported by the provider"
            ><Brain size={16} aria-hidden="true" /></span
          >
          <div class="reasoning-body">
            <!-- Sanitized markdown; nested links provide keyboard interaction. -->
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="prose reasoning-text" onclick={progressLink}>
              {@html renderMarkdown(group.block.text)}
            </div>
            {#if group.block.truncated}<p class="tool-note">
                Reasoning display limit reached. This section is incomplete.
              </p>{/if}
          </div>
        </div>
      {:else if group.kind === 'compaction'}
        {@const sizes = compactionTokens(group.compaction)}
        <div class="compaction-entry" role="group" aria-label="Context compaction">
          {#if live && group.compaction.status === 'running'}<LoaderCircle
              size={16}
              class="spinning"
              aria-hidden="true"
            />{:else}<FoldVertical size={16} aria-hidden="true" />{/if}
          <p>
            {compactionLabel(group.compaction, replyStatus)}{#if sizes}<span>{` · ${sizes}`}</span
              >{/if}
          </p>
        </div>
      {:else}
        {@const entry = group.entry}
        {#if entry.progress}
          <!-- Sanitized markdown; nested links provide keyboard interaction. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose progress-message" onclick={progressLink}>
            {@html renderMarkdown(entry.text, artifactCards)}
          </div>
        {:else}<p class="timeline-note">{entry.text}</p>{/if}
      {/if}
    {/each}
  </div>
{/snippet}

{#if entries.length}
  <div
    class="tool-activity"
    class:live-activity={replyStatus === 'running'}
    aria-label="Tools, hooks and sub-agents"
    bind:this={root}
  >
    {#if replyStatus === 'running' || !history}{@render timeline()}
    {:else}
      <details
        class="activity-summary"
        open={disclosures.open('history', limited)}
        ontoggle={disclosures.opened('history')}
      >
        <summary aria-label="Work history" onclick={disclosures.reveal('history')}>
          <ChevronDown size={14} class="disclosure" />
          <span class="history-title">Work history</span>
          <!-- A steered reply ended in its last part, which says how. -->
          {#if !continued}
            {#if replyStatus === 'cancelled'}<span class="tool-status">Stopped</span
              >{:else if limited}<span class="tool-status limited">Limit reached</span
              >{:else if replyStatus === 'error'}<span class="tool-status failed">Failed</span>{/if}
          {/if}
        </summary>
        {#if limited || disclosures.has('history')}{@render timeline()}
          <div class="history-end">
            <button
              type="button"
              class="collapse-history"
              data-collapse
              aria-label="Collapse Work history"
              onclick={collapseHistory}><ChevronUp size={14} aria-hidden="true" />Collapse</button
            >
          </div>{/if}
      </details>
    {/if}
    {#if linkError}<p role="alert">{linkError}</p>{/if}
  </div>
{/if}

<style>
  .tool-activity {
    margin: 10px 0 14px;
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .tool-activity:not(.live-activity) {
    margin-top: 0;
  }
  .activity-timeline {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .activity-group {
    min-width: 0;
  }
  .activity-group > summary {
    display: flex;
    align-items: center;
    /* A long label wraps its text beside the icon and chevron instead of taking a line alone. */
    flex-wrap: nowrap;
    gap: 8px;
    width: fit-content;
    max-width: 100%;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    list-style: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--text-base);
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .activity-group > summary:hover {
    background: var(--hover);
    color: var(--text);
  }
  .activity-group > summary > :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .activity-group > summary > :global(.disclosure) {
    color: var(--text-faint);
  }
  .activity-group[open] > summary {
    width: 100%;
  }
  .group-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .group-progress,
  .tool-state {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .group-progress {
    /* Progress takes the space left beside the label and wraps first on narrow screens. */
    flex: 1 0 0;
    margin-left: auto;
    justify-content: flex-end;
    text-align: right;
  }
  .activity-group:not([open]) .group-progress {
    margin-left: 4px;
  }
  .tool-elapsed {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .group-tools {
    display: grid;
    gap: 2px;
    margin: 4px 0 6px 8px;
    padding-left: 14px;
    border-left: 1px solid var(--border-strong);
    min-width: 0;
  }
  /* A running reply's group: its summary, then calls in rows of their own. Rows move with
     opacity and transforms only; a folded row leaves the flow at once and fades above it. */
  .live-group {
    position: relative;
    min-width: 0;
  }
  .live-item {
    min-width: 0;
  }
  .live-item + .live-item {
    margin-top: 2px;
  }
  .live-item > .activity-group,
  .live-row,
  .live-activity .reasoning-entry,
  .live-activity .compaction-entry,
  .live-activity .progress-message,
  .live-activity .timeline-note {
    animation: live-in var(--duration-slow) var(--ease-out);
  }
  .counted {
    animation: live-count var(--duration-slow) var(--ease-out);
  }
  .live-row {
    min-width: 0;
  }
  .live-row > summary {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto 13px;
    align-items: center;
    column-gap: 8px;
    min-height: 28px;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    list-style: none;
    cursor: pointer;
    font-size: var(--text-base);
    color: var(--text-muted);
    transition: background-color var(--duration-fast) ease;
  }
  .live-row > summary:hover {
    background: var(--hover);
  }
  .live-row > summary > :global(.disclosure) {
    color: var(--text-faint);
  }
  .live-row.running > summary > :global(.tool-icon) {
    color: var(--text-secondary);
  }
  .live-row > .tool-body {
    padding-left: 24px;
  }
  .live-line,
  .live-child {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    white-space: nowrap;
  }
  .live-verb {
    position: relative;
    flex: none;
  }
  .running > summary .live-verb {
    color: var(--text-secondary);
  }
  .live-target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-secondary);
  }
  .running > summary > .live-line > .live-target {
    color: var(--text);
  }
  .live-target.code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .live-meta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .live-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-faint);
  }
  /* A finished call's mark pops in; a running call shows its sheen instead. */
  .live-status:not(.live) {
    animation: live-mark var(--duration) var(--ease-out);
  }
  .live-status.unfinished {
    color: var(--text-muted);
  }
  .live-status.failed {
    color: var(--danger);
  }
  .live-child {
    grid-column: 2 / -1;
    align-items: center;
    padding-top: 1px;
    font-size: var(--text-xs);
    animation: live-in var(--duration) var(--ease-out);
  }
  .live-child > :global(svg) {
    flex: none;
    color: var(--text-faint);
  }
  .live-child .live-target {
    color: var(--text-secondary);
  }
  .live-more {
    margin: 0;
    padding: 2px 0 2px 24px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  /* A band of brighter text sweeps across a running call's verb. The band and its copy of the
     verb move in opposite directions with transforms, so the sweep runs without repainting
     the chat, and the copy stays out of the page's text. */
  .live-sheen {
    position: absolute;
    inset: 0 auto 0 0;
    width: 60%;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    user-select: none;
    mask-image: linear-gradient(90deg, transparent, var(--text) 50%, transparent);
    animation: sheen-band 2.4s ease-in-out infinite;
  }
  .live-sheen::before {
    content: attr(data-text);
    display: block;
    width: calc(100% / 0.6);
    color: var(--text);
    white-space: nowrap;
    animation: sheen-text 2.4s ease-in-out infinite;
  }
  @keyframes live-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @keyframes live-count {
    from {
      opacity: 0.35;
      transform: translateY(4px);
    }
  }
  @keyframes live-mark {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  /* The band crosses the verb in the first 60% of each cycle, then rests past its end. */
  @keyframes sheen-band {
    0% {
      opacity: 1;
      transform: translateX(-100%);
    }
    60%,
    100% {
      opacity: 1;
      transform: translateX(166.667%);
    }
  }
  @keyframes sheen-text {
    0% {
      transform: translateX(60%);
    }
    60%,
    100% {
      transform: translateX(-100%);
    }
  }
  .activity-summary[open] {
    margin-bottom: 4px;
  }
  .activity-summary > summary,
  .collapse-history {
    display: flex;
    gap: 7px;
    align-items: center;
    width: fit-content;
    cursor: pointer;
    list-style: none;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .activity-summary > summary:hover,
  .collapse-history:hover {
    background: var(--hover);
    color: var(--text);
  }
  /* Expanded history ends with a divider, which starts with the control that closes it. */
  .history-end {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .history-end::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .collapse-history {
    flex: none;
  }
  .activity-summary[open] > summary {
    margin-bottom: 8px;
  }
  .history-title {
    white-space: nowrap;
  }
  .activity-summary > summary > :global(svg) {
    flex-shrink: 0;
  }
  .timeline-note {
    font-size: var(--text-xs);
    color: var(--text-faint);
    margin: 2px 0;
  }
  .progress-message {
    color: var(--text-secondary);
  }
  .progress-message > :global(:last-child) {
    margin-bottom: 0;
  }
  /* Reasoning reads as quieter prose beside a brain mark, aligned with tool group labels. */
  .reasoning-entry {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    gap: 8px;
    min-width: 0;
    font-size: var(--text-base);
    line-height: var(--leading-prose);
  }
  .reasoning-mark {
    display: flex;
    align-items: center;
    height: calc(1em * var(--leading-prose));
    color: var(--text-faint);
  }
  .reasoning-body {
    min-width: 0;
  }
  .reasoning-text {
    font-size: inherit;
    color: var(--text-muted);
  }
  .reasoning-text > :global(:first-child) {
    margin-top: 0;
  }
  .reasoning-text > :global(:last-child) {
    margin-bottom: 0;
  }
  /* A compaction is a quiet row where it began among the work, aligned with tool group labels. */
  .compaction-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding-block: 4px;
    font-size: var(--text-base);
    color: var(--text-secondary);
  }
  .compaction-entry > :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .compaction-entry p {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    color: inherit;
  }
  .compaction-entry span {
    color: var(--text-muted);
  }
  /* Targets and reported facts: a label column beside their values. */
  .tool-facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 14px;
    margin: 6px 0;
  }
  .tool-facts > div {
    display: contents;
  }
  .tool-facts dt {
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: var(--leading-normal);
    color: var(--text-muted);
  }
  .tool-facts dd {
    margin: 0;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: var(--leading-normal);
    color: var(--text-secondary);
  }
  .tool-card {
    min-width: 0;
    overflow: hidden;
  }
  .tool-card > summary {
    display: flex;
    gap: 9px;
    align-items: center;
    padding: 5px 8px;
    border-radius: var(--radius-md);
    cursor: pointer;
    list-style: none;
    color: var(--text-secondary);
    transition: background-color var(--duration-fast) ease;
  }
  .tool-card > summary:hover {
    background: var(--hover);
  }
  .tool-card > summary > :global(svg) {
    color: var(--text-muted);
  }
  .tool-card > summary > :global(.disclosure) {
    color: var(--text-faint);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible,
  .collapse-history:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 0;
  }
  .tool-title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .tool-label.code {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool-status {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--text-muted);
    font-size: var(--text-xs);
    flex-shrink: 0;
  }
  .tool-status.done {
    color: var(--text-faint);
  }
  .tool-status.live {
    color: var(--accent-text);
  }
  .tool-status.failed {
    color: var(--danger);
  }
  .tool-status.limited {
    color: var(--warning);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tool-body {
    padding: 2px 8px 10px 32px;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    min-width: 0;
  }
  .tool-body p {
    margin: 6px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: var(--leading-normal);
    color: inherit;
  }
  .tool-detail {
    color: var(--text);
  }
  .tool-query {
    color: var(--text);
  }
  .tool-path {
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    color: var(--text);
  }
  .tool-note,
  .tool-body .tool-note {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .tool-diff {
    margin: 8px 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .tool-diff > :global(.diff-scroll:first-child) {
    border-top: 0;
  }
  .tool-diff .tool-note {
    margin: 0;
    padding: 8px 12px;
  }
  .diff-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--surface-1);
  }
  .diff-path {
    flex: 1 1 160px;
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
  }
  .diff-kind {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--hover);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 17px;
    color: var(--text-muted);
  }
  .tool-sources {
    padding: 0;
    margin: 8px 0 0;
    list-style: none;
    display: grid;
    gap: 5px;
  }
  .tool-sources a {
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
    color: var(--accent-text);
    text-decoration: underline;
    text-decoration-color: var(--accent-border);
    text-underline-offset: 3px;
  }
  .tool-sources a span {
    overflow-wrap: anywhere;
  }
  .tool-sources :global(svg) {
    flex-shrink: 0;
  }
  .query-preview {
    display: block;
    color: var(--text-muted);
    margin-top: 1px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Sub-agents are quiet rows like calls; each opens its conversation beside the chat. */
  .subagents {
    display: grid;
    /* Long tasks shorten with an ellipsis instead of widening the row. */
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .tool-body > .subagents {
    margin: 4px 0;
  }
  .subagent-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    width: 100%;
    min-width: 0;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--duration-fast) ease;
  }
  .subagent-row:hover {
    background: var(--hover);
  }
  .subagent-row[aria-current='true'] {
    background: var(--selected);
  }
  .subagent-row.delegated {
    padding-left: 24px;
  }
  .subagent-row > :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .subagent-row > :global(.subagent-open) {
    color: var(--text-faint);
  }
  .subagent-row:hover > :global(.subagent-open),
  .subagent-row[aria-current='true'] > :global(.subagent-open) {
    color: var(--text-muted);
  }
  .subagent-text {
    flex: 1;
    min-width: 0;
  }
  .subagent-name {
    display: block;
    font-weight: 500;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .subagent-detail {
    display: block;
    margin-top: 1px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .group-note {
    margin: 4px 8px;
  }
  :global(.disclosure) {
    transition: transform var(--duration) var(--ease-out);
  }
  details[open] > summary :global(.disclosure) {
    transform: rotate(180deg);
  }
  @media (max-width: 1000px) {
    .tool-card > summary {
      flex-wrap: wrap;
      gap: 6px;
    }
    .tool-body {
      padding-left: 12px;
    }
    .tool-title {
      min-width: 100px;
    }
  }
</style>
