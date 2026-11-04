import { SvelteMap } from 'svelte/reactivity';
import {
  workflowStore,
  type LeaseResult,
  type ListResult,
  type PutResult,
  type ReadResult,
  type WorkflowStore,
} from './workflow-store';
import {
  answerWorkflowCall,
  desktop,
  pendingWorkflowCalls,
  relayWorkflowRevision,
  watchRelayWorkflows,
  watchWorkflowCalls,
  workflowFiles,
  workflowRelay,
  type WorkflowCall,
} from './transport';
import { RunDriver, staticRun, type WorkflowHost } from './workflow-engine';
import {
  missionCall,
  missionTools,
  newMission,
  tickMission,
  type MissionTool,
} from './workflow-mission';
import { generalCall, generalTools, type GeneralTool, type StoreAccess } from './workflow-tools';
import {
  mayContinue,
  readDefinition,
  readRun,
  runActive,
  triggerLabels,
  type Actor,
  type EventInput,
  type Lease,
  type RunAlert,
  type RunCommand,
  type RunDriverChoice,
  type RunNote,
  type TriggerKind,
  type WorkflowDefinition,
  type WorkflowDoc,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowSummary,
} from './workflow-model';
import { latestSlot, slotRunId } from './workflow-schedule';
import { mergeDefinition } from './workflow-merge';
import { TriggerWatch, eventRunId } from './workflow-triggers';
import type { Schedule } from './workflow-model';
import type { QuestionAnswer } from './questions';

/**
 * The page's side of workflows (docs/WORKFLOWS.md): which store it uses (this computer's own,
 * or the relay's once it has one), the summaries lists show, the documents views open, and on a
 * desktop the supervisor that claims, drives and hands over runs and answers the workflow tools
 * of the replies this computer runs.
 */

type Backend = {
  kind: 'local' | 'relay';
  list(since: number): Promise<ListResult>;
  read(ids: string[], events?: Record<string, number>): Promise<ReadResult>;
  put(input: {
    id: string;
    kind: WorkflowDoc['kind'];
    expected: number | null;
    body: unknown;
    events?: EventInput[];
  }): Promise<PutResult>;
  remove(id: string, expected: number): Promise<PutResult>;
  lease(id: string, holder: string, ttlMs: number, release?: boolean): Promise<LeaseResult>;
};

function localBackend(store: WorkflowStore): Backend {
  return {
    kind: 'local',
    list: (since) => store.list(since),
    read: (ids, events) => store.read(ids, events),
    put: (input) => store.put({ ...input, body: input.body as Record<string, unknown> }),
    remove: (id, expected) => store.remove(id, expected),
    lease: (id, holder, ttl, release) => store.lease(id, holder, ttl, release),
  };
}
function relayBackend(): Backend {
  const call = async (method: 'POST' | 'PUT', path: string, body: unknown, conflict = false) => {
    const response = await workflowRelay(method, path, body);
    if (response.status === 200 || (conflict && response.status === 409)) return response.body;
    throw new Error(response.body?.error ?? `The workflow store answered ${response.status}.`);
  };
  return {
    kind: 'relay',
    list: (since) => call('POST', 'list', { since }),
    read: (ids, events = {}) => call('POST', 'read', { ids, events }),
    put: ({ id, ...input }) => call('PUT', id, { events: [], ...input }, true),
    remove: (id, expected) => call('POST', `${id}/delete`, { expected }, true),
    lease: (id, holder, ttlMs, release) =>
      call('POST', `${id}/lease`, { holder, ttlMs, ...(release ? { release } : {}) }),
  };
}

/** How long a lease lasts, and how often its driver renews it. */
const LEASE_MS = 60_000;
const RENEW_MS = 15_000;
const TICK_MS = 2_000;
const alertReceipts = 'agent-studio.workflow-alerts';

export type WorkflowOptions = {
  /** The page's capabilities; absent until the page has loaded what workflows need. */
  host: () => WorkflowHost | undefined;
  /** The Viewer follows workflows but never drives them. */
  drives: boolean;
  /** Shows an alert a run raised, once per device. */
  alert?: (summary: WorkflowSummary, alert: RunAlert) => void;
};

export type OpenDoc = {
  doc: WorkflowDoc;
  events: WorkflowEvent[];
  seq: number;
};

