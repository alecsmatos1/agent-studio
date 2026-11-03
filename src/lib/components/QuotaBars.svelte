<script lang="ts">
  import type { ProviderId } from '$lib/domain';
  import { clock } from '$lib/clock';
  import { quotaPace } from '$lib/pace';
  import { isStale, percentage, resetLabel, visibleLimits, type UsageSnapshot } from '$lib/usage';
  import PaceIndicator from './PaceIndicator.svelte';

  // An account's 5-hour and weekly limits as the compact bars below the composer draw them,
  // for a list of accounts such as the Agent picker: only those its reading reports, waiting as
  // Checking… while its first reading loads. Weekly keeps the second place when the 5-hour
  // limit is not reported, so the lists line up.
  let {
    provider,
    snapshot,
    loading = false,
    failed = false,
  }: {
    provider: ProviderId;
    snapshot?: UsageSnapshot;
    loading?: boolean;
    /** No current reading can be had, so what is shown was only the last reported. */
    failed?: boolean;
  } = $props();
  const limits = $derived.by(() => {
    const now = clock.now;
    // A reading that failed leaves none waiting while it is tried again.
    return visibleLimits(
      snapshot,
      { provider, model: '', reasoning: '', instructions: '' },
      loading && !failed,
    ).map((window) => {
      const pace = quotaPace(window, snapshot, now, failed);
      const stale = !!snapshot && (failed || isStale(snapshot, window, now));
      return {
        ...window,
        pace,
        // A limit without a share used only waits for the account's first reading.
        value: window.usedPercent == null ? 'Checking…' : `${percentage(window.usedPercent)} used`,
        title:
          window.usedPercent == null
            ? undefined
            : `${stale ? 'Last reported. ' : ''}${resetLabel(window.resetsAt, now)}. ${pace.label}.${pace.advice ? ` ${pace.advice}` : ''}`,
      };
    });
  });
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  // Without a limit to show it draws nothing, so the option keeps no room for one.
</script>

{#if limits.length}
  <span class="quota-bars">
    {#each limits as window (window.id)}
      <span
        class="quota-bar"
        class:weekly={window.windowMinutes === 10080}
        class:usage-warning={window.pace.tone === 'watch' || window.pace.tone === 'danger'}
        title={window.title}
      >
        <span class="usage-bar-heading"
          ><span class="quota-label">{window.label}</span><span class="usage-bar-value"
            ><strong>{window.value}</strong>{#if window.pace.state !== 'unknown'}<PaceIndicator
                label={window.pace.label}
                tone={window.pace.tone}
                direction={window.pace.state === 'below'
                  ? 'down'
                  : window.pace.state === 'on-track'
                    ? 'right'
                    : 'up'}
                description={`${window.pace.detail} ${window.pace.advice}`}
              />{/if}</span
          ></span
        >
        <span
          class="usage-meter compact-meter"
          class:unmeasured={window.usedPercent == null}
          class:over-guide={window.pace.expectedPercent != null &&
            window.usedPercent != null &&
            window.usedPercent > window.pace.expectedPercent}
          aria-hidden="true"
        >
          {#if window.usedPercent != null}<i
              class={`quota-fill tone-${window.pace.tone}`}
              style:width={`${clamp(window.usedPercent)}%`}
            ></i>{/if}
          {#if window.pace.expectedPercent != null}<span
              class="recommended-fill"
              style:width={`${clamp(window.pace.expectedPercent)}%`}
            ></span>{/if}
        </span>
      </span>
    {/each}
  </span>
{/if}

<style>
  .quota-bars {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 118px));
    gap: 12px;
    font-size: var(--text-xs);
    font-weight: 400;
  }
  .quota-bar {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .quota-bar.weekly {
    grid-column: 2;
  }
  .quota-label {
    color: var(--text-muted);
  }
  .quota-bar strong {
    color: var(--text-secondary);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .quota-bar.usage-warning strong {
    color: var(--warning);
  }
</style>
