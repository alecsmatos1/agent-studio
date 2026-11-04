<script lang="ts">
  import { onMount } from 'svelte';
  import { Power } from '@lucide/svelte';
  import { timeLeft } from '$lib/shutdown-watch';
  import type { ShutdownWatch } from '$lib/shutdown-watch.svelte';

  let { watch, onerror }: { watch: ShutdownWatch; onerror: (message: string) => void } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;
  let cancelButton: HTMLButtonElement;

  // Cancel takes focus, so a key pressed by chance keeps the computer on.
  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    cancelButton.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  });
  // The computer is turning off: nothing is left to cancel.
  const asked = $derived(watch.state.phase === 'shutting' && watch.state.asked);
  const title = $derived(
    watch.state.phase === 'counting'
      ? `Shutting down in ${timeLeft(watch.state.until, watch.now)}`
      : 'Shutting down…',
  );
  function cancel() {
    void watch.cancel().catch((e) => onerror(String(e).replace(/^Error: /, '')));
  }
</script>

<dialog
  bind:this={dialog}
  class="shutdown-countdown"
  role="alertdialog"
  aria-labelledby="{id}-title"
  aria-describedby="{id}-text"
  oncancel={(event) => {
    event.preventDefault();
    if (!asked) cancel();
  }}
>
  <h2 id="{id}-title"><Power size={18} aria-hidden="true" /><span>{title}</span></h2>
  <p id="{id}-text">All chats finished. Unsaved work in other apps will be lost.</p>
  <footer>
    <button class="secondary" bind:this={cancelButton} disabled={asked} onclick={cancel}
      >Cancel</button
    ><button
      class="danger"
      disabled={watch.state.phase !== 'counting'}
      onclick={() => watch.shutDownNow()}>Shut down now</button
    >
  </footer>
</dialog>

<style>
  dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 24px;
    color: var(--text);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-xl);
  }
  dialog[open] {
    animation: countdown-in var(--duration) ease;
  }
  dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 10px;
    font-size: var(--text-xl);
    letter-spacing: var(--tracking-tighter);
    font-variant-numeric: tabular-nums;
  }
  h2 :global(svg) {
    flex-shrink: 0;
    color: var(--danger);
  }
  p {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    color: var(--text-secondary);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 22px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  @keyframes countdown-in {
    from {
      opacity: 0;
    }
  }
  @media (max-width: 600px) {
    dialog {
      padding: 18px;
    }
  }
</style>