export class WorkflowClient {
  mode = $state<'loading' | 'local' | 'relay' | 'unavailable'>('loading');
  error = $state('');
  readonly summaries = new SvelteMap<string, WorkflowSummary>();
  leases = $state<Record<string, Lease>>({});
  readonly docs = new SvelteMap<string, OpenDoc>();
  /** Chats of runs this page drives that the store has not listed yet. */
  private ownChats = $state<string[]>([]);
  private backend: Backend | undefined;
  private local: WorkflowStore | undefined;
  private revision = 0;
  private offset = 0;
  private drivers = new Map<string, { driver: RunDriver; renewedAt: number; busy: boolean }>();
  private known = new Map<string, { revision: number; run: WorkflowRun }>();
  private watched = new Map<string, number>();
  /** The history entries of each run driven here that its view has read. */
  private read = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stops: (() => void)[] = [];
  private refreshing: Promise<void> | undefined;
  private again = false;
  private supervising = false;
  private firstPass: Promise<void>;
  private settleFirst = () => {};
  private fired = new Map<string, number>();

  constructor(private options: WorkflowOptions) {
    this.firstPass = new Promise((resolve) => (this.settleFirst = resolve));
  }

  /** Chats the chat lists leave out: workflows' assistants and every chat a run started. */
  get chats(): Set<string> {
    const chats = new Set(this.ownChats);
    for (const summary of this.summaries.values())
      for (const id of summary.conversations) chats.add(id);
    return chats;
  }
  /**
   * Chats that belong to a run: they raise no alerts of their own, since the run alerts for
   * what matters (docs/WORKFLOWS.md).
   */
  get isolated(): Set<string> {
    const chats = new Set(this.ownChats);
    for (const summary of this.summaries.values())
      if (summary.kind === 'run') for (const id of summary.conversations) chats.add(id);
    return chats;
  }
  /** Keeps a chat a run is starting out of the chat lists before its run is written. */
  own(conversationId: string) {
    if (!this.ownChats.includes(conversationId)) this.ownChats = [...this.ownChats, conversationId];
  }
  /** The run a chat belongs to, or writes to, for the banner above it. */
  runOf(conversationId: string): WorkflowSummary | undefined {
    for (const summary of this.summaries.values())
      if (
        summary.kind === 'run' &&
        (summary.conversations.includes(conversationId) || summary.listed.includes(conversationId))
      )
        return summary;
    return undefined;
  }
  /**
   * Whether a chat is the workflow's to drive: every chat a run started, read but never written
   * in, except the chat you talk to a dynamic workflow you started in, its orchestrator's.
   */
  readOnly(conversationId: string): boolean {
    const yours = (mode?: string, parent?: unknown, chat?: string) =>
      mode === 'dynamic' && !parent && chat === conversationId;
    for (const summary of this.summaries.values())
      if (summary.kind === 'run' && summary.conversations.includes(conversationId))
        return !yours(summary.mode, summary.parent, summary.chat);
    if (!this.ownChats.includes(conversationId)) return false;
    // A chat a run driven here started a moment ago, before the store lists it.
    for (const { driver } of this.drivers.values()) {
      const run = driver.run;
      if (!run.agents.some((a) => a.conversationId === conversationId && !a.external)) continue;
      const session = run.sessions.filter((s) => !s.endedAt).at(-1) ?? run.sessions.at(-1);
      return !yours(run.mode, run.parent, session?.conversationId);
    }
    return false;
  }
  get now() {
    return Date.now() + this.offset;
  }
  driving(id: string) {
    return this.drivers.has(id);
  }
  /** The runs this page drives that go on by themselves, paused ones aside. */
  drivenRuns() {
    let count = 0;
    for (const { driver } of this.drivers.values()) if (driver.run.status === 'running') count++;
    return count;
  }

  start() {
    void this.chooseMode();
    this.stops.push(
      watchRelayWorkflows(() => {
        void this.chooseMode().then(() => this.refresh());
      }),
    );
    this.timers.push(
      setInterval(() => void this.refresh(), 10_000),
      ...(this.options.drives && desktop()
        ? [setInterval(() => void this.supervise(), TICK_MS)]
        : []),
    );
    if (this.options.drives && desktop()) {
      void watchWorkflowCalls((call) => void this.answer(call)).then((stop) =>
        this.stops.push(stop),
      );
      void this.firstPass.then(async () => {
        for (const call of await pendingWorkflowCalls().catch(() => [])) void this.answer(call);
      });
    } else this.settleFirst();
  }
  stop() {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    for (const stop of this.stops.splice(0)) stop();
    for (const [id] of this.drivers)
      void this.backend?.lease(id, this.self(), LEASE_MS, true).catch(() => {});
    this.drivers.clear();
  }
  private self() {
    return this.options.host()?.self().environmentId ?? '';
  }

