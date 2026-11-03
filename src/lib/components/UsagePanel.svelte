<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import PaceIndicator from './PaceIndicator.svelte';
  import CreditUsage from './CreditUsage.svelte';
  import AccountControls from './AccountControls.svelte';
  import ChatSpend from './ChatSpend.svelte';
  import CompactionControls from './CompactionControls.svelte';
  import { providers, type ChatSettings, type Conversation } from '$lib/domain';
  import type { ModelInfo } from '$lib/models';
  import { contextPace, quotaPace } from '$lib/pace';
  import {
    compactTokens,
    creditReading,
    contextFor,
    isStale,
    percentage,
    resetLabel,
    resetTime,
    visibleLimits,
    type UsageSnapshot,
  } from '$lib/usage';
  let {
    conversation,
    settings,
    model,
    snapshot,
    loading,
    error,
    preview = false,
    accountName = 'this Codex account',
    accountUnavailable = false,
    expanded = $bindable(false),
    canCompact = false,
    compact = () => {},
    changeAutoCompact = () => {},
    compactionSettingsDisabled = false,
  }: {
    conversation?: Conversation;
    settings: ChatSettings;
    model: ModelInfo;
    snapshot?: UsageSnapshot;
    loading: boolean;
    error: string;
    preview?: boolean;
    accountName?: string;
    accountUnavailable?: boolean;
    expanded?: boolean;
    canCompact?: boolean;
    compact?: () => void;
    changeAutoCompact?: (tokens?: number) => void;
    compactionSettingsDisabled?: boolean;
  } = $props();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 15000);
    return () => clearInterval(timer);
  });
  const context = $derived(contextFor(conversation, settings, '', model, snapshot));
  const credits = $derived(creditReading(settings.provider, snapshot));
  // Only the limits a reading reports, which wait as Checking… while a first one loads.
  const limits = $derived(
    visibleLimits(snapshot, settings, loading).map((window) => ({
      ...window,
      pace: quotaPace(window, snapshot, now, !!error),
    })),
  );
  const contextHealth = $derived(contextPace(conversation, settings, context));
  const showContextGuidance = $derived(
    contextHealth.tone === 'watch' ||
      contextHealth.tone === 'danger' ||
      (contextHealth.repliesToWarning != null &&
        contextHealth.repliesToWarning > 0 &&
        contextHealth.repliesToWarning <= 20),
  );
  const quotaDirection = (state: string) =>
    state === 'below'
      ? 'down'
      : state === 'on-track'
        ? 'right'
        : state === 'unknown'
          ? 'unknown'
          : 'up';
  const stale = $derived(
    !!snapshot && (!!error || limits.some((w) => isStale(snapshot, w, now))),
  );
  const contextValue = $derived(
    context.reported == null
      ? 'Not measured yet'
      : context.percent == null
        ? `${compactTokens(context.reported)} tokens`
        : `${compactTokens(context.reported)} / ${compactTokens(context.capacity!)}`,
  );
  const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
</script>

{#snippet quotaBar(window: (typeof limits)[number], compact = false)}
  <span
    class="usage-meter"
    class:compact-meter={compact}
    class:unmeasured={window.usedPercent == null}
    class:paired-meter={window.pace.expectedPercent != null}
    class:over-guide={window.pace.expectedPercent != null &&
      window.usedPercent != null &&
      window.usedPercent > window.pace.expectedPercent}
    title={window.usedPercent == null
      ? undefined
      : window.pace.expectedPercent == null
        ? window.pace.detail
        : `${percentage(window.usedPercent)} used; recommended ${percentage(window.pace.expectedPercent)} at the time of this reading.`}
    role={compact ? 'progressbar' : 'meter'}
    aria-label={`${window.label} limit used`}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={window.usedPercent == null ? undefined : clampPercent(window.usedPercent)}
    aria-valuetext={window.usedPercent == null
      ? 'Checking usage'
      : `${percentage(window.usedPercent)} used${window.pace.expectedPercent == null ? '' : `, recommended ${percentage(window.pace.expectedPercent)}`}${isStale(snapshot, window, now) || error ? ', last reported' : ''}`}
  >
    {#if window.usedPercent != null}<i
        class={`quota-fill tone-${window.pace.tone}`}
        style:width={`${clampPercent(window.usedPercent)}%`}
      ></i>{/if}
    {#if window.pace.expectedPercent != null}<span
        class="recommended-fill"
        style:width={`${clampPercent(window.pace.expectedPercent)}%`}
        aria-hidden="true"
      ></span>{/if}
  </span>
{/snippet}

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) expanded = false;
  }}
