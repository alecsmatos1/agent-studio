<script lang="ts">
  import { onMount } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';
  import type { ProviderId } from '$lib/domain';
  import { quotaPace } from '$lib/pace';
  import {
    accountLimits,
    isStale,
    percentage,
    resetLabel,
    resetTime,
    type UsageSnapshot,
  } from '$lib/usage';
  import PaceIndicator from './PaceIndicator.svelte';
  import CreditUsage from './CreditUsage.svelte';
  import AccountControls from './AccountControls.svelte';

  let {
    provider,
    connectionId,
    name,
    snapshot,
    loading,
    error,
    unavailable = '',
  }: {
    provider: ProviderId;
    connectionId?: string;
    name: string;
    snapshot?: UsageSnapshot;
    loading: boolean;
    error: string;
    unavailable?: string;
  } = $props();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });
  // Only the limits a reading reports show. Until the account's first reading, which a connected
  // account is about to have, the limits it may have wait as Checking…, though not while one
  // that failed is tried again.
  const limits = $derived(
    accountLimits(snapshot, provider, !error && (loading || (!snapshot && !unavailable))).map(
      (window) => ({
        ...window,
        pace: quotaPace(window, snapshot, now, !!error || !!unavailable),
      }),
    ),
  );
  const stale = $derived(
    !!snapshot && (!!error || !!unavailable || limits.some((w) => isStale(snapshot, w, now))),
  );
  const checked = $derived(snapshot ? new Date(snapshot.checkedAt * 1000) : null);
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
</script>

<section class="account-usage" aria-label={`Usage for ${name}`} aria-busy={loading}>
  <div class="account-usage-heading">
    <span>Usage</span>
    <span class="reading-status" role="status" title={checked?.toLocaleString()}>
      {#if loading}<LoaderCircle size={12} class="spinning" />{snapshot
          ? 'Updating…'
          : 'Checking usage…'}
      {:else if stale}Last reported
      {:else if checked}Checked {checked.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
      {:else}No reading yet{/if}
    </span>
  </div>
  {#if !unavailable || snapshot}
    <div class="account-limits">
      {#each limits as window (window.id)}
        <div class="account-limit" aria-label={`${window.label} usage`}>
          <div class="limit-heading">
            <span>{window.label}</span>
            <strong
              >{window.usedPercent == null
                ? 'Checking…'
                : `${percentage(window.usedPercent)} used`}</strong
            >
            <PaceIndicator
              label={window.pace.label}
              tone={window.pace.tone}
              direction={window.pace.state === 'below'
                ? 'down'
                : window.pace.state === 'on-track'
                  ? 'right'
                  : window.pace.state === 'unknown'
                    ? 'unknown'
                    : 'up'}
              description={`${window.pace.detail} ${window.pace.advice}`}
            />
          </div>
          <div
            class="usage-meter compact-meter"
            class:unmeasured={window.usedPercent == null}
            class:over-guide={window.pace.expectedPercent != null &&
              window.usedPercent != null &&
              window.usedPercent > window.pace.expectedPercent}
            role="progressbar"
            aria-label={`${window.label} limit used`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={window.usedPercent == null ? undefined : clamp(window.usedPercent)}
            aria-valuetext={window.usedPercent == null
              ? 'Checking usage'
              : `${percentage(window.usedPercent)} used${window.pace.expectedPercent == null ? '' : `, recommended ${percentage(window.pace.expectedPercent)}`}${stale ? ', last reported' : ''}`}
            title={window.usedPercent == null
              ? undefined
              : window.pace.expectedPercent == null
                ? window.pace.detail
                : `${percentage(window.usedPercent)} used; recommended ${percentage(window.pace.expectedPercent)} at the time of this reading.`}
          >
            {#if window.usedPercent != null}<i
                class={`quota-fill tone-${window.pace.tone}`}
                style:width={`${clamp(window.usedPercent)}%`}
              ></i>{/if}
            {#if window.pace.expectedPercent != null}<span
                class="recommended-fill"
                style:width={`${clamp(window.pace.expectedPercent)}%`}
                aria-hidden="true"
              ></span>{/if}
          </div>
          {#if window.usedPercent != null}<div class="limit-meta">
              <span
                title={resetTime(window.resetsAt)
                  ? new Date(resetTime(window.resetsAt)!).toLocaleString()
                  : undefined}>{resetLabel(window.resetsAt, now)}</span
              >
              {#if window.pace.allowance != null && window.pace.state !== 'exhausted'}<span
                  title="Remaining share of the full limit available per hour or day until reset."
                  >Budget {percentage(window.pace.allowance)}/{window.pace.allowanceUnit}</span
                >{/if}
            </div>{/if}
          {#if window.pace.state === 'exhausted'}<p class={`limit-advice tone-${window.pace.tone}`}>
              {window.pace.advice}
            </p>{/if}
        </div>
      {/each}
      <CreditUsage {provider} {snapshot} {loading} {stale} />
    </div>
  {/if}
  <AccountControls {provider} {connectionId} {name} {snapshot} disabled={!!unavailable} />
  {#if unavailable || error}<p class="usage-note" role="status">
      {unavailable || error}
    </p>
  {:else if !loading && snapshot && !snapshot.partial && !limits.length}<p class="usage-note">
      No limits reported.
    </p>{/if}
</section>

<style>
  .account-usage {
    min-width: 0;
    container-type: inline-size;
  }
  .account-usage-heading,
  .reading-status,
  .limit-heading,
  .limit-meta {
    display: flex;
    align-items: center;
  }
  .account-usage-heading {
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .reading-status {
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-faint);
  }
  .account-limits {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 28px;
  }
  .account-limit {
    min-width: 0;
  }
  .limit-heading {
    gap: 8px;
    margin-bottom: 8px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .limit-heading > span {
    flex: 1;
  }
  .limit-heading strong {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .limit-meta {
    justify-content: space-between;
    gap: 5px 12px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-snug);
  }
  .usage-note,
  .limit-advice {
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    margin: 8px 0 0;
  }
  .limit-advice {
    color: var(--pace-ink);
  }
  .usage-note {
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  @container (max-width: 450px) {
    .account-limits {
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
  }
</style>