  /** Uses the relay's store once it has one, this computer's own otherwise. */
  private async chooseMode() {
    const relay = relayWorkflowRevision() !== undefined;
    const next = relay ? 'relay' : desktop() ? 'local' : 'unavailable';
    if (next === this.mode && this.backend) return;
    const previous = this.backend;
    if (next === 'local') {
      this.local ??= workflowStore(workflowFiles);
      this.backend = localBackend(this.local);
    } else this.backend = next === 'relay' ? relayBackend() : undefined;
    // Runs driven against the other store go on from this one.
    for (const [id] of this.drivers) this.drivers.delete(id);
    this.summaries.clear();
    this.docs.clear();
    this.leases = {};
    this.revision = 0;
    this.mode = next;
    if (next === 'relay' && previous?.kind !== 'relay' && desktop()) await this.moveUp();
    await this.refresh();
  }
  /** Moves this computer's own workflows to the relay's store, once it has one. */
  private async moveUp() {
    try {
      this.local ??= workflowStore(workflowFiles);
      const local = await this.local.list(0);
      if (!local.docs.length) return;
      const relay = await this.backend!.list(0);
      const there = new Set(relay.docs.map((d) => d.id));
      for (const summary of local.docs) {
        const read = await this.local.read([summary.id], { [summary.id]: 0 });
        const doc = read.docs[0];
        if (!doc) continue;
        if (!there.has(summary.id))
          await this.backend!.put({
            id: doc.id,
            kind: doc.kind,
            expected: null,
            body: doc.body,
            events: (read.events[doc.id] ?? []).map(({ seq, ...event }) => event),
          });
        // The relay holds it from now on; a copy kept here would bring it back once deleted there.
        await this.local.remove(doc.id, doc.revision);
      }
    } catch (error) {
      this.error = `Workflows of this computer could not move to the relay: ${String(error).replace(/^Error: /, '')}`;
    }
  }

  /** Takes in what changed in the store since the last look. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        await this.refreshOnce();
      } while (this.again);
    })().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }
  private async refreshOnce() {
    const backend = this.backend;
    if (!backend) return;
    let list: ListResult;
    try {
      list = await backend.list(this.revision);
    } catch (error) {
      this.error = String(error).replace(/^Error: /, '');
      return;
    }
    if (backend !== this.backend) return;
    this.error = '';
    this.offset = list.now - Date.now();
    const alerts: [WorkflowSummary, RunAlert][] = [];
    for (const summary of list.docs) {
      for (const alert of summary.alerts) alerts.push([summary, alert]);
      this.summaries.set(summary.id, summary);
    }
    for (const id of list.removed) {
      this.summaries.delete(id);
      this.docs.delete(id);
    }
    this.leases = list.leases;
    this.revision = list.revision;
    if (alerts.length) this.alertOnce(alerts);
    // Open documents and runs driven elsewhere that moved.
    const stale = [...this.watched.keys()].filter((id) => {
      const summary = this.summaries.get(id);
      const open = this.docs.get(id);
      return summary && (!open || open.doc.revision < summary.revision);
    });
    if (stale.length) await this.load(stale);
  }
  private alertOnce(alerts: [WorkflowSummary, RunAlert][]) {
    if (!this.options.alert) return;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(alertReceipts) ?? '[]');
    } catch {
      seen = [];
    }
    const now = this.now;
    let changed = false;
    for (const [summary, alert] of alerts) {
      if (seen.includes(alert.id)) continue;
      seen.push(alert.id);
      changed = true;
      const at = Date.parse(alert.at);
      if (Number.isFinite(at) && at > now - 600_000) this.options.alert(summary, alert);
    }
    if (changed) localStorage.setItem(alertReceipts, JSON.stringify(seen.slice(-500)));
  }

  /** Follows a document while a view shows it. */
  watch(id: string) {
    this.watched.set(id, (this.watched.get(id) ?? 0) + 1);
    if (!this.docs.has(id)) void this.load([id]);
    return () => {
      const count = (this.watched.get(id) ?? 1) - 1;
      if (count > 0) this.watched.set(id, count);
      else {
        this.watched.delete(id);
        if (!this.drivers.has(id)) this.docs.delete(id);
      }
    };
  }
  private async load(ids: string[]) {
    const backend = this.backend;
    if (!backend) return;
    const after = Object.fromEntries(ids.map((id) => [id, this.docs.get(id)?.seq ?? 0]));
    let read: ReadResult;
    try {
      read = await backend.read(ids, after);
    } catch (error) {
      this.error = String(error).replace(/^Error: /, '');
      return;
    }
    if (backend !== this.backend) return;
    for (const doc of read.docs) {
      // Reads may overlap: each entry is taken once, and a copy a driver here published since
      // is not replaced by an older one.
      const open = this.docs.get(doc.id);
      const known = open?.seq ?? 0;
      const fresh = (read.events[doc.id] ?? []).filter((event) => event.seq > known);
      const events = [...(open?.events ?? []), ...fresh];
      const kept = open && open.doc.revision > doc.revision ? open.doc : doc;
      this.docs.set(doc.id, { doc: kept, events, seq: Math.max(known, doc.seq) });
    }
  }
  /** A document's current copy: the driver's own for a run this page drives. */
  doc(id: string): OpenDoc | undefined {
    return this.docs.get(id);
  }

