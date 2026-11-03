<script module lang="ts">
  import { createFetchCache, outputSize, type ToolOutput } from '$lib/tool-output';
  import { readToolOutput } from '$lib/transport';
  // Shared by every reply in this window, so reopening a call does not ask the host again.
  const outputs = createFetchCache<ToolOutput>(outputSize);
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { Check, Copy, ImageOff, LoaderCircle, RotateCcw } from '@lucide/svelte';
  import type { ToolActivity } from '$lib/activity';
  import type { Message } from '$lib/domain';
  import { recall } from '$lib/chat-recall';
  import { highlightCode } from '$lib/markdown';
  import { formatBytes, imageLabel, outputLines, type ToolOutputImageInfo } from '$lib/tool-output';
  import { FileViewer as Viewer, type ViewedImage } from '$lib/file-viewer.svelte';
  import { fileLanguage, primaryCommand } from '$lib/tool-presentation';
  import ToolResultImage from './ToolResultImage.svelte';
  import FileViewer from './FileViewer.svelte';

  let {
    tool,
    runId,
    connectionId,
    replyStatus,
    scope,
  }: {
    tool: ToolActivity;
    runId?: string;
    connectionId?: string;
    replyStatus: Message['status'];
    /** Names the call within its chat, which recalls how far the reader opened its result. */
    scope?: string;
  } = $props();
  const remembered = recall(() => scope);

  const shells = {
    bash: 'Bash',
    sh: 'Shell',
    zsh: 'Zsh',
    powershell: 'PowerShell',
    cmd: 'Command Prompt',
  };
  const prompts = { bash: '$', sh: '$', zsh: '%', powershell: 'PS>', cmd: '>' };
  const summary = $derived(tool.output);
  const empty = $derived(!!summary && !summary.bytes && !summary.images);
  const fileRead = $derived(tool.operation === 'read');
  const running = $derived(tool.status === 'running' && replyStatus === 'running');
  const failed = $derived(
    tool.status === 'error' || (summary?.exitCode != null && summary.exitCode !== 0),
  );

  let output = $state<ToolOutput>();
  let error = $state('');
  let loading = $state(false);
  let attempt = $state(0);
  let full = $state(remembered.get<boolean>('full') ?? false);
  // Only the call and its run select a result; revisions and relay updates do not reload it.
  // A shortened command or input comes whole from the same result.
  const key = $derived(
    runId && summary && (!empty || tool.commandTruncated || tool.inputTruncated)
      ? `${runId}\n${tool.id}\n${full}`
      : '',
  );
  $effect(() => {
    const current = key;
    void attempt;
    if (!current) return;
    let live = true;
    loading = true;
    error = '';
    untrack(() =>
      outputs.get(current, () => readToolOutput(runId!, tool.id, connectionId, full)),
    ).then(
      (value) => {
        if (!live) return;
        output = value;
        loading = false;
      },
      (reason) => {
        if (!live) return;
        error = String(reason instanceof Error ? reason.message : reason);
        loading = false;
      },
    );
    return () => {
      live = false;
    };
  });

  const command = $derived(output?.command ?? tool.command);
  const commandShortened = $derived(!!tool.commandTruncated && !output?.command);
  // Lines a CLI hook put before the model's command are shown, but quietly.
  const commandParts = $derived.by(() => {
    if (!command) return;
    const lines = command.split('\n');
    const first = lines.findIndex((line) => line.trim() === primaryCommand(command).line);
    const hooks = first > 0 ? lines.slice(0, first).join('\n').trim() : '';
    const body = first > 0 ? lines.slice(first).join('\n') : command;
    const language =
      tool.shell === 'powershell' ? 'powershell' : tool.shell === 'cmd' ? '' : 'bash';
    return { hooks, body, highlighted: highlightCode(body, language) };
  });
  const input = $derived.by(() => {
    const text = output?.input ?? tool.input;
    if (!text) return;
    let json = false;
    try {
      JSON.parse(text);
      json = true;
    } catch {
      /* Plain text input stays unhighlighted. */
    }
    return {
      text,
      shortened: !!tool.inputTruncated && !output?.input,
      highlighted: json ? highlightCode(text, 'json') : null,
    };
  });
  const meta = $derived.by(() => {
    if (!summary) return '';
    if (empty) return 'No output';
    const lines = `${summary.lines.toLocaleString()} ${summary.lines === 1 ? 'line' : 'lines'}`;
    const images = summary.images
      ? `${summary.images} ${summary.images === 1 ? 'image' : 'images'}`
      : '';
    return [summary.lines || !images ? lines : '', images].filter(Boolean).join(' · ');
  });

  const stdout = $derived(output?.stdout.text ?? '');
  const stderr = $derived(output?.stderr.text ?? '');
  const stdoutLines = $derived(outputLines(stdout));
  const language = $derived(fileRead ? fileLanguage(tool.path) : undefined);
  const highlighted = $derived(
    output && language && output.stdout.complete && stdoutLines.length <= 3000
      ? highlightCode(stdout, language)
      : null,
  );
  // Line numbers need the whole text; a preview's hidden middle would shift them.
  const gutter = $derived.by(() => {
    if (!fileRead || output?.startLine == null || !output.stdout.complete || !stdoutLines.length)
      return '';
    const start = output.startLine;
    return stdoutLines.map((_, index) => start + index).join('\n');
  });
  const partial = $derived(!!output && (!output.stdout.complete || !output.stderr.complete));
  const kept = $derived((output?.stdout.bytes ?? 0) + (output?.stderr.bytes ?? 0));
  // A long result starts in a box of about 18 lines that scrolls.
  const tall = $derived(stdoutLines.length + outputLines(stderr).length > 18);
  let expanded = $state(remembered.get<boolean>('expanded') ?? false);

  let copied = $state('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
    } catch {
      copied = '';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = ''), 1500);
  }

  // A call's images open full size in a viewer of their own, which steps through them.
  const images = new Viewer();
  function viewed(info: ToolOutputImageInfo): ViewedImage {
    return {
      kind: 'image',
      runId: runId!,
      toolId: tool.id,
      connectionId,
      info,
      name: tool.path ?? tool.name,
      label: imageLabel(info),
      alt: `Full size image returned by ${tool.name}`,
    };
  }