/>

<section class="usage-panel" aria-label="Usage and context">
  <div class="usage-strip" style:--usage-groups={limits.length + 1}>
    <button
      class="usage-chip context-chip"
      class:usage-warning={(context.percent ?? 0) >= 80}
      title={context.percent == null
        ? context.unavailableReason
        : `${context.reported!.toLocaleString()} of ${context.capacity!.toLocaleString()} tokens used (${percentage(context.percent)}). ${contextHealth.label}. ${contextHealth.advice}`}
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      aria-controls="usage-details"
      aria-label={`Show context usage details. ${contextHealth.state !== 'unknown' ? contextHealth.label : context.unavailableReason}`}
    >
      <span class="usage-bar-heading"><span>Context</span><strong>{contextValue}</strong></span>
      <span
        class="usage-meter compact-meter"
        class:unmeasured={context.percent == null}
        role="progressbar"
        aria-label="Context used"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={context.percent == null ? undefined : clampPercent(context.percent)}
        aria-valuetext={context.reported == null
          ? 'Not measured yet'
          : `${context.reported.toLocaleString()} tokens${context.percent == null ? ', capacity unknown' : `, ${percentage(context.percent)} used`}`}
      >
        {#if context.percent != null}<i
            class:high={contextHealth.tone === 'watch'}
            class:critical={contextHealth.tone === 'danger'}
            style:width={`${clampPercent(context.percent)}%`}
          ></i>{/if}
      </span>
    </button>
    {#each limits as window (window.id)}
      <button
        class="usage-chip"
        class:usage-warning={window.pace.tone === 'watch' || window.pace.tone === 'danger'}
        onclick={() => (expanded = !expanded)}
        title={window.usedPercent == null
          ? undefined
          : `${isStale(snapshot, window, now) || error ? 'Last reported. ' : ''}${resetLabel(window.resetsAt, now)}. ${window.pace.label}. ${window.pace.advice}`}
        aria-expanded={expanded}
        aria-controls="usage-details"
        aria-label={`Show ${window.label} usage details. ${window.pace.label}`}
      >
        <span class="usage-bar-heading"
          ><span>{window.label}</span><span class="usage-bar-value"
            ><strong
              >{window.usedPercent == null
                ? 'Checking…'
                : `${percentage(window.usedPercent)} used`}</strong
            >
            {#if window.pace.state !== 'unknown'}<PaceIndicator
                label={window.pace.label}
                tone={window.pace.tone}
                direction={quotaDirection(window.pace.state)}
                description={`${window.pace.detail} ${window.pace.advice}`}
              />{/if}</span
          ></span
        >
        {@render quotaBar(window, true)}
      </button>
    {/each}
  </div>
  {#if stale && limits.length}<span class="usage-stale">Last reported</span>{/if}
  {#if expanded}
    <div id="usage-details" class="usage-details">
      <div class="usage-details-heading">
        <div>
          <strong>{providers[settings.provider].name} usage</strong>
        </div>
        <span
          >{snapshot
            ? `Checked ${new Date(snapshot.checkedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'No account reading yet'}</span
        >
        <button
          class="icon-button"
          aria-label="Close usage details"
          onclick={() => (expanded = false)}><X size={14} /></button
        >
      </div>
      {#if error}<p class="usage-error" role="status">{error}</p>{/if}
      {#if preview}<p class="usage-note">Live limits need the desktop app.</p>{/if}
      <div class="usage-cards">
        <div class="usage-card context-card" data-testid="reported-context">
          <div class="usage-card-heading">
            <span title={`${context.source}. ${context.reportedModel ?? ''}`}>Chat context</span>
          </div>
          <strong
            title={context.reported != null
              ? `${context.reported.toLocaleString()} input tokens`
              : ''}
            >{context.reported == null ? 'Not measured yet' : compactTokens(context.reported)}
            {#if context.reported != null}<small
                >/ {context.capacity ? compactTokens(context.capacity) : 'unknown capacity'}</small
              >{/if}</strong
          >
          {#if context.percent != null}<div
              class="usage-meter"
              role="meter"
              aria-label="Reported context used"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.min(100, context.percent)}
              aria-valuetext={`${context.reported!.toLocaleString()} tokens, ${percentage(context.percent)} used at the last API request`}
            >
              <i
                class:high={contextHealth.tone === 'watch'}
                class:critical={contextHealth.tone === 'danger'}
                style:width={`${Math.min(100, context.percent)}%`}
              ></i>
            </div>{/if}
          <p title={context.reported == null ? context.unavailableReason : undefined}>
            {context.reported == null
              ? 'Awaiting a provider reading'
              : contextHealth.remainingTokens != null
                ? `${compactTokens(contextHealth.remainingTokens)} tokens left`
                : 'Window size unknown'}
            {#if context.streaming}<small> · Updating…</small>{/if}
          </p>
          {#if showContextGuidance}<div class="pace-details" data-testid="context-pace">
              {#if contextHealth.tone === 'watch' || contextHealth.tone === 'danger'}<p
                  class="pace-advice"
                >
                  {contextHealth.advice}
                </p>{/if}
              {#if contextHealth.repliesToWarning != null && contextHealth.repliesToWarning > 0 && contextHealth.repliesToWarning <= 20}<p
                  class="pace-projection"
                >
                  ~{contextHealth.repliesToWarning} similar {contextHealth.repliesToWarning === 1
                    ? 'exchange'
                    : 'exchanges'} to 80% (estimate)
                </p>{/if}
            </div>{/if}
        </div>
        {#if settings.provider === 'claude' || settings.provider === 'codex'}<div
            class="usage-card"
          >
            <div class="usage-card-heading"><span>Compaction</span></div>
            <CompactionControls
              {settings}
              {canCompact}
              {compact}
              disabled={compactionSettingsDisabled}
              change={changeAutoCompact}
            />
          </div>{/if}
        {#each limits as window (window.id)}
          <div
            class="usage-card"
            data-testid={`limit-${window.label.toLowerCase().replaceAll(' ', '-')}`}
          >
            <div class="usage-card-heading">
              <span>{window.label}</span
              >{#if isStale(snapshot, window, now) || (error && snapshot)}<small
                  >Last reported</small
                >{/if}
            </div>
            <strong
              >{window.usedPercent == null ? 'Checking…' : percentage(window.usedPercent)}<small
                >{window.usedPercent != null ? ' used' : ''}</small
              ></strong
            >
            {#if window.usedPercent != null}{@render quotaBar(window)}
              <p
                title={resetTime(window.resetsAt)
                  ? new Date(resetTime(window.resetsAt)!).toLocaleString()
                  : ''}
              >
                {resetLabel(window.resetsAt, now)}
              </p>
            {/if}
            <div class="pace-details" data-testid="quota-pace">
              <PaceIndicator
                label={window.pace.label}
                tone={window.pace.tone}
                direction={quotaDirection(window.pace.state)}
                description={window.pace.detail}
              />
              {#if window.pace.allowance != null && window.pace.state !== 'exhausted'}<p
                  class="pace-budget"
                  title="Remaining share of the full limit available per hour or day until reset."
                >
                  Budget: {percentage(window.pace.allowance)}/{window.pace.allowanceUnit}
                </p>{/if}
              {#if window.pace.state === 'exhausted'}<p class="pace-advice">
                  {window.pace.advice}
                </p>{/if}
            </div>
          </div>
        {/each}
      </div>
      {#if conversation && ['claude', 'codex'].includes(settings.provider)}<ChatSpend
          {conversation}
        />{/if}
      {#if credits}<div class="usage-card credit-card">
          <CreditUsage provider={settings.provider} {snapshot} {loading} {stale} />
          <AccountControls
            provider={settings.provider}
            connectionId={settings.connectionId}
            name={accountName}
            {snapshot}
            disabled={!!error || preview || accountUnavailable}
          />
        </div>{/if}
    </div>
  {/if}
</section>