  // ---- Writes ---------------------------------------------------------------------------------

  private async put(
    id: string,
    kind: WorkflowDoc['kind'],
    expected: number | null,
    body: unknown,
    events?: EventInput[],
  ) {
    if (!this.backend) throw new Error('Workflows need the relay to be updated.');
    const result = await this.backend.put({
      id,
      kind,
      expected,
      body,
      ...(events ? { events } : {}),
    });
    void this.refresh();
    return result;
  }
  readonly access: StoreAccess = {
    summaries: () => [...this.summaries.values()],
    read: async (id, events) => {
      if (!this.backend) return undefined;
      const read = await this.backend.read([id], events === undefined ? {} : { [id]: events });
      const doc = read.docs[0];
      return doc
        ? { body: doc.body, revision: doc.revision, kind: doc.kind, events: read.events[id] ?? [] }
        : undefined;
    },
    put: (id, kind, expected, body) => this.put(id, kind, expected, body),
  };

  async saveDefinition(
    id: string,
    expected: number | null,
    body: WorkflowDefinition,
  ): Promise<PutResult> {
    const result = await this.put(id, 'definition', expected, body);
    if (result.ok) await this.load([id]);
    return result;
  }
  async remove(id: string) {
    const summary = this.summaries.get(id);
    if (!summary || !this.backend) return;
    const result = await this.backend.remove(id, summary.revision);
    if (!result.ok) throw new Error('It changed meanwhile. Try again.');
    this.docs.delete(id);
    this.summaries.delete(id);
    void this.refresh();
  }
  /** Creates a run and, on a desktop it prefers, drives it at once. */
  async createRun(id: string, run: WorkflowRun) {
    const result = await this.put(id, 'run', null, run, [{ kind: 'started', text: 'Started' }]);
    if (!result.ok) throw new Error('A run with this id exists already.');
    void this.supervise();
  }
  /** Starts a run of a workflow at a trigger: its first manual one unless `trigger` names one. */
  async startRun(
    definitionId: string,
    inputs: Record<string, string>,
    driver: string | RunDriverChoice,
    actor: Actor,
    trigger?: string,
  ) {
    const read = await this.access.read(definitionId);
    const definition = read ? readDefinition(read.body) : undefined;
    if (!read || !definition) throw new Error('This workflow is no longer saved.');
    const id = crypto.randomUUID();
    await this.createRun(
      id,
      staticRun(
        definitionId,
        definition,
        read.revision,
        inputs,
        typeof driver === 'string'
          ? {
              preferred: driver,
              elsewhere: definition.elsewhere,
              ...(definition.continueOn ? { continueOn: definition.continueOn } : {}),
            }
          : driver,
        actor,
        Date.now(),
        trigger ? { nodeId: trigger, kind: 'manual' } : undefined,
      ),
    );
    return id;
  }
  /**
   * Starts a dynamic workflow. One started from a chat is driven here at once, so the tools of
   * the reply about to start in that chat already answer.
   */
  async startMission(spec: Omit<Parameters<typeof newMission>[0], 'now'>) {
    const id = crypto.randomUUID();
    await this.createRun(id, newMission({ ...spec, now: Date.now() }));
    if (spec.chat && spec.driver.preferred === this.self()) {
      await this.refresh();
      await this.supervise();
    }
    return id;
  }
  /**
   * Saves your edits of a workflow made over `base`, its body at `revision`. When the agent or
   * another device saved meanwhile, your changes are merged over theirs and saved again.
   */
  async saveDraft(
    id: string,
    revision: number,
    base: WorkflowDefinition,
    mine: WorkflowDefinition,
  ): Promise<{ revision: number; body: WorkflowDefinition }> {
    let expected = revision;
    let body = mine;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await this.put(id, 'definition', expected, body);
      if (result.ok) {
        await this.load([id]);
        return { revision: result.doc.revision, body };
      }
      const theirs = result.current ? readDefinition(result.current.body) : undefined;
      if (!result.current || !theirs) throw new Error('This workflow is no longer saved.');
      body = mergeDefinition(base, mine, theirs);
      expected = result.current.revision;
    }
    throw new Error('The workflow kept changing. Try again.');
  }
  /** Changes a saved workflow, retrying over newer copies. */
  async changeDefinition(id: string, change: (definition: WorkflowDefinition) => void) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const read = await this.access.read(id);
      const current = read ? readDefinition(read.body) : undefined;
      if (!read || !current) throw new Error('This workflow is no longer saved.');
      change(current);
      current.updatedAt = new Date(this.now).toISOString();
      const result = await this.put(id, 'definition', read.revision, current);
      if (result.ok) {
        await this.load([id]);
        return;
      }
    }
    throw new Error('The workflow kept changing. Try again.');
  }
  /**
   * The workflow whose chat this is: a static workflow's assistant, or the orchestrator of a
   * dynamic workflow you started.
   */
  workflowOf(conversationId: string): WorkflowSummary | undefined {
    for (const summary of this.summaries.values())
      if (summary.chat === conversationId && !summary.parent) return summary;
    return undefined;
  }
  /** Changes a run as the user asks: through its driver when this page drives it. */
  private async changeRun(id: string, change: (run: WorkflowRun) => void) {
    const own = this.drivers.get(id);
    if (own) {
      change(own.driver.run);
      own.driver.change();
      await own.driver.flush();
      this.publish(own.driver);
      void this.supervise();
      return;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const read = await this.access.read(id);
      const base = read ? readRun(read.body) : undefined;
      if (!read || !base) throw new Error('This run is no longer saved.');
      const mine = structuredClone(base);
      change(mine);
      mine.updatedAt = new Date(this.now).toISOString();
      const result = await this.put(id, 'run', read.revision, mine);
      // Someone else wrote first: the change applies again over their copy.
      if (result.ok) {
        await this.load([id]);
        return;
      }
    }
    throw new Error('The run kept changing. Try again.');
  }
  command(
    id: string,
    kind: RunCommand['kind'],
    activationId?: string,
    driver?: RunDriverChoice,
  ) {
    return this.changeRun(id, (run) => {
      run.commands.push({
        id: crypto.randomUUID(),
        kind,
        ...(activationId ? { activationId } : {}),
        ...(driver ? { driver } : {}),
        at: new Date(this.now).toISOString(),
        by: this.self(),
      });
      // The driver takes the command; a pause shows at once.
      if (kind === 'pause' && run.status === 'running') run.status = 'paused';
    });
  }
  answerQuestion(id: string, answer: QuestionAnswer) {
    return this.changeRun(id, (run) => {
      const question = run.questions.find((q) => q.id === answer.requestId);
      if (!question || question.status !== 'pending')
        throw new Error('This question is no longer open.');
      Object.assign(question, {
        status: 'answered',
        revision: question.revision + 1,
        answers: answer.answers,
        skipped: answer.skipped,
        answeredAt: new Date(this.now).toISOString(),
        answeredBy: this.self(),
      });
    });
  }
  writeNote(
    id: string,
    note: Pick<RunNote, 'title' | 'text'> & { id?: string; deleted?: boolean },
  ) {
    return this.changeRun(id, (run) => {
      const existing = note.id ? run.notes.find((n) => n.id === note.id) : undefined;
      const at = new Date(this.now).toISOString();
      if (existing)
        Object.assign(existing, {
          title: note.title,
          text: note.text,
          deleted: note.deleted,
          revision: existing.revision + 1,
          updatedAt: at,
          author: 'user',
        });
      else
        run.notes.push({
          id: crypto.randomUUID().slice(0, 8),
          revision: 1,
          title: note.title,
          text: note.text,
          author: 'user',
          updatedAt: at,
        });
      if (run.mode === 'dynamic')
        run.inbox.push({
          id: crypto.randomUUID(),
          at,
          kind: 'note',
          text: `The user ${existing ? (note.deleted ? 'deleted' : 'changed') : 'wrote'} the note "${note.title || 'Untitled'}".`,
        });
    });
  }

  // ---- Driving --------------------------------------------------------------------------------

  /** A run driver's progress, for views showing the run before the store has it back. */
  private publish(driver: RunDriver) {
    const open = this.docs.get(driver.id);
    const doc: WorkflowDoc = {
      id: driver.id,
      kind: 'run',
      revision: driver.revision,
      updatedAt: driver.run.updatedAt,
      body: structuredClone(driver.run) as unknown as Record<string, unknown>,
    };
    if (this.watched.has(driver.id) || open) {
      this.docs.set(driver.id, { doc, events: open?.events ?? [], seq: open?.seq ?? 0 });
      // The history it wrote since, read back for the view showing its run.
      if (this.read.get(driver.id) !== driver.written) {
        this.read.set(driver.id, driver.written);
        void this.load([driver.id]);
      }
    }
    const own = new Set(this.ownChats);
    let added = false;
    for (const agent of driver.run.agents)
      if (!agent.external && !own.has(agent.conversationId)) {
        own.add(agent.conversationId);
        added = true;
      }
    if (added) this.ownChats = [...own];
  }
  /** Runs a tick of every run this page drives soon, as after a reply ended. */
  nudge() {
    if (this.nudging) return;
    this.nudging = setTimeout(() => {
      this.nudging = undefined;
      void this.supervise();
    }, 150);
  }
  private nudging: ReturnType<typeof setTimeout> | undefined;

  private eligible(summary: WorkflowSummary, now: number) {
    const me = this.self();
    const lease = this.leases[summary.id];
    if (lease && lease.expiresAt > now && lease.holder !== me) return false;
    if (lease?.holder === me) return true;
    if (summary.preferred === me || !summary.preferred) return true;
    if (!mayContinue({ elsewhere: summary.elsewhere, continueOn: summary.continueOn }, me))
      return false;
    const host = this.options.host();
    const since = now - (lease?.expiresAt ?? Date.parse(summary.updatedAt));
    // The computer a run prefers drives it while it is online, unless it leaves it for long.
    if (host?.online(summary.preferred) === true && since < 120_000) return false;
    return since >= (host?.self().server ? 0 : 30_000);
  }

  /** Claims, renews and advances the runs this desktop drives. */
  async supervise() {
    const host = this.options.host();
    const backend = this.backend;
    if (!host || !backend || this.supervising) return;
    this.supervising = true;
    try {
      const me = host.self().environmentId;
      const now = this.now;
      for (const summary of this.summaries.values()) {
        if (summary.kind !== 'run') continue;
        const own = this.drivers.get(summary.id);
        if (!runActive(summary.status)) {
          if (own && !runActive(own.driver.run.status)) {
            this.drivers.delete(summary.id);
            void backend.lease(summary.id, me, LEASE_MS, true).catch(() => {});
          }
          if (!own) continue;
        }
        if (own) continue;
        if (!this.eligible(summary, now)) continue;
        let lease: LeaseResult;
        try {
          lease = await backend.lease(summary.id, me, LEASE_MS);
        } catch {
          continue;
        }
        if (!lease.granted) continue;
        const read = await backend.read([summary.id]).catch(() => undefined);
        const doc = read?.docs[0];
        let run = doc ? readRun(doc.body) : undefined;
        if (!doc || !run) continue;
        let revision = doc.revision;
        if (run.pending) {
          // A webhook's request: the run is built from its workflow here.
          const built = await this.materialize(doc.id, run, revision, backend);
          if (!built) continue;
          ({ run, revision } = built);
        }
        const driver = new RunDriver(doc.id, run, revision, host, {
          put: (id, expected, body, events) =>
            backend.put({ id, kind: 'run', expected, body, events }),
        });
        this.drivers.set(doc.id, { driver, renewedAt: Date.now(), busy: false });
        if (run.status === 'running')
          driver.event('driver', `Driven by ${host.self().name}`, { environmentId: me });
      }
      for (const [id, entry] of this.drivers) {
        if (entry.busy) continue;
        entry.busy = true;
        try {
          await this.advance(id, entry, host, backend);
        } finally {
          entry.busy = false;
        }
      }
      await this.fireSchedules(host, backend);
      await this.fireTriggers(host, backend);
    } finally {
      this.supervising = false;
      this.settleFirst();
    }
  }
  private async advance(
    id: string,
    entry: { driver: RunDriver; renewedAt: number; busy: boolean },
    host: WorkflowHost,
    backend: Backend,
  ) {
    const driver = entry.driver;
    if (Date.now() - entry.renewedAt >= RENEW_MS) {
      try {
        const lease = await backend.lease(id, host.self().environmentId, LEASE_MS);
        if (!lease.granted) {
          // Another computer drives it now.
          this.drivers.delete(id);
          return;
        }
        entry.renewedAt = Date.now();
        driver.suspended = false;
      } catch {
        // Without a confirmed lease nothing new starts; past its end, another computer drives.
        driver.suspended = true;
        if (Date.now() - entry.renewedAt > LEASE_MS) {
          this.drivers.delete(id);
          return;
        }
      }
    }
    const summary = this.summaries.get(id);
    if (summary && summary.revision > driver.revision) {
      const read = await backend.read([id]).catch(() => undefined);
      const doc = read?.docs[0];
      const theirs = doc ? readRun(doc.body) : undefined;
      if (doc && theirs) driver.absorb(theirs, doc.revision);
    }
    await this.followChildren(driver, backend);
    try {
      await driver.tick(tickMission);
    } catch (error) {
      this.error = String(error).replace(/^Error: /, '');
    }
    if (driver.removed) {
      this.drivers.delete(id);
      return;
    }
    this.publish(driver);
    if (!runActive(driver.run.status)) {
      this.drivers.delete(id);
      void backend.lease(id, host.self().environmentId, LEASE_MS, true).catch(() => {});
      void this.refresh();
    }
  }
  /** Reads the runs a driver's run started once their summary shows they ended. */
  private async followChildren(driver: RunDriver, backend: Backend) {
    for (const child of driver.run.children) {
      if (child.status !== 'running' && child.status !== 'paused') continue;
      const own = this.drivers.get(child.runId)?.driver.run;
      if (own) {
        this.known.set(child.runId, { revision: Number.MAX_SAFE_INTEGER, run: own });
        continue;
      }
      const summary = this.summaries.get(child.runId);
      if (!summary || runActive(summary.status)) continue;
      if ((this.known.get(child.runId)?.revision ?? -1) >= summary.revision) continue;
      const read = await backend.read([child.runId]).catch(() => undefined);
      const run = read?.docs[0] ? readRun(read.docs[0].body) : undefined;
      if (run) this.known.set(child.runId, { revision: read!.docs[0].revision, run });
    }
  }
  /** Every definition and run with its whole history, for a workspace export. */
  async exportAll(): Promise<{ docs: WorkflowDoc[]; events: Record<string, WorkflowEvent[]> } | undefined> {
    if (!this.backend) return undefined;
    const list = await this.backend.list(0);
    const ids = list.docs.map((d) => d.id);
    if (!ids.length) return { docs: [], events: {} };
    const read = await this.backend.read(ids, Object.fromEntries(ids.map((id) => [id, 0])));
    return { docs: read.docs.map(({ seq, ...doc }) => doc), events: read.events };
  }
  /** The dynamic workflow a chat orchestrates now, which its replies name for their tools. */
  missionOf(conversationId: string): { runId: string; role: 'orchestrator' } | undefined {
    for (const [id, { driver }] of this.drivers)
      if (driver.run.sessions.some((s) => !s.endedAt && s.conversationId === conversationId))
        return { runId: id, role: 'orchestrator' };
    return undefined;
  }
  knownRun(id: string): WorkflowRun | undefined {
    return this.drivers.get(id)?.driver.run ?? this.known.get(id)?.run;
  }
  async definition(id: string) {
    const read = await this.access.read(id);
    const body = read?.kind === 'definition' ? readDefinition(read.body) : undefined;
    return read && body ? { body, revision: read.revision } : undefined;
  }

  /**
   * Whether this computer runs a workflow's triggered runs: the computer it names (or any, when
   * it names none), or, while that one is offline, one it may continue on: those it lists, or
   * servers when it lists none.
   */
  private triggersHere(summary: WorkflowSummary, host: WorkflowHost) {
    const me = host.self();
    const runsOn = summary.runsOn || me.environmentId;
    if (runsOn === me.environmentId) return true;
    if (host.online(runsOn) === true) return false;
    if (!mayContinue({ elsewhere: summary.elsewhere, continueOn: summary.continueOn }, me.environmentId))
      return false;
    return summary.continueOn ? true : me.server;
  }
  /** The run a trigger starts, from the workflow as saved now. */
  private async triggered(
    summary: WorkflowSummary,
    trigger: { nodeId: string; kind: TriggerKind; text?: string; payload?: unknown },
    actor: Actor,
    now: number,
  ) {
    const definition = await this.definition(summary.id).catch(() => undefined);
    if (!definition) return undefined;
    const me = this.self();
    return staticRun(
      summary.id,
      definition.body,
      definition.revision,
      {},
      {
        preferred: definition.body.runsOn || me,
        elsewhere: definition.body.elsewhere,
        ...(definition.body.continueOn ? { continueOn: definition.body.continueOn } : {}),
      },
      actor,
      now,
      trigger,
    );
  }
  /** Starts the runs schedules call for, once per slot across computers. */
  private async fireSchedules(host: WorkflowHost, backend: Backend) {
    const now = this.now;
    for (const summary of this.summaries.values()) {
      if (summary.kind !== 'definition' || !summary.schedules.length) continue;
      if (!this.triggersHere(summary, host)) continue;
      for (const schedule of summary.schedules) {
        const slot = latestSlot({ ...(schedule as Schedule), enabled: true }, now);
        if (slot == null) continue;
        const key = `${summary.id}:${schedule.id}`;
        if ((this.fired.get(key) ?? 0) >= slot) continue;
        this.fired.set(key, slot);
        // A slot more than a day old is not started late.
        if (slot < now - 24 * 60 * 60 * 1000) continue;
        const at = new Date(slot).toISOString();
        const nodeId =
          schedule.nodeId ??
          (await this.definition(summary.id).catch(() => undefined))?.body.graph.nodes.find(
            (n) => n.type === 'start',
          )?.id;
        if (!nodeId) continue;
        const run = await this.triggered(
          summary,
          { nodeId, kind: 'schedule', text: at, payload: { scheduledFor: at } },
          { kind: 'schedule', scheduleId: schedule.id },
          now,
        );
        if (!run) continue;
        run.slot = { scheduleId: schedule.id, at };
        const id = await slotRunId(summary.id, schedule.id, slot);
        // Another computer that started this slot already holds its run.
        await backend
          .put({
            id,
            kind: 'run',
            expected: null,
            body: run,
            events: [{ kind: 'started', text: 'Started by its schedule' }],
          })
          .catch(() => {});
      }
    }
    void this.refresh();
  }
  private triggerWatch = new TriggerWatch();
  /** Starts the runs that chat, workflow, computer and usage triggers call for. */
  private async fireTriggers(host: WorkflowHost, backend: Backend) {
    const summaries = [...this.summaries.values()];
    const watched = summaries.filter(
      (s) => s.kind === 'definition' && s.triggers.length && this.triggersHere(s, host),
    );
    const fires = this.triggerWatch.observe(
      host,
      watched,
      summaries.filter((s) => s.kind === 'run'),
      this.chats,
    );
    for (const fire of fires) {
      const summary = this.summaries.get(fire.definitionId);
      if (!summary) continue;
      const now = this.now;
      const run = await this.triggered(
        summary,
        { nodeId: fire.nodeId, kind: fire.kind, text: fire.text, payload: fire.payload },
        { kind: 'trigger', nodeId: fire.nodeId, trigger: fire.kind },
        now,
      );
      if (!run) continue;
      const id = await eventRunId(fire.definitionId, fire.nodeId, fire.key);
      await backend
        .put({
          id,
          kind: 'run',
          expected: null,
          body: run,
          events: [
            { kind: 'started', text: `Started by its ${triggerLabels[fire.kind].toLowerCase()} trigger` },
          ],
        })
        .catch(() => {});
    }
    if (fires.length) void this.refresh();
  }
  /**
   * Builds a run a webhook started through the relay, which knows only its workflow, trigger and
   * request, from the workflow as saved now. Undefined when another computer did, or the
   * workflow is gone (the run then fails).
   */
  private async materialize(id: string, pending: WorkflowRun, revision: number, backend: Backend) {
    const definitionId = pending.definition?.id;
    const summary = definitionId ? this.summaries.get(definitionId) : undefined;
    const trigger = pending.trigger;
    const built =
      summary && trigger
        ? await this.triggered(
            summary,
            {
              nodeId: trigger.nodeId,
              kind: 'webhook',
              text: trigger.text,
              payload: trigger.payload,
            },
            pending.createdBy,
            Date.parse(pending.createdAt) || this.now,
          )
        : undefined;
    const run: WorkflowRun = built
      ? { ...built, createdAt: pending.createdAt, startedAt: pending.startedAt, driver: pending.driver }
      : {
          ...pending,
          pending: undefined,
          status: 'failed',
          detail: 'Its workflow is no longer saved.',
          endedAt: new Date(this.now).toISOString(),
        };
    delete run.pending;
    const result = await backend
      .put({
        id,
        kind: 'run',
        expected: revision,
        body: run,
        events: built ? [] : [{ kind: 'failed', text: 'Its workflow is no longer saved.' }],
      })
      .catch(() => undefined);
    if (!result?.ok || !built) return undefined;
    return { run, revision: result.doc.revision };
  }

  // ---- Tool calls -----------------------------------------------------------------------------

  /** Answers a workflow tool call of a reply this computer runs. */
  async answer(call: WorkflowCall) {
    await this.firstPass;
    const host = this.options.host();
    let text: string;
    let error = false;
    try {
      if (!host || !this.backend)
        throw new Error('Workflows are not available on this computer yet.');
      if ((generalTools as readonly string[]).includes(call.tool)) {
        const conversation = host.conversation(call.conversationId);
        text = await generalCall(this.access, host, call.tool as GeneralTool, call.input, {
          conversationId: call.conversationId,
          title: conversation?.title ?? '',
        });
      } else if ((missionTools as readonly string[]).includes(call.tool)) {
        let entry = call.mission ? this.drivers.get(call.mission.runId) : undefined;
        // A dynamic workflow started from this chat a moment ago may still be being claimed here.
        for (let tries = 0; !entry && call.mission && tries < 20; tries++) {
          const known = this.summaries.get(call.mission.runId);
          if (known && (!runActive(known.status) || known.preferred !== this.self())) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
          void this.supervise();
          entry = this.drivers.get(call.mission.runId);
        }
        if (!entry) {
          const summary = call.mission ? this.summaries.get(call.mission.runId) : undefined;
          throw new Error(
            summary && !runActive(summary.status)
              ? `This dynamic workflow has ended (${summary.status}).`
              : 'This dynamic workflow continues on another computer; this session no longer orchestrates it.',
          );
        }
        const session = entry.driver.run.sessions.find(
          (s) => !s.endedAt && s.conversationId === call.conversationId,
        );
        if (!session) throw new Error('This session no longer orchestrates this dynamic workflow.');
        text = await missionCall(entry.driver, call.tool as MissionTool, call.input);
        await entry.driver.flush();
        this.publish(entry.driver);
        this.nudge();
      } else throw new Error(`Unknown workflow tool ${call.tool}.`);
    } catch (failure) {
      text = String(failure).replace(/^Error: /, '');
      error = true;
    }
    await answerWorkflowCall(call, text, error).catch(() => {});
  }
}