</script>

{#snippet copyButton(label: string, text: string)}
  <button
    type="button"
    class="result-action"
    aria-label={`Copy ${label.toLowerCase()}`}
    title={`Copy ${label.toLowerCase()}`}
    onclick={() => copy(label, text)}
    >{#if copied === label}<Check size={12} aria-hidden="true" />Copied{:else}<Copy
        size={12}
        aria-hidden="true"
      />Copy{/if}</button
  >
{/snippet}

<div class="tool-result" data-testid="tool-result">
  <!-- Command, input and output read as one transcript of the call. -->
  {#if commandParts || input || summary}<div class="result-panel">
      {#if commandParts}
        <section class="result-section" aria-label="Command">
          <div class="result-bar">
            <span class="result-title">{tool.shell ? shells[tool.shell] : 'Command'}</span>
            {#if commandShortened}<span class="result-meta">Shortened</span>{/if}
            <span class="bar-space"></span>
            {@render copyButton('Command', command!)}
          </div>
          <!-- Commands scroll inside their box; keyboard users can focus it. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="result-scroll command-scroll"
            tabindex="0"
            role="region"
            aria-label="Command text"
          >
            {#if commandParts.hooks}<pre
                class="hook-lines"
                title="Added by a configured CLI hook">{commandParts.hooks}</pre>{/if}
            <pre class="command-text hljs"><span class="prompt" aria-hidden="true"
                >{tool.shell ? prompts[tool.shell] : '$'}</span
              ><code
                >{#if commandParts.highlighted}{@html commandParts.highlighted
                    .html}{:else}{commandParts.body}{/if}</code
              ></pre>
          </div>
        </section>
      {/if}
      {#if input}
        <section class="result-section" aria-label="Input">
          <div class="result-bar">
            <span class="result-title">Input</span>
            {#if input.shortened}<span class="result-meta">Shortened</span>{/if}
            <span class="bar-space"></span>
            {@render copyButton('Input', input.text)}
          </div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="result-scroll" tabindex="0" role="region" aria-label="Input text">
            <pre class="result-text hljs"><code
                >{#if input.highlighted}{@html input.highlighted.html}{:else}{input.text}{/if}</code
              ></pre>
          </div>
        </section>
      {/if}
      {#if summary}
        <section class="result-section" aria-label={fileRead ? 'File content' : 'Output'}>
          <div class="result-bar">
            <span class="result-title">{fileRead ? 'File content' : 'Output'}</span>
            <span class="result-meta">{meta}</span>
            {#if summary.exitCode != null}<span
                class="exit-code"
                class:failed={summary.exitCode !== 0}
                title="Exit code reported by the provider">Exit code {summary.exitCode}</span
              >{/if}
            <span class="bar-space"></span>
            {#if output && (stdout || stderr)}
              {#if tall}<button
                  type="button"
                  class="result-action"
                  aria-expanded={expanded}
                  onclick={() => {
                    expanded = !expanded;
                    remembered.set('expanded', expanded || undefined);
                  }}>{expanded ? 'Show less' : 'Show all'}</button
                >{/if}
              {@render copyButton(
                'Output',
                [stdout, stderr].filter(Boolean).join(stdout.endsWith('\n') ? '' : '\n'),
              )}
            {/if}
          </div>
          {#if !runId && !empty}
            <p class="result-note">Output unavailable for this reply.</p>
          {:else if loading && !output}
            <p class="result-note" role="status">
              <LoaderCircle size={13} class="spinning" aria-hidden="true" />Loading output…
            </p>
          {:else if error && !output}
            <p class="result-note failed" role="alert">
              {error}
              <button type="button" class="result-action" onclick={() => attempt++}
                ><RotateCcw size={12} aria-hidden="true" />Retry</button
              >
            </p>
          {:else if output}
            {#if stdout}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="result-scroll"
                class:expanded
                tabindex="0"
                role="region"
                aria-label={fileRead ? 'File content text' : 'Output text'}
              >
                <div class="code-view">
                  {#if gutter}<pre class="gutter" aria-hidden="true">{gutter}</pre>{/if}
                  <pre class="result-text hljs"><code
                      >{#if highlighted}{@html highlighted.html}{:else}{stdout}{/if}</code
                    ></pre>
                </div>
              </div>
            {/if}
            {#if stderr}
              <!-- Tools also write warnings and notes to standard error; only a failure is red. -->
              <div class="stream-label" class:failed>Standard error</div>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="result-scroll"
                class:expanded
                tabindex="0"
                role="region"
                aria-label="Error output text"
              >
                <pre class="result-text stderr" class:failed>{stderr}</pre>
              </div>
            {/if}
            {#if partial}<p class="result-note">
                {#if full}Showing the first and last 8 MB of each stream.
                {:else}Showing the first and last part of {formatBytes(kept)}.
                  <button
                    type="button"
                    class="result-action"
                    disabled={loading}
                    onclick={() => {
                      full = true;
                      remembered.set('full', true);
                    }}
                    >{#if loading}<LoaderCircle
                        size={12}
                        class="spinning"
                        aria-hidden="true"
                      />{/if}Show full output</button
                  >{/if}
              </p>{/if}
            {#if error}<p class="result-note failed" role="alert">
                {error}
                <button type="button" class="result-action" onclick={() => attempt++}
                  ><RotateCcw size={12} aria-hidden="true" />Retry</button
                >
              </p>{/if}
            {#if output.images.length}
              <div class="result-images">
                {#each output.images as info (info.index)}
                  <div class="result-image-place" {@attach images.attach(() => viewed(info))}>
                    <ToolResultImage
                      runId={runId!}
                      toolId={tool.id}
                      {connectionId}
                      {info}
                      name={tool.name}
                      open={(from) => images.open(from)}
                    />
                  </div>
                {/each}
              </div>
            {/if}
            {#if output.imagesOmitted}<p class="result-note">
                <ImageOff size={13} aria-hidden="true" />{output.imagesOmitted}
                {output.imagesOmitted === 1 ? 'image was' : 'images were'} not kept: unreadable or not
                a supported image type.
              </p>{/if}
            {#if output.truncated}<p class="result-note">
                The provider shortened this result before returning it.
              </p>{/if}
            {#if !stdout && !stderr && !output.images.length && !empty}<p class="result-note">
                No output.
              </p>{/if}
          {/if}
        </section>
      {:else if tool.command && running && !tool.background}
        <p class="result-note">The output appears when the command finishes.</p>
      {:else if tool.command && tool.status !== 'running' && !tool.background}
        <p class="result-note">Output was not recorded for this call.</p>
      {/if}
    </div>{/if}
</div>

<FileViewer viewer={images} />

<style>
  .tool-result {
    margin: 8px 0 4px;
    min-width: 0;
  }
  .result-panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--code-bg);
    overflow: hidden;
  }
  .result-section {
    min-width: 0;
  }
  .result-panel > * + * {
    border-top: 1px solid var(--border);
  }
  .result-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    min-height: 28px;
    padding: 3px 6px 3px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .result-title {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .result-meta {
    font-variant-numeric: tabular-nums;
  }
  .bar-space {
    flex: 1;
  }
  .exit-code {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--success-soft);
    color: var(--success);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 17px;
    font-variant-numeric: tabular-nums;
  }
  .exit-code.failed {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .result-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .result-action:hover {
    background: var(--hover);
    color: var(--text);
  }
  .result-scroll {
    max-height: 342px;
    overflow: auto;
  }
  .result-scroll.expanded {
    max-height: none;
  }
  .command-scroll {
    max-height: 200px;
  }
  pre {
    margin: 0;
    font: 12px/1.6 var(--font-mono);
    tab-size: 4;
    color: var(--code-text);
  }
  pre code {
    font: inherit;
    background: none;
    border: 0;
    padding: 0;
  }
  .command-text {
    padding: 8px 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .prompt {
    margin-right: 8px;
    color: var(--accent-text);
    user-select: none;
  }
  .hook-lines {
    padding: 8px 12px 0;
    color: var(--text-faint);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .code-view {
    display: flex;
    min-width: min-content;
  }
  .gutter {
    position: sticky;
    left: 0;
    flex: 0 0 auto;
    padding: 8px 10px 8px 12px;
    text-align: right;
    color: var(--text-faint);
    background: var(--code-bg);
    user-select: none;
  }
  .result-text {
    flex: 1 0 auto;
    padding: 8px 12px;
    white-space: pre;
  }
  .gutter + .result-text {
    padding-left: 4px;
  }
  .result-text.stderr {
    color: var(--text-secondary);
  }
  .result-text.stderr.failed {
    color: var(--diff-remove-text);
  }
  .stream-label {
    padding: 4px 12px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-muted);
    background: var(--surface-1);
  }
  .stream-label.failed {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .result-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 8px 12px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .result-section .result-note + .result-note {
    padding-top: 0;
  }
  .result-note.failed {
    color: var(--danger);
  }
  .result-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px;
  }
  .result-image-place {
    display: contents;
  }
</style>
