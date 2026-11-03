<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { X, Download, RotateCcw, Code, Eye, PanelRightOpen, Maximize2 } from '@lucide/svelte';
  import type { Artifact } from '$lib/artifacts';
  import { artifactFilename } from '$lib/artifacts';
  import { visualizationPreview } from '$lib/visualization-preview';
  import { appearance } from '$lib/appearance.svelte';
  import { recall } from '$lib/chat-recall';
  import { highlightCode } from '$lib/markdown';
  import { pageScrollReport, type PageScroll } from '$lib/page-scroll';
  import { panelRoom, showPanel } from '$lib/side-panels';
  import { artifactPreviewUrl, downloadArtifact } from '$lib/transport';
  import PanelResize from './PanelResize.svelte';
  let {
    artifact,
    mode = 'modal',
    takeFocus = true,
    changeMode,
    close,
  }: {
    artifact: Artifact;
    mode?: 'modal' | 'panel';
    /** False for a side panel shown again with its chat. */
    takeFocus?: boolean;
    changeMode: (mode: 'modal' | 'panel') => void;
    close: () => void;
  } = $props();
  let viewportWidth = $state(0);
  let workspaceWidth = $state(0);
  let panelWidth = $state<number>();
  const docked = $derived(mode === 'panel' && viewportWidth >= 1100 && workspaceWidth >= 780);
  // How the reader left the artifact in its chat: its tab, and where its page and its source
  // were scrolled (`src/lib/chat-recall.ts`). Closing it forgets them.
  const remembered = recall(() => `artifact/${artifact.id}`);
  let tab = $state<'preview' | 'source'>(remembered.get('tab') ?? 'preview');
  $effect(() => remembered.set('tab', tab === 'source' ? tab : undefined));
  const highlightedSource = $derived(
    tab === 'source' ? highlightCode(artifact.source, artifact.language) : null,
  );
  let url = $state('');
  let error = $state('');
  let downloadStatus = $state('');
  async function download() {
    try {
      const path = await downloadArtifact(
        artifact.source,
        artifactFilename(artifact),
        artifact.language,
      );
      downloadStatus = path ? 'Saved to Downloads.' : 'Download started.';
    } catch (e) {
      downloadStatus = `Download failed: ${String(e)}`;
    }
  }
  let revision = $state(0);
  let dialog = $state<HTMLDialogElement>();
  let mounted = $state(false);
  let shown = false;
  $effect(() => {
    if (!mounted || !dialog) return;
    const dock = docked;
    const box = dialog;
    // Keep the same sandboxed iframe when changing presentation.
    untrack(() => showPanel(box, dock, '[aria-label="Close artifact"]', !shown && !takeFocus));
    shown = true;
    untrack(placeSource);
  });
  // Closing returns focus to what had it when the viewer opened; hidden with its chat, the
  // viewer leaves focus where the reader moved it.
  let dismissed = false;
  function dismiss() {
    dismissed = true;
    remembered.clear();
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
    // A visual keeps its offline renderer; an artifact page may load pinned CDN libraries.
    void artifactPreviewUrl(artifact.visualization ? 'frame' : 'page')
      .then((value) => (url = value))
      .catch(() => (error = 'Could not open the artifact preview. The source is still available.'));
    return () => {
      observer.disconnect();
      if (dismissed && focused?.isConnected) focused.focus();
    };
  });
  // Where the preview last said the reader scrolled the page, which it opens at each time it
  // loads: shown again with its chat, after Restart preview and in a newer revision.
  let pageScroll = remembered.get<PageScroll[]>('page') ?? [];
  let frame: HTMLIFrameElement | undefined;
  let scrollToken = '';
  function initialize(event: Event) {
    // Send once to the constant renderer; this expanded viewer hears from it only where the
    // reader scrolls the page, under the token of this loading.
    const target = event.currentTarget as HTMLIFrameElement;
    if (target.dataset.initialized) return;
    target.dataset.initialized = 'true';
    frame = target;
    scrollToken = crypto.randomUUID();
    const scroll = { scrollToken, scroll: pageScroll };
    target.contentWindow?.postMessage(
      artifact.visualization
        ? { ...visualizationPreview(artifact.source, undefined, appearance.resolved), ...scroll }
        : { type: 'studio-artifact', source: artifact.source, ...scroll },
      '*',
    );
  }
  function heard(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    const places = pageScrollReport(event.data, scrollToken);
    if (!places) return;
    pageScroll = places;
    remembered.set('page', places.length ? places : undefined);
  }
  // The source scrolls in the content area, and opens where the reader left it.
  let content = $state<HTMLDivElement>();
  function contentScrolled() {
    if (tab === 'source' && content)
      remembered.set('source', { x: content.scrollLeft, y: content.scrollTop });
  }
  // A closed dialog has nothing to scroll: the source is placed once the viewer shows it.
  function placeSource() {
    const left = remembered.get<{ x: number; y: number }>('source');
    if (tab !== 'source' || !content || !dialog?.open || !left) return;
    content.scrollLeft = left.x;
    content.scrollTop = left.y;
  }
  $effect(() => {
    void [tab, highlightedSource];
    untrack(placeSource);
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} onmessage={heard} />
<!-- Docked, the gap between the chat and the panel resizes it. -->
{#if docked}<PanelResize
    gutter={12}
    availableWidth={workspaceWidth}
    onresize={(width) => (panelWidth = width)}
    storageKey="agent-studio.artifact-panel-width"
    label="Resize artifact panel"
    controls="artifact-viewer"
  />{/if}
<dialog
  bind:this={dialog}
  id="artifact-viewer"
  class="artifact-viewer"
  style:--artifact-panel-width={panelWidth ? `${panelWidth}px` : undefined}
  class:side-panel={mode === 'panel'}
  class:docked
  aria-modal={docked ? undefined : 'true'}
  aria-labelledby="artifact-title"
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
    <div>
      <span class="eyebrow">Artifact</span>
      <h2 id="artifact-title">{artifact.title}</h2>
    </div>
    <div class="viewer-actions">
      <button
        class="icon-button"
        onclick={() => changeMode(mode === 'panel' ? 'modal' : 'panel')}
        aria-label={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        title={mode === 'panel' ? 'Open in modal' : 'Open in side panel'}
        >{#if mode === 'panel'}<Maximize2 size={17} />{:else}<PanelRightOpen
            size={17}
          />{/if}</button
      >
      <button class="icon-button" onclick={dismiss} aria-label="Close artifact"
        ><X size={19} /></button
      >
    </div>
  </header>
  <div class="artifact-toolbar">
    <div role="tablist" aria-label="Artifact view">
      {#each ['preview', 'source'] as item, index}<button
          role="tab"
          aria-selected={tab === item}
          tabindex={tab === item ? 0 : -1}
          onclick={() => (tab = item as typeof tab)}
          onkeydown={async (event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              tab =
                event.key === 'Home'
                  ? 'preview'
                  : event.key === 'End'
                    ? 'source'
                    : tab === 'preview'
                      ? 'source'
                      : 'preview';
              await tick();
              dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            }
          }}
          >{#if index === 0}<Eye size={14} />{:else}<Code size={14} />{/if}{index === 0
            ? 'Preview'
            : 'Source'}</button
        >{/each}
    </div>
    <button
      class="text-button"
      onclick={() => revision++}
      title="Restart preview"
      aria-label="Restart preview"><RotateCcw size={14} /></button
    >
    <button class="secondary" onclick={download}><Download size={14} />Download</button>
  </div>
  <div
    class="artifact-content"
    class:visualization-preview={artifact.visualization && tab === 'preview'}
    bind:this={content}
    onscroll={contentScrolled}
    role="tabpanel"
    aria-label={tab === 'preview' ? 'Artifact preview' : 'Artifact source'}
  >
    {#if tab === 'preview'}
      {#if error}<p role="alert">
          {error}
        </p>{:else if url}{#key `${artifact.id}:${artifact.revision ?? 0}:${revision}:${artifact.visualization ? appearance.resolved : ''}`}<iframe
            title={`${artifact.title} preview`}
            src={url}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onload={initialize}
          ></iframe>{/key}{:else}<p>Loading preview…</p>{/if}
    {:else}<pre><code class="hljs"
          >{#if highlightedSource}{@html highlightedSource.html}{:else}{artifact.source}{/if}</code
        ></pre>{/if}
  </div>
  <footer>
    <span role="status">{downloadStatus}</span>
  </footer>
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-xl);
    padding: 0;
    width: min(1100px, calc(100vw - 32px));
    height: min(850px, calc(100dvh - 32px));
    max-width: none;
    max-height: none;
    overflow: hidden;
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
  dialog.side-panel {
    top: var(--mobile-top, 0px);
    margin: 0 0 0 auto;
    width: min(620px, 100vw);
    height: var(--mobile-height, 100dvh);
    border-radius: 0;
    border-width: 0 0 0 1px;
  }
  dialog.docked {
    position: relative;
    inset: auto;
    align-self: stretch;
    flex: 0 0 var(--artifact-panel-width, 42%);
    width: var(--artifact-panel-width, 42%);
    min-width: 360px;
    height: auto;
    min-height: 0;
    margin: 0;
    border: 0;
    border-left: 1px solid var(--border);
    border-radius: 0;
    box-shadow: none;
    background: var(--bg-sidebar);
  }
  .viewer-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 12px 20px;
    gap: 12px;
  }
  header > div {
    min-width: 0;
  }
  h2 {
    font-size: var(--text-lg);
    margin: 2px 0 0;
    overflow-wrap: anywhere;
  }
  .artifact-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    border-block: 1px solid var(--border);
    padding: 8px 14px;
  }
  [role='tablist'] {
    display: flex;
    gap: 2px;
    flex: 1;
  }
  [role='tab'] {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  [role='tab']:not(:disabled):hover {
    background: var(--hover);
  }
  [aria-selected='true'],
  [aria-selected='true']:not(:disabled):hover {
    background: var(--active);
    color: var(--text);
  }
  .artifact-toolbar .text-button {
    width: var(--control-md);
    height: var(--control-md);
    padding: 0;
    border-radius: var(--radius-md);
    color: var(--text-muted);
  }
  .artifact-toolbar .text-button:not(:disabled):hover {
    background: var(--hover);
    color: var(--text);
  }
  .artifact-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--artifact-canvas);
    color: var(--artifact-ink);
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .visualization-preview {
    background: var(--bg);
    color: var(--text);
    padding: 16px;
  }
  pre {
    margin: 0;
    padding: 20px;
    font-size: 12.5px;
    line-height: 1.65;
    tab-size: 2;
    min-height: 100%;
    box-sizing: border-box;
    background: var(--code-bg);
    color: var(--code-text);
  }
  footer {
    padding: 0 16px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  footer > span:not(:empty) {
    display: block;
    padding: 9px 0;
  }
  @media (max-width: 600px) {
    dialog {
      width: calc(100vw - 12px);
      height: calc(100dvh - 12px);
      border-radius: var(--radius-xl);
    }
    header {
      padding: 12px;
    }
    .artifact-toolbar {
      padding: 8px;
      gap: 6px;
    }
  }
</style>
