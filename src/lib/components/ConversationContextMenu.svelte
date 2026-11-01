<script lang="ts">
  import { onMount } from 'svelte';
  import { AlarmClock, AlarmClockOff, GitFork, Pin, PinOff, Trash2 } from '@lucide/svelte';

  let {
    x,
    y,
    name,
    trigger,
    close,
    remove,
    removeLabel = 'Delete conversation',
    fork,
    forkDisabled = false,
    snooze,
    snoozed = false,
    snoozeDisabled = false,
    pin,
    pinned = false,
  }: {
    x: number;
    y: number;
    name: string;
    trigger: HTMLElement;
    close: (restoreFocus?: boolean) => void;
    remove: () => void;
    removeLabel?: string;
    // Scratch chats have nothing to fork.
    fork?: () => void;
    forkDisabled?: boolean;
    // Snoozes the chat until the app restarts, or ends its snooze when `snoozed`.
    snooze?: () => void;
    snoozed?: boolean;
    snoozeDisabled?: boolean;
    // Pins the chat to the top of its tab, or unpins it when `pinned`.
    pin?: (event: MouseEvent) => void;
    pinned?: boolean;
  } = $props();
  let menu: HTMLDivElement;

  onMount(() => {
    menu.showPopover();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 8, Math.min(x, left + width - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const dismiss = () => close();
    const scroll = (event: Event) => {
      if (
        event.target === document ||
        (event.target instanceof Element && event.target.contains(trigger))
      )
        close();
    };
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    viewport?.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('resize', dismiss);
    };
  });

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    }
  }
</script>

<svelte:document
  onpointerdown={(event) => {
    if (menu && !menu.contains(event.target as Node)) close();
  }}
/>

<div
  class="conversation-context-menu"
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${name}`}
  popover="manual"
  bind:this={menu}
  onkeydown={keyboard}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#if fork}<button
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={fork}
      disabled={forkDisabled}
      title={forkDisabled
        ? 'A finished reply is needed to fork this conversation'
        : 'Start a separate chat from the finished replies'}
      ><GitFork size={15} aria-hidden="true" />Fork conversation</button
    >{/if}
  {#if snooze}<button
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={snooze}
      disabled={snoozeDisabled}
      title={snoozed ? undefined : 'Until the app restarts'}
      >{#if snoozed}<AlarmClockOff size={15} aria-hidden="true" />Cancel snooze{:else}<AlarmClock
          size={15}
          aria-hidden="true"
        />Snooze{/if}</button
    >{/if}
  {#if pin}<button type="button" role="menuitem" tabindex="-1" onclick={pin}
      >{#if pinned}<PinOff size={15} aria-hidden="true" />Unpin{:else}<Pin
          size={15}
          aria-hidden="true"
        />Pin{/if}</button
    >{/if}
  <button class="danger" type="button" role="menuitem" tabindex="-1" onclick={remove}
    ><Trash2 size={15} aria-hidden="true" />{removeLabel}</button
  >
</div>

<style>
  .conversation-context-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 5px;
    width: 210px;
    max-width: calc(100vw - 16px);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-lg);
  }
  .conversation-context-menu:popover-open {
    animation: fade-in var(--duration-fast) ease;
  }
  button {
    width: 100%;
    min-height: 32px;
    padding: 6px 9px;
    justify-content: flex-start;
    gap: 9px;
    border-radius: var(--radius-sm);
    font-size: var(--text-base);
    color: var(--text);
    white-space: nowrap;
  }
  button :global(svg) {
    color: var(--text-muted);
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--active);
    outline: none;
  }
  button.danger {
    min-height: 32px;
    padding: 6px 9px;
    border: 0;
    background: transparent;
    color: var(--danger);
    font-weight: 400;
  }
  button.danger :global(svg) {
    color: currentColor;
  }
  button.danger:hover:not(:disabled),
  button.danger:focus-visible {
    background: var(--danger-soft);
    color: var(--danger);
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
