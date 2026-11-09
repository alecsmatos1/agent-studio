import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createChangeMarks, type ChangeSet } from './change-marks';
import {
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Workspace,
} from './domain';
import {
  emptyShared,
  sharedChatSchema,
  sharedMeta,
  sharedWorkspace,
  type SharedMeta,
  type SharedWorkspace,
} from './sync';
import { modelViewsRenderer } from './tool-output';

// What changed on this device since the last sync, tracked as the page tracks it. Like a
// window that has just synced, it starts with nothing waiting.
function chatMarks(started = false) {
  const changes = createChangeMarks();
  changes.takeUnsaved();
  // A window that has just started counts everything as changed until its first sync.
  if (!started) changes.takeUnsynced();
  return { changes, mark: (chatId?: string) => changes.chat(chatId) };
}
// The per-conversation runtime members, which every device provides the same way.
function chatRuntime(get: () => Workspace, marks = chatMarks()) {
  return {
    chat: (id: string) => {
      const conversation = get().conversations.find((c) => c.id === id);
      return conversation && sharedChatSchema.parse(conversation);
    },
    chatIds: () => get().conversations.map((c) => c.id),
    meta: () => sharedMeta(get()),
    takeUnsynced: () => marks.changes.takeUnsynced(),
    restoreUnsynced: (changes: ChangeSet) => marks.changes.restoreUnsynced(changes),
    applyChats: async (upsert: Conversation[], remove: string[], meta?: SharedMeta) => {
      const workspace = get();
      if (meta) Object.assign(workspace, meta);
      const gone = new Set(remove);
      workspace.conversations = workspace.conversations.filter((c) => !gone.has(c.id));
      for (const incoming of upsert) {
        const at = workspace.conversations.findIndex((c) => c.id === incoming.id);
        if (at >= 0) workspace.conversations[at] = incoming;
        else workspace.conversations.push(incoming);
      }
    },
  };
}

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
// A call that carries conversations sends its arguments as the bytes of their JSON
// (src/lib/chat-bytes.ts), which the app reads as it reads plain arguments.
const sent = vi.hoisted(() => (args: unknown) => {
  if (!(args instanceof Uint8Array)) return args;
  try {
    return JSON.parse(new TextDecoder().decode(args));
  } catch {
    return args;
  }
});
vi.mock('@tauri-apps/api/core', () => ({
  // The page names each call in its options (window-answers.ts); these tests compare the rest.
  invoke: (command: string, args?: unknown) =>
    args === undefined ? native.invoke(command) : native.invoke(command, sent(args)),
  isTauri: () => true,
  Channel: class {},
}));
// Views of a model are drawn with WebGL in a real window; here the drawing is counted.
const scene = vi.hoisted(() => ({ renderModelViews: vi.fn() }));
vi.mock('./model-scene', () => ({ renderModelViews: scene.renderModelViews }));

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.useRealTimers();
});
// Moves the clock past the interval between checkpoint writes, so the next sync writes one.
const later = () => vi.setSystemTime(Date.now() + 61_000);
/**
 * The checkpoint the host holds after a save: the value it was sent whole, or that value with
 * the conversations `order` names, each as sent in `upsert` or else as the checkpoint before
 * held it (src-tauri/src/sync_state.rs).
 */
function writtenCheckpoint(
  before: unknown,
  args: { value: any; order?: string[]; upsert?: Conversation[] },
) {
  if (!args.order) return args.value;
  const held = (before as { base?: SharedWorkspace } | null)?.base?.conversations ?? [];
  const kept = new Map<string, Conversation>(held.map((c) => [c.id, c]));
  const sent = new Map((args.upsert ?? []).map((c) => [c.id, c]));
  if ([...sent.keys()].some((id) => !args.order!.includes(id)))
    throw new Error('The whole sync checkpoint is needed to save this change.');
  const conversations = args.order.map((id) => {
    const conversation = sent.get(id) ?? kept.get(id);
    if (!conversation) throw new Error('The whole sync checkpoint is needed to save this change.');
    return conversation;
  });
  return { ...args.value, base: { ...args.value.base, conversations } };
}

it('invalidates host skill inventories after Viewer plugin mutations, including uncertain failures', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const host = crypto.randomUUID(),
    computerId = crypto.randomUUID();
  const connectionId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computerId, name: 'QA' });
  workspace.fleet.environments.push({ id: host, computerId, name: 'QA', platform: 'windows' });
  workspace.fleet.accounts.push({
    id: accountId,
    provider: 'codex',
    name: 'QA',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: host,
    profile: 'existing',
  });
  transport.configureRuntime({
    installation: { id: host, computerId, name: 'QA', platform: 'windows' },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  const changed = vi.fn();
  const events = new EventTarget();
  events.addEventListener('studio-skills-changed', changed);
  vi.stubGlobal('window', events);
  const clear = vi.spyOn(transport.contextCache, 'clear');
  const job = {
    id: crypto.randomUUID(),
    method: 'plugins',
    args: {
      provider: 'codex',
      connectionId,
      action: { kind: 'skill', path: '/fixture/SKILL.md', enabled: false },
    },
  };
  let claimed = false;
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'manage_plugins') throw new Error('Unconfirmed CLI result');
    if (command === 'relay_request' && args.path === 'v1/state')
      return {
        status: 200,
        body: { instanceId: 'same-relay', workspace: sharedWorkspace(workspace), revision: 0 },
      };
    if (command === 'relay_request' && args.path === 'v1/jobs') {
      const jobs = claimed ? [] : [job];
      claimed = true;
      return { status: 200, body: jobs };
    }
    if (command === 'relay_request' && args.path === `v1/jobs/${job.id}`)
      return { status: 200, body: { status: 'error' } };
    return original(command, args);
  });
  await transport.resumeRelay();
  clear.mockClear();
  await transport.pollRelay();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(clear).toHaveBeenCalledOnce();
  expect(native.invoke).toHaveBeenCalledWith('manage_plugins', job.args);
  await vi.waitFor(() =>
    expect(
      native.invoke.mock.calls.some(
        ([command, args]) =>
          command === 'relay_request' &&
          args.path === `v1/jobs/${job.id}` &&
          args.body.status === 'error',
      ),
    ).toBe(true),
  );
  await transport.disconnectRelay();
});

// This computer, paired with a relay that hands it `job` once and answers its updates with
// `update`, which records each one.
async function hostOf(
  job: { id: string; method: string; args: Record<string, unknown> },
  update: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: {} }),
  followReply?: (runId: string) => void,
) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const host = crypto.randomUUID(),
    computerId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computerId, name: 'QA' });
  workspace.fleet.environments.push({ id: host, computerId, name: 'QA', platform: 'windows' });
  workspace.fleet.accounts.push({
    id: accountId,
    provider: 'claude',
    name: 'QA',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: job.args.connectionId as string,
    accountId,
    environmentId: host,
    profile: 'existing',
  });
  transport.configureRuntime({
    installation: { id: host, computerId, name: 'QA', platform: 'windows' },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
    followReply,
  });
  const updates: any[] = [];
  let claimed = false;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return {
        url: 'https://relay.example.com',
        instanceId: 'same-relay',
        base: sharedWorkspace(workspace),
      };
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/state')
      return {
        status: 200,
        body: { instanceId: 'same-relay', workspace: sharedWorkspace(workspace), revision: 0 },
      };
    if (args.path === 'v1/jobs') {
      const jobs = claimed ? [] : [job];
      claimed = true;
      return { status: 200, body: jobs };
    }
    if (args.path === `v1/jobs/${job.id}` && args.method === 'PUT') {
      updates.push(structuredClone(args.body));
      return update(args.body);
    }
    return { status: 200, body: [] };
  });
  await transport.resumeRelay();
  return { transport, updates, host, workspace };
}

it('ends a read whose result the relay refuses with the reason, not an expiry', async () => {
  const connectionId = crypto.randomUUID();
  const job = {
    id: crypto.randomUUID(),
    method: 'toolOutputImage',
    args: { runId: crypto.randomUUID(), toolId: 'claude:shot', index: 0, connectionId },
  };
  const { transport, updates } = await hostOf(job, (body) =>
    body.status === 'complete'
      ? { status: 413, body: { code: 'too_large', error: 'Request exceeds its size limit.' } }
      : { status: 200, body: {} },
  );
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) =>
    command === 'read_tool_output_image'
      ? { mediaType: 'image/png', data: 'AAAA', bytes: 3 }
      : original(command, args),
  );
  await transport.pollRelay();
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('error'));
  expect(updates.at(-2)).toMatchObject({ status: 'complete', result: { bytes: 3 } });
  expect(updates.at(-1)).toMatchObject({
    error: 'The result is larger than the relay accepts.',
  });
  expect(updates.at(-1).result).toBeUndefined();
  await transport.disconnectRelay();
});

it('answers reads of the tables, documents and videos it keeps for other devices from its store', async () => {
  const connectionId = crypto.randomUUID();
  const shown = { runId: crypto.randomUUID(), toolId: 'codex:call_01', index: 0, connectionId };
  const answers: Record<string, unknown> = {
    read_tool_output_table: {
      sheets: [{ name: 'Sales', rows: 5001, columns: 4, firstRow: 0, firstColumn: 0 }],
      sheet: 0,
      lengths: [6, 7, 9, 6],
      start: 200,
      rows: [['North', 'Q1', '27500,00', '8%']],
    },
    read_tool_output_document: { text: '# Quarterly report\n', bytes: 2582, complete: false },
    read_tool_output_file: { mediaType: 'video/mp4', data: 'AAAA', bytes: 3 },
  };
  for (const [method, command, args] of [
    ['toolOutputTable', 'read_tool_output_table', { ...shown, sheet: 0, start: 200, count: 200 }],
    ['toolOutputDocument', 'read_tool_output_document', { ...shown, head: 16_384 }],
    ['toolOutputFile', 'read_tool_output_file', shown],
  ] as const) {
    const job = { id: crypto.randomUUID(), method, args };
    const { transport, updates } = await hostOf(job);
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async (name, sent) =>
      name in answers ? answers[name] : original(name, sent),
    );
    await transport.pollRelay();
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('complete'));
    expect(updates.at(-1).result).toEqual(answers[command]);
    // The computer reads the file its own call kept, named by the request's call alone.
    expect(native.invoke.mock.calls.filter(([name]) => name in answers)).toEqual([[command, args]]);
    await transport.disconnectRelay();
    native.invoke.mockReset();
    vi.resetModules();
  }
});

it('draws the views of a model it keeps once for other devices, and answers later requests with them', async () => {
  const connectionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const request = { runId, toolId: 'claude:figure', index: 0 };
  const job = {
    id: crypto.randomUUID(),
    method: 'toolOutputModelViews',
    args: { ...request, connectionId },
  };
  const { transport, updates } = await hostOf(job);
  const view = { mediaType: 'image/webp', data: 'UklGRg==', bytes: 4, width: 1600, height: 1600 };
  let kept: (typeof view)[] = [];
  const stored: unknown[] = [];
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'read_tool_output_model_views')
      return {
        format: 'glb',
        bytes: 40 * 1024 ** 2,
        ...(kept.length ? { renderer: modelViewsRenderer } : {}),
        views: kept,
      };
    if (command === 'read_tool_output_model_file') return new ArrayBuffer(16);
    if (command === 'store_tool_output_model_views') {
      stored.push(args);
      kept = (args.views as string[]).map((data) => ({ ...view, data }));
      return;
    }
    return original(command, args);
  });
  let drawn = () => {};
  scene.renderModelViews.mockReset();
  scene.renderModelViews.mockImplementation(
    () => new Promise((resolve) => (drawn = () => resolve(Array(8).fill(view)))),
  );
  await transport.pollRelay();
  // A request from this computer's own window for the same model shares the drawing.
  const same = transport.readToolOutputModelViews(runId, 'claude:figure', 0, connectionId);
  await vi.waitFor(() => expect(scene.renderModelViews).toHaveBeenCalledOnce());
  expect(scene.renderModelViews.mock.calls[0][1]).toBe('glb');
  drawn();
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('complete'));
  expect(updates.at(-1).result.views).toEqual(Array(8).fill(view));
  expect((await same).views).toHaveLength(8);
  expect(scene.renderModelViews).toHaveBeenCalledOnce();
  expect(stored).toEqual([
    { ...request, renderer: modelViewsRenderer, views: Array(8).fill('UklGRg==') },
  ]);
  // Kept views answer the next request without reading the model again.
  const reads = () =>
    native.invoke.mock.calls.filter(([command]) => command === 'read_tool_output_model_file')
      .length;
  expect(reads()).toBe(1);
  expect(
    (await transport.readToolOutputModelViews(runId, 'claude:figure', 0, connectionId)).views,
  ).toHaveLength(8);
  expect(reads()).toBe(1);
  expect(scene.renderModelViews).toHaveBeenCalledOnce();
  // Views an earlier renderer kept are drawn again.
  native.invoke.mockImplementation(async (command, args) =>
    command === 'read_tool_output_model_views'
      ? { format: 'glb', bytes: 40 * 1024 ** 2, renderer: 0, views: kept }
      : command === 'read_tool_output_model_file'
        ? new ArrayBuffer(16)
        : command === 'store_tool_output_model_views'
          ? undefined
          : original(command, args),
  );
  scene.renderModelViews.mockResolvedValue(Array(8).fill(view));
  await transport.readToolOutputModelViews(runId, 'claude:figure', 0, connectionId);
  expect(scene.renderModelViews).toHaveBeenCalledTimes(2);
  // A model this computer keeps opens whole here, as raw bytes.
  expect(transport.modelFromAnotherComputer(connectionId)).toBe(false);
  const model = await transport.readToolOutputModel(runId, 'claude:figure', 0, 'glb', connectionId);
  expect(model.format).toBe('glb');
  expect(model.bytes.byteLength).toBe(16);
  await transport.disconnectRelay();
});

it('reads another computer’s model through the relay, whatever its size', async () => {
  const remote = crypto.randomUUID();
  const transport = await fixture(remote);
  expect(transport.modelFromAnotherComputer(remote)).toBe(true);
});

it("sends a job's question at once and its other events shortly after they arrive", async () => {
  const connectionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const job = {
    id,
    method: 'run',
    args: { connectionId, request: { runId: id, agent: { provider: 'claude' } } },
  };
  const { transport, updates } = await hostOf(job);
  let channel: { onmessage: (event: unknown) => void } | undefined;
  let finish = (_: unknown) => {};
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command !== 'run_agent') return original(command, args);
    channel = args.onEvent;
    return new Promise((resolve) => (finish = resolve));
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  await transport.pollRelay();
  for (let i = 0; i < 20 && !channel; i++) await vi.advanceTimersByTimeAsync(0);
  const sent = (kind: string) => updates.some((u) => u.events.some((e: any) => e.kind === kind));
  channel!.onmessage({ kind: 'text', text: 'Checking the files' });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent('text')).toBe(false);
  await vi.advanceTimersByTimeAsync(700);
  expect(sent('text')).toBe(true);
  channel!.onmessage({
    kind: 'question',
    question: {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which folder?',
          options: [{ label: 'src', description: '' }],
          multiSelect: false,
        },
      ],
    },
  });
  // Sent without waiting for any timer, which a hidden window runs about once a minute.
  await vi.advanceTimersByTimeAsync(0);
  expect(sent('question')).toBe(true);
  finish('complete');
  vi.useRealTimers();
  await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('complete'));
  await vi.waitFor(() => transport.disconnectRelay());
});

// A reply another device asked for runs on here while this window reloads
// (src-tauri/src/reply_feed.rs). `held` is how the relay answers for its request now.
async function reloadedHost(
  held: (job: Record<string, unknown>) => unknown,
  followReply?: (runId: string) => void,
) {
  const connectionId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const job = {
    id,
    method: 'run',
    args: { connectionId, request: { runId: id, agent: { provider: 'claude' } } },
  };
  const { transport, updates, host } = await hostOf(job, undefined, followReply);
  const followed: string[] = [];
  const heartbeats: string[][] = [];
  let channel: { onmessage: (event: unknown) => void } | undefined;
  let finish = (_: unknown) => {};
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'run_agent') throw new Error('The reply runs already.');
    if (command === 'follow_run') {
      followed.push(args.runId);
      channel = args.onEvent;
      return new Promise((resolve) => (finish = resolve));
    }
    if (command === 'relay_request' && args.path === 'v1/heartbeat')
      heartbeats.push(args.body.running);
    if (command === 'relay_request' && args.path === 'v1/jobs') return { status: 200, body: [] };
    if (command === 'relay_request' && args.path === `v1/jobs/${id}` && args.method === 'GET')
      return held({
        ...job,
        source: crypto.randomUUID(),
        target: host,
        status: 'running',
        events: [],
        cancel: false,
      });
    return original(command, args);
  });
  return {
    transport,
    updates,
    id,
    followed,
    heartbeats,
    emit: (event: unknown) => channel?.onmessage(event),
    finish: (end: unknown) => finish(end),
  };
}

it('goes on publishing a reply another device asked for after this window reloaded', async () => {
  const host = await reloadedHost((job) => ({ status: 200, body: job }));
  host.transport.resumeJobs([host.id]);
  await host.transport.pollRelay();
  // The relay keeps the request alive meanwhile, and the window follows the reply already
  // running instead of starting it again.
  expect(host.heartbeats[0]).toContain(host.id);
  await vi.waitFor(() => expect(host.followed).toEqual([host.id]));
  host.emit({ kind: 'text', text: 'Still checking the files' });
  await vi.waitFor(() =>
    expect(host.updates.at(-1)?.events).toContainEqual({
      kind: 'text',
      text: 'Still checking the files',
    }),
  );
  host.finish('complete');
  await vi.waitFor(() => expect(host.updates.at(-1)?.status).toBe('complete'));
  expect(host.transport.unresumedJobs()).toEqual([]);
  await vi.waitFor(() => host.transport.disconnectRelay());
});

it('ends a reply here once the relay no longer holds the request it answers', async () => {
  // The page follows such a reply like one of its own.
  const followReply = vi.fn();
  const host = await reloadedHost(
    () => ({ status: 404, body: { error: 'Request is gone.' } }),
    followReply,
  );
  host.transport.resumeJobs([host.id]);
  await host.transport.pollRelay();
  await vi.waitFor(() => expect(followReply).toHaveBeenCalledWith(host.id));
  expect(host.followed).toEqual([]);
  expect(host.updates).toEqual([]);
  expect(host.transport.unresumedJobs()).toEqual([]);
  await vi.waitFor(() => host.transport.disconnectRelay());
});

it('hands back the replies the relay never took up again, for the window to end itself', async () => {
  const host = await reloadedHost((job) => ({ status: 200, body: job }));
  host.transport.resumeJobs([host.id]);
  expect(host.transport.unresumedJobs()).toEqual([host.id]);
  await host.transport.pollRelay();
  expect(host.followed).toEqual([]);
  await vi.waitFor(() => host.transport.disconnectRelay());
});

it('keeps running the replies a reloaded window follows again, and interrupts the rest', async () => {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const stillRunning = crypto.randomUUID();
  const reply = (runId: string) => ({
    id: crypto.randomUUID(),
    runId,
    role: 'assistant' as const,
    createdAt: '2026-10-19T12:25:27.485Z',
    status: 'running' as const,
    settings: settingsFor(workspace.preferences),
    blocks: [{ type: 'markdown' as const, text: 'Saving the updated screen now' }],
  });
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Edvisor PR Tracking',
    titleStatus: 'generated',
    createdAt: '2026-10-19T12:25:27.485Z',
    updatedAt: '2026-10-19T12:25:27.485Z',
    settings: settingsFor(workspace.preferences),
    messages: [reply(stillRunning), reply(crypto.randomUUID())],
  });
  native.invoke.mockImplementation(async (command) =>
    command === 'load_workspace' ? structuredClone(workspace) : null,
  );
  const live = [{ runId: stillRunning, job: false, ended: false }];
  const [following, gone] = (await transport.loadWorkspace(undefined, live)).conversations[0]
    .messages;
  expect(following).toMatchObject({ status: 'running' });
  expect(following.error).toBeUndefined();
  expect(gone).toMatchObject({ status: 'cancelled', error: interruptedReplyError });
});

it('tells a page after the first one of the app process that the window reloaded', async () => {
  const transport = await import('./transport');
  native.invoke.mockImplementation(async (command) =>
    command === 'app_session'
      ? { id: crypto.randomUUID(), startedAt: 1_790_000_000_000, reloaded: true }
      : null,
  );
  expect(await transport.appSession()).toMatchObject({ reloaded: true });
  native.invoke.mockImplementation(async (command) =>
    command === 'app_session' ? { id: crypto.randomUUID(), startedAt: 1_790_000_000_000 } : null,
  );
  expect(await transport.appSession()).toMatchObject({ reloaded: false });
});

it('routes MCP management and OAuth polling to the exact selected host', async () => {
  const connectionId = crypto.randomUUID();
  const transport = await fixture(connectionId);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return {
        status: 200,
        body: {
          status: 'complete',
          events: [],
          result: { status: 'pending', servers: [], message: 'Waiting', operationId: 'synthetic' },
        },
      };
    return original(command, args);
  });
  const action = { kind: 'authenticate' as const, name: 'docs' };
  await transport.manageMcp({ provider: 'codex', connectionId }, undefined, undefined, action);
  const call = native.invoke.mock.calls.find(
    ([command, args]) =>
      command === 'relay_request' && args.method === 'POST' && args.path === 'v1/jobs',
  );
  expect(call?.[1].body).toMatchObject({
    method: 'mcp',
    args: { provider: 'codex', connectionId, action },
  });
  expect(native.invoke.mock.calls.some(([command]) => command === 'manage_mcp')).toBe(false);
  await transport.disconnectRelay();
  await expect(
    transport.manageMcp({ provider: 'codex', connectionId }, undefined, undefined, action),
  ).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'manage_mcp')).toBe(false);
});

it('routes bounded mention discovery to its selected host and rejects offline fallback', async () => {
  const connectionId = crypto.randomUUID();
  const transport = await fixture(connectionId);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  const result = {
    entries: [{ kind: 'file', name: 'file.ts', path: '/remote/file.ts', token: '@file.ts' }],
    truncated: false,
    notice: '',
  };
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return { status: 200, body: { status: 'complete', events: [], result } };
    return original(command, args);
  });
  const location = {
    computerId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    path: '/remote',
  };
  expect(
    await transport.searchMentions({ provider: 'codex', connectionId }, location, 'file', 'fi'),
  ).toEqual(result);
  const call = native.invoke.mock.calls.find(
    ([command, args]) =>
      command === 'relay_request' && args.method === 'POST' && args.path === 'v1/jobs',
  );
  expect(call?.[1].body).toMatchObject({
    method: 'mentions',
    args: { provider: 'codex', connectionId, location, kind: 'file', query: 'fi' },
  });
  expect(native.invoke.mock.calls.some(([command]) => command === 'search_mentions')).toBe(false);
  await transport.disconnectRelay();
  await expect(
    transport.searchMentions({ provider: 'codex', connectionId }, location, 'file', 'fi'),
  ).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'search_mentions')).toBe(false);
});

// A reply was streaming when power was lost. The relay kept a later checkpoint than the
// last sync; the restarted app restored its own saved copy as interrupted.
async function restartedDevice(ownsRun: boolean) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const host = crypto.randomUUID(),
    computerId = crypto.randomUUID(),
    connectionId = crypto.randomUUID(),
    accountId = crypto.randomUUID();
  workspace.fleet.computers.push({ id: computerId, name: 'Host' });
  workspace.fleet.environments.push({ id: host, computerId, name: 'Host', platform: 'windows' });
  workspace.fleet.accounts.push({
    id: accountId,
    provider: 'claude',
    name: 'Host',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: host,
    profile: 'existing',
  });
  const settings = { ...settingsFor(workspace.preferences, 'claude'), connectionId };
  const runId = crypto.randomUUID();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    settings,
    title: 'Outage',
    createdAt: '2026-09-21',
    updatedAt: '2026-09-21',
    location: { computerId, environmentId: host, path: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '2026-09-21',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Build it' }],
      },
      {
        id: crypto.randomUUID(),
        runId,
        role: 'assistant',
        createdAt: '2026-09-21',
        status: 'running',
        settings,
        blocks: [{ type: 'markdown', text: 'Working' }],
      },
    ],
  });
  const base = sharedWorkspace(workspace);
  const remote = structuredClone(base);
  remote.conversations[0].messages[1].blocks = [{ type: 'markdown', text: 'Working on it' }];
  const restored = restoreWorkspace(structuredClone(workspace));
  expect(restored.conversations[0].messages[1]).toMatchObject({
    status: 'cancelled',
    error: interruptedReplyError,
  });
  const applied: SharedWorkspace[] = [];
  transport.configureRuntime({
    installation: {
      id: ownsRun ? host : crypto.randomUUID(),
      computerId: ownsRun ? computerId : crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => restored,
    shared: () => sharedWorkspace(restored),
    ...chatRuntime(() => restored),
    fleet: () => restored.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      applied.push(value);
    },
    checkpointRun: async () => {},
  });
  const puts: SharedWorkspace[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base };
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/state' && args.method === 'GET')
      return { status: 200, body: { instanceId: 'same-relay', workspace: remote, revision: 1 } };
    if (args.path === 'v1/state' && args.method === 'PUT') {
      puts.push(args.body.workspace);
      return {
        status: 200,
        body: { instanceId: 'same-relay', workspace: args.body.workspace, revision: 2 },
      };
    }
    return { status: 200, body: [] };
  });
  expect(await transport.resumeRelay()).toBe(true);
  expect(await transport.pollRelay()).toEqual([]);
  return { puts, applied };
}

it('publishes the restarted execution host’s interrupted reply over a newer running checkpoint', async () => {
  const { puts, applied } = await restartedDevice(true);
  expect(puts).toHaveLength(1);
  const reply = puts[0].conversations[0].messages[1];
  expect(reply).toMatchObject({ status: 'cancelled', error: interruptedReplyError });
  expect(reply.blocks).toEqual([{ type: 'markdown', text: 'Working on it' }]);
  expect(applied.at(-1)?.conversations[0].messages[1]).toMatchObject({
    status: 'cancelled',
    error: interruptedReplyError,
  });
});

it('ends a reply this computer runs without its run once the relay holds no request for it', async () => {
  // A conflict copy an earlier release made kept its reply running, while the run went on in the
  // original chat: Stop changed nothing and the chat waited for good (2026-10-15).
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const ids = () => ({
    environment: crypto.randomUUID(),
    computer: crypto.randomUUID(),
    account: crypto.randomUUID(),
    connection: crypto.randomUUID(),
  });
  const here = ids(),
    there = ids();
  for (const [computer, name] of [
    [here, 'Desktop'],
    [there, 'VPS'],
  ] as const) {
    workspace.fleet.computers.push({ id: computer.computer, name });
    workspace.fleet.environments.push({
      id: computer.environment,
      computerId: computer.computer,
      name,
      platform: 'windows',
    });
    workspace.fleet.accounts.push({
      id: computer.account,
      provider: 'claude',
      name,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: computer.connection,
      accountId: computer.account,
      environmentId: computer.environment,
      profile: 'existing',
    });
  }
  const chat = (title: string, on: typeof here, status: 'running' | 'complete' = 'running') => {
    const settings = {
      ...settingsFor(workspace.preferences, 'claude'),
      connectionId: on.connection,
    };
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings,
      title,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
      location: { computerId: on.computer, environmentId: on.environment, path: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: '2026-10-15',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'Install Chunky' }],
        },
        {
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          role: 'assistant',
          createdAt: '2026-10-15',
          status,
          settings,
          blocks: [{ type: 'markdown', text: 'Configuring Chunky' }],
        },
      ],
    };
    workspace.conversations.push(conversation);
    return { conversationId: conversation.id, messageId: conversation.messages[1].id };
  };
  const copied = chat('Copied', here);
  // Another device's request, which this computer takes with its next poll.
  const requested = chat('Requested', here);
  const live = chat('Live', here);
  chat('Elsewhere', there);
  chat('Finished', here, 'complete');
  const run = (reply: { messageId: string }) =>
    workspace.conversations.flatMap((c) => c.messages).find((m) => m.id === reply.messageId)!
      .runId!;
  transport.configureRuntime({
    installation: {
      id: here.environment,
      computerId: here.computer,
      name: 'Desktop',
      platform: 'windows',
    },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [run(live)],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  const asked: string[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state') return null;
    if (command !== 'relay_request') return null;
    if (args.path === 'v1/state/revision')
      return { status: 200, body: { instanceId: 'same-relay', revision: 1 } };
    if (args.path.startsWith('v1/jobs/')) {
      asked.push(args.path.slice('v1/jobs/'.length));
      return args.path.endsWith(run(requested))
        ? { status: 200, body: { id: run(requested), status: 'queued' } }
        : { status: 404, body: { error: 'Request is no longer available.' } };
    }
    return { status: 200, body: [] };
  });
  // Without the relay this computer cannot tell another device's request from an abandoned reply.
  expect(await transport.abandonedReplies(workspace.conversations)).toEqual([]);
  expect(asked).toEqual([]);
  expect(await transport.resumeRelay()).toBe(true);
  // Found, then ended by a check 20 seconds on.
  vi.setSystemTime(new Date('2026-10-15T16:00:00Z'));
  expect(await transport.abandonedReplies(workspace.conversations)).toEqual([]);
  expect(asked.sort()).toEqual([run(copied), run(requested)].sort());
  vi.setSystemTime(new Date('2026-10-15T16:00:19Z'));
  expect(await transport.abandonedReplies(workspace.conversations)).toEqual([]);
  vi.setSystemTime(new Date('2026-10-15T16:00:21Z'));
  expect(await transport.abandonedReplies(workspace.conversations)).toEqual([copied]);
  expect(asked.every((runId) => [run(copied), run(requested)].includes(runId))).toBe(true);
  // A reply the user stops ends at the first check; one with a request waiting never does.
  const stopped = chat('Stopped', here);
  expect(await transport.abandonedReplies(workspace.conversations, stopped.conversationId)).toEqual(
    [copied, stopped],
  );
  expect(
    await transport.abandonedReplies(workspace.conversations, requested.conversationId),
  ).toEqual([copied]);
  // The other computer's reply, the live run and the finished reply are never asked about.
  expect(new Set(asked)).toEqual(new Set([run(copied), run(requested), run(stopped)]));
});

it('keeps following a run another computer still executes after this device restarts', async () => {
  const { puts, applied } = await restartedDevice(false);
  expect(puts).toHaveLength(0);
  const reply = applied.at(-1)?.conversations[0].messages[1];
  expect(reply).toMatchObject({ status: 'running' });
  expect(reply?.error).toBeUndefined();
  expect(reply?.blocks).toEqual([{ type: 'markdown', text: 'Working on it' }]);
});

// A server and a desktop each with a chat whose reply was running when the server stopped.
function serverAndDesktop() {
  const workspace = initialWorkspace();
  const ids = () => ({
    environment: crypto.randomUUID(),
    computer: crypto.randomUUID(),
    account: crypto.randomUUID(),
    connection: crypto.randomUUID(),
  });
  const server = ids(),
    desktop = ids();
  for (const [host, platform] of [
    [server, 'linux'],
    [desktop, 'windows'],
  ] as const) {
    workspace.fleet.computers.push({ id: host.computer, name: platform });
    workspace.fleet.environments.push({
      id: host.environment,
      computerId: host.computer,
      name: platform,
      platform,
    });
    workspace.fleet.accounts.push({
      id: host.account,
      provider: 'claude',
      name: platform,
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: host.connection,
      accountId: host.account,
      environmentId: host.environment,
      profile: 'existing',
    });
    const settings = { ...settingsFor(workspace.preferences, 'claude'), connectionId: host.connection };
    workspace.conversations.push({
      id: crypto.randomUUID(),
      settings,
      title: platform,
      createdAt: '2026-10-10',
      updatedAt: '2026-10-10',
      location: { computerId: host.computer, environmentId: host.environment, path: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: '2026-10-10',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'Build it' }],
        },
        {
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          role: 'assistant',
          createdAt: '2026-10-10',
          status: 'running',
          settings,
          backgroundWait: 1,
          blocks: [{ type: 'markdown', text: 'Working' }],
        },
      ],
    });
  }
  const installation = (isServer: boolean) => ({
    id: server.environment,
    computerId: server.computer,
    name: 'VPS',
    platform: 'linux' as const,
    ...(isServer ? { server: true } : {}),
  });
  return { workspace, installation };
}

it('interrupts only the replies a restarted server ran, leaving other computers’ replies running', async () => {
  const transport = await import('./transport');
  const { workspace, installation } = serverAndDesktop();
  native.invoke.mockImplementation(async (command) =>
    command === 'load_workspace' ? structuredClone(workspace) : null,
  );
  const replies = (loaded: Workspace) => loaded.conversations.map((c) => c.messages[1]);
  const [own, other] = replies(await transport.loadWorkspace(installation(true)));
  expect(own).toMatchObject({ status: 'cancelled', error: interruptedReplyError });
  expect(own.backgroundWait).toBeUndefined();
  expect(other).toMatchObject({ status: 'running', backgroundWait: 1 });
  expect(other.error).toBeUndefined();
  // A desktop app that restarts still reads every reply it saved as running as interrupted.
  expect(replies(await transport.loadWorkspace(installation(false))).map((m) => m.status)).toEqual(
    ['cancelled', 'cancelled'],
  );
});

it('never reports a chat a server shows as read, so phone alerts keep coming', async () => {
  for (const isServer of [true, false]) {
    vi.resetModules();
    const transport = await import('./transport');
    const { workspace, installation } = serverAndDesktop();
    transport.configureRuntime({
      installation: installation(isServer),
      workspace: () => workspace,
      shared: () => sharedWorkspace(workspace),
      ...chatRuntime(() => workspace),
      fleet: () => workspace.fleet,
      statuses: () => ({}),
      localRuns: () => [],
      apply: async () => {},
      checkpointRun: async () => {},
    });
    const shared = sharedWorkspace(workspace);
    const views: unknown[] = [];
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'relay_resume') return 'https://relay.example.com/';
      if (command === 'load_sync_state')
        return { url: 'https://relay.example.com', instanceId: 'same-relay', base: shared };
      if (command !== 'relay_request') return null;
      if (args.path === 'v1/notification-view') views.push(args.body.conversationId);
      return {
        status: 200,
        body:
          args.path === 'v1/state'
            ? { instanceId: 'same-relay', workspace: shared, revision: 0 }
            : [],
      };
    });
    // Its window is shown and has focus, as a window on a virtual display may.
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true }),
    );
    const open = workspace.conversations[0].id;
    const stop = transport.watchNotificationView(() => open);
    expect(await transport.resumeRelay()).toBe(true);
    await transport.publishNotificationView();
    expect(views.length).toBeGreaterThan(0);
    expect(new Set(views)).toEqual(new Set([isServer ? null : open]));
    stop();
    await transport.disconnectRelay();
  }
});

it('saves a host Undo receipt into the live workspace once, including requests from a Viewer', async () => {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const runId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
  workspace.conversations.push({
    id: conversationId,
    title: 'Undo',
    createdAt: '2026-09-19',
    updatedAt: '2026-09-19',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        runId,
        role: 'assistant',
        status: 'complete',
        createdAt: '2026-09-19',
        blocks: [],
      },
    ],
  });
  const apply = vi.fn(async (shared) => {
    workspace.conversations = shared.conversations;
  });
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply,
    checkpointRun: async () => {},
  });
  native.invoke.mockResolvedValue({ files: ['example.txt'], undone: true });
  await transport.undoFiles(conversationId, runId, undefined, true);
  await transport.undoFiles(conversationId, runId, undefined, true);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(workspace.conversations[0].historyRevision).toBe(1);
  expect(workspace.conversations[0].messages[0].filesUndone).toBe(true);
  expect(native.invoke).toHaveBeenCalledWith('undo_files', {
    conversationId,
    runId,
    connectionId: undefined,
    commit: true,
  });
});

async function fixture(remoteConnection?: string) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  if (remoteConnection) {
    const host = crypto.randomUUID(),
      computer = crypto.randomUUID(),
      account = crypto.randomUUID();
    workspace.fleet.computers.push({ id: computer, name: 'Remote' });
    workspace.fleet.environments.push({
      id: host,
      computerId: computer,
      name: 'Remote',
      platform: 'linux',
    });
    workspace.fleet.accounts.push({
      id: account,
      name: 'Remote Gemini',
      provider: 'gemini',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: remoteConnection,
      accountId: account,
      environmentId: host,
      profile: 'existing',
    });
  }
  const shared = sharedWorkspace(workspace);
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => workspace,
    shared: () => sharedWorkspace(workspace),
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async () => {},
    checkpointRun: async () => {},
  });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base: shared };
    if (command === 'relay_request')
      return {
        status: 200,
        body:
          args.path === 'v1/state'
            ? { instanceId: 'same-relay', workspace: shared, revision: 0 }
            : [],
      };
    return null;
  });
  return transport;
}

it('restores native pairing without sending its key through IPC and resumes heartbeats', async () => {
  const transport = await fixture();
  expect(await transport.resumeRelay()).toBe(true);
  expect(await transport.pollRelay()).toEqual([]);
  expect(native.invoke).toHaveBeenCalledWith('relay_resume');
  expect(native.invoke.mock.calls.some(([command]) => command === 'relay_connect')).toBe(false);
  expect(
    native.invoke.mock.calls.some(
      ([command, args]) => command === 'relay_request' && args.path === 'v1/heartbeat',
    ),
  ).toBe(true);
});

it('routes steering to the original remote connection without starting or falling back to a local run', async () => {
  const connection = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  const input = { id: crypto.randomUUID(), text: 'Check the tests first' };
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return { status: 200, body: { status: 'complete', events: [] } };
    return original(command, args);
  });
  await transport.steerRun(runId, input, connection);
  const call = native.invoke.mock.calls.find(([, args]) => args?.path === 'v1/jobs');
  expect(call?.[1].body.args).toEqual({ runId, input, connectionId: connection });
  expect(call?.[1].body.method).toBe('steer');
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === 'steer_run' || command === 'run_agent',
    ),
  ).toBe(false);
});

it('keeps a pending question when an older relay drops it from a successful save', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const question = {
    id: crypto.randomUUID(),
    revision: 1,
    status: 'pending' as const,
    questions: [
      { id: 'color', header: 'Color', question: 'Choose a color', options: [], multiSelect: false },
    ],
  };
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Waiting for input',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        runId: crypto.randomUUID(),
        status: 'running',
        blocks: [],
        questions: [question],
      },
    ],
  });
  let current: Workspace = workspace;
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => current,
    shared: () => sharedWorkspace(current),
    ...chatRuntime(() => current),
    fleet: () => current.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      current = { ...current, ...value };
    },
    checkpointRun: async () => {},
  });
  const original = native.invoke.getMockImplementation()!;
  let remote = emptyShared();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state') {
      if (args.method === 'PUT') {
        remote = structuredClone(args.body.workspace);
        for (const chat of remote.conversations)
          for (const message of chat.messages) delete message.questions;
      }
      return { status: 200, body: { instanceId: 'same-relay', revision: 0, workspace: remote } };
    }
    return original(command, args);
  });
  await transport.resumeRelay();
  for (let i = 0; i < 3; i++) {
    await transport.pollRelay();
    expect(current.conversations[0].messages[0].questions).toEqual([question]);
    expect(current.conversations[0].messages[0].status).toBe('running');
  }
});

it('keeps a compaction’s place in the work when an older relay drops it from a successful save', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const compaction = {
    id: 'compaction-1',
    revision: 2,
    status: 'complete' as const,
    trigger: 'auto' as const,
    preTokens: 967265,
    postTokens: 8081,
    after: 3,
  };
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Compacted on the way',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        runId: crypto.randomUUID(),
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Done.' }],
        compactions: [compaction],
      },
    ],
  });
  let current: Workspace = workspace;
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => current,
    shared: () => sharedWorkspace(current),
    ...chatRuntime(() => current),
    fleet: () => current.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      current = { ...current, ...value };
    },
    checkpointRun: async () => {},
  });
  const original = native.invoke.getMockImplementation()!;
  let remote = emptyShared();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state') {
      if (args.method === 'PUT') {
        remote = structuredClone(args.body.workspace);
        // An older relay's schema knows the marker, not its place.
        for (const chat of remote.conversations)
          for (const message of chat.messages)
            for (const marker of message.compactions ?? []) delete marker.after;
      }
      return { status: 200, body: { instanceId: 'same-relay', revision: 0, workspace: remote } };
    }
    return original(command, args);
  });
  await transport.resumeRelay();
  for (let i = 0; i < 3; i++) {
    await transport.pollRelay();
    expect(current.conversations[0].messages[0].compactions).toEqual([compaction]);
  }
});

it('keeps a steer’s place in the work when an older relay drops it from a successful save', async () => {
  const transport = await fixture();
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const steering = [{ id: crypto.randomUUID(), runId, sequence: 1, text: 'Keep the old colors' }];
  const steeringPlaces = [{ id: steering[0].id, after: 3, at: now }];
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Steered on the way',
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        runId,
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Done.' }],
        steering,
        steeringPlaces,
      },
    ],
  });
  let current: Workspace = workspace;
  transport.configureRuntime({
    installation: {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'QA',
      platform: 'windows',
    },
    workspace: () => current,
    shared: () => sharedWorkspace(current),
    ...chatRuntime(() => current),
    fleet: () => current.fleet,
    statuses: () => ({}),
    localRuns: () => [],
    apply: async (value) => {
      current = { ...current, ...value };
    },
    checkpointRun: async () => {},
  });
  const original = native.invoke.getMockImplementation()!;
  let remote = emptyShared();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state') {
      if (args.method === 'PUT') {
        remote = structuredClone(args.body.workspace);
        // An older relay's schema knows the receipts, not the places kept beside them.
        for (const chat of remote.conversations)
          for (const message of chat.messages) delete message.steeringPlaces;
      }
      return { status: 200, body: { instanceId: 'same-relay', revision: 0, workspace: remote } };
    }
    return original(command, args);
  });
  await transport.resumeRelay();
  for (let i = 0; i < 3; i++) {
    await transport.pollRelay();
    expect(current.conversations[0].messages[0].steering).toEqual(steering);
    expect(current.conversations[0].messages[0].steeringPlaces).toEqual(steeringPlaces);
  }
});

// A paired desktop whose relay keeps revisions like the real one. Given `lacking`, the relay
// keeps an image store, and those are the hashes it still lacks after this computer uploads.
async function settledRelay(revisionEndpoint = true, lacking?: Set<string>) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Settled chat',
    createdAt: '2026-09-24',
    updatedAt: '2026-09-24',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [],
  });
  // A Codex account connected here and on another computer.
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'QA',
    platform: 'windows' as const,
  };
  const peer = crypto.randomUUID(),
    peerComputer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    here = crypto.randomUUID(),
    there = crypto.randomUUID();
  workspace.fleet.computers.push(
    { id: installation.computerId, name: 'QA' },
    { id: peerComputer, name: 'Peer' },
  );
  workspace.fleet.environments.push(
    { id: installation.id, computerId: installation.computerId, name: 'QA', platform: 'windows' },
    { id: peer, computerId: peerComputer, name: 'Peer', platform: 'linux' },
  );
  workspace.fleet.accounts.push({
    id: account,
    provider: 'codex',
    name: 'Codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push(
    { id: here, accountId: account, environmentId: installation.id, profile: 'existing' },
    { id: there, accountId: account, environmentId: peer, profile: 'existing' },
  );
  const local = { changes: 0, reads: 0, runs: [] as string[] };
  const apply = vi.fn(async (value: SharedWorkspace) => {
    Object.assign(workspace, value);
  });
  transport.configureRuntime({
    installation,
    workspace: () => {
      local.reads++;
      return workspace;
    },
    shared: () => {
      local.reads++;
      return sharedWorkspace(workspace);
    },
    ...chatRuntime(() => workspace),
    fleet: () => workspace.fleet,
    revision: () => local.changes,
    statuses: () => ({}),
    localRuns: () => local.runs,
    apply,
    checkpointRun: async () => {},
  });
  const relay = {
    revision: 5,
    workspace: sharedWorkspace(workspace),
    presence: [] as unknown[],
    // Workspace requests wait for this, or fail, while the presence and job routes still answer.
    hold: undefined as Promise<void> | undefined,
    failing: false,
  };
  const requests: string[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state')
      return { url: 'https://relay.example.com', instanceId: 'same-relay', base: relay.workspace };
    if (command === 'save_sync_state') requests.push('save_sync_state');
    if (command === 'upload_chat_images') {
      requests.push('upload_chat_images');
      return args.hashes.filter((hash: string) => lacking?.has(hash));
    }
    if (command !== 'relay_request') return null;
    requests.push(`${args.method} ${args.path}`);
    if (args.path.startsWith('v1/state')) {
      await relay.hold;
      if (relay.failing) return { status: 500, body: { error: 'Relay storage failed.' } };
    }
    // A relay without the incremental routes. Its whole-state path is what these cases cover.
    if (args.path.startsWith('v1/state/manifest'))
      return { status: 404, body: { error: 'Unknown relay operation.' } };
    if (args.path === 'v1/state/revision')
      return revisionEndpoint
        ? {
            status: 200,
            body: {
              instanceId: 'same-relay',
              revision: relay.revision,
              ...(lacking ? { images: 1 } : {}),
            },
          }
        : { status: 404, body: { error: 'Unknown relay operation.' } };
    if (args.path === 'v1/state' && args.method === 'PUT') {
      relay.revision++;
      relay.workspace = args.body.workspace;
    }
    if (args.path === 'v1/state')
      return {
        status: 200,
        body: { instanceId: 'same-relay', revision: relay.revision, workspace: relay.workspace },
      };
    return { status: 200, body: args.path === 'v1/heartbeat' ? relay.presence : [] };
  });
  expect(await transport.resumeRelay()).toBe(true);
  // Connecting asks only for the relay's identity; a relay without that small answer sends
  // its whole state. The first poll syncs the whole workspace and finds both sides equal.
  expect(await transport.pollRelay()).toEqual([]);
  expect(requests.filter((r) => r.includes('state'))).toEqual([
    'GET v1/state/revision',
    ...(revisionEndpoint ? [] : ['GET v1/state']),
    'GET v1/state',
    'save_sync_state',
  ]);
  // One more poll asks this relay for a manifest once and learns it has none.
  expect(await transport.pollRelay()).toEqual([]);
  expect(requests.filter((r) => r === 'GET v1/state/manifest')).toHaveLength(1);
  requests.length = 0;
  const polls = async (count: number) => {
    const reads = local.reads;
    requests.length = 0;
    for (let i = 0; i < count; i++) expect(await transport.pollRelay()).not.toBeNull();
    return { state: requests.filter((r) => r.includes('state')), reads: local.reads - reads };
  };
  return { transport, workspace, relay, local, apply, requests, polls, here, there, peer };
}

it('polls after an unchanged sync only ask the relay for its revision', async () => {
  const { transport, apply, requests, polls } = await settledRelay();
  expect(await polls(3)).toEqual({ state: Array(3).fill('GET v1/state/revision'), reads: 0 });
  // Presence and jobs still run every poll.
  expect(requests.filter((r) => r === 'POST v1/heartbeat')).toHaveLength(3);
  expect(requests.filter((r) => r === 'GET v1/jobs')).toHaveLength(3);
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('a poll whose sync fails still tells the relay this device is here', async () => {
  const { transport, relay, requests } = await settledRelay();
  relay.failing = true;
  requests.length = 0;
  await expect(transport.pollRelay()).rejects.toThrow('Relay storage failed.');
  // The relay counts a device whose heartbeat is 15 seconds old as offline and refuses its work.
  expect(requests).toContain('POST v1/heartbeat');
  expect(requests).toContain('GET v1/jobs');
  await transport.disconnectRelay();
});

it('a poll that finds the last one still syncing sends a heartbeat instead', async () => {
  const { transport, relay, requests } = await settledRelay();
  let release = () => {};
  relay.hold = new Promise<void>((resolve) => (release = resolve));
  requests.length = 0;
  const slow = transport.pollRelay();
  await vi.waitFor(() => expect(requests).toContain('GET v1/state/revision'));
  expect(requests).not.toContain('POST v1/heartbeat');
  expect(await transport.pollRelay()).toBeNull();
  await vi.waitFor(() => expect(requests).toContain('POST v1/heartbeat'));
  release();
  expect(await slow).toEqual([]);
  expect(requests.filter((r) => r === 'POST v1/heartbeat')).toHaveLength(2);
  await transport.disconnectRelay();
});

it('syncs a change from either side, then returns to revision checks', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].title).toBe('Renamed here');
  expect(apply).not.toHaveBeenCalled();
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // Another device renames the chat.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'GET v1/state',
    'save_sync_state',
  ]);
  expect(apply).toHaveBeenCalledOnce();
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  // One more sync confirms both sides are equal; the checkpoint is already saved.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  expect(apply).toHaveBeenCalledOnce();
  await transport.disconnectRelay();
});

it('settles after sending a new chat that the relay lists in another order', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  // This device lists a new chat first; the merge appends it after the relay's chats.
  workspace.conversations.unshift({
    ...workspace.conversations[0],
    id: crypto.randomUUID(),
    title: 'New chat',
  });
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations.map((c) => c.title)).toEqual(['Settled chat', 'New chat']);
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  expect(apply).not.toHaveBeenCalled();
  expect(workspace.conversations.map((c) => c.title)).toEqual(['New chat', 'Settled chat']);
  await transport.disconnectRelay();
});

const appSession = (hour: number) => ({
  id: crypto.randomUUID(),
  environmentId: crypto.randomUUID(),
  startedAt: new Date(2026, 8, 25, hour).toISOString(),
});

it('keeps app sessions that an older relay drops without sending them after every sync', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: { ...args.body, workspace: { ...args.body.workspace, appSessions: undefined } },
          }
        : args,
    ),
  );
  const session = appSession(9);
  workspace.appSessions = [session];
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].title).toBe('Renamed here');
  expect(relay.workspace.appSessions).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the list here.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'GET v1/state',
    'save_sync_state',
  ]);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.appSessions).toEqual([session]);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it('sends app sessions to a relay that keeps them', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const [first, second] = [appSession(9), appSession(14)];
  workspace.appSessions = [first];
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.appSessions).toEqual([first]);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // Once the relay holds the list, another start of the app is sent by itself.
  workspace.appSessions = [first, second];
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.appSessions).toEqual([first, second]);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('keeps account colors that an older relay drops, and sends them to a relay that keeps them', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  let older = true;
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      older && command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: { ...args.body, workspace: { ...args.body.workspace, accountColors: undefined } },
          }
        : args,
    ),
  );
  const { assignAccountColors, withAccountColor } = await import('./account-colors');
  // The account takes its color here, as on the first start of a release that has them.
  const taken = assignAccountColors(undefined, workspace.fleet.accounts)!;
  workspace.accountColors = taken;
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.accountColors).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the colors here, a choice made meanwhile included.
  const chosen = withAccountColor(
    taken,
    workspace.fleet.accounts[0].id,
    'teal',
    new Date(2026, 9, 12).toISOString(),
  );
  workspace.accountColors = chosen;
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  await polls(1);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.accountColors).toEqual(chosen);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // Once the relay keeps the list, the next change takes the colors there, and a later choice
  // goes by itself.
  older = false;
  workspace.conversations[0].title = 'Renamed again';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.accountColors).toEqual(chosen);
  const again = withAccountColor(
    chosen,
    workspace.fleet.accounts[0].id,
    'pink',
    new Date(2026, 9, 13).toISOString(),
  );
  workspace.accountColors = again;
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.accountColors).toEqual(again);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it('keeps snoozes that an older relay drops, and sends them to a relay that keeps them', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  let older = true;
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      older && command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: { ...args.body, workspace: { ...args.body.workspace, snoozes: undefined } },
          }
        : args,
    ),
  );
  const { withSnooze, withoutSnooze } = await import('./snoozes');
  const held = (id: string) => workspace.conversations.find((c) => c.id === id);
  const snoozed = withSnooze(undefined, workspace.conversations[0], held, new Date(2026, 9, 14));
  workspace.snoozes = snoozed;
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.snoozes).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the snoozes here.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  await polls(1);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.snoozes).toEqual(snoozed);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // Once the relay keeps the list, the next change takes the snoozes there, and ending one goes
  // by itself.
  older = false;
  workspace.conversations[0].title = 'Renamed again';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.snoozes).toEqual(snoozed);
  workspace.snoozes = withoutSnooze(snoozed, workspace.conversations[0].id, held);
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.snoozes).toEqual([]);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it('keeps pins that an older relay drops, and sends them to a relay that keeps them', async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  let older = true;
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      older && command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: { ...args.body, workspace: { ...args.body.workspace, pins: undefined } },
          }
        : args,
    ),
  );
  const { withPin, withoutPin } = await import('./pins');
  const pinned = withPin(undefined, workspace.conversations[0].id, new Date(2026, 10, 1));
  workspace.pins = pinned;
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.pins).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the pins here.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  await polls(1);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.pins).toEqual(pinned);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // Once the relay keeps the list, the next change takes the pins there, and an unpin goes by
  // itself.
  older = false;
  workspace.conversations[0].title = 'Renamed again';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.pins).toEqual(pinned);
  workspace.pins = withoutPin(pinned, workspace.conversations[0].id);
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.pins).toEqual([]);
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it("keeps the sidebar's order when an older relay drops it, and sends it to one that keeps it", async () => {
  const { transport, workspace, relay, local, apply, polls } = await settledRelay();
  const keeps = native.invoke.getMockImplementation()!;
  // An older relay's schema drops the list from every save.
  let older = true;
  native.invoke.mockImplementation(async (command, args) =>
    keeps(
      command,
      older && command === 'relay_request' && args.path === 'v1/state' && args.method === 'PUT'
        ? {
            ...args,
            body: {
              ...args.body,
              workspace: { ...args.body.workspace, sidebarOrder: undefined },
            },
          }
        : args,
    ),
  );
  const { withMove, withoutRanks } = await import('./sidebar-order');
  const placed = withMove(undefined, 'folders', ['one', 'two'], 'two', 0, new Date(2026, 10, 9));
  workspace.sidebarOrder = placed;
  local.changes++;
  // With only the list changed, there is nothing to send to a relay without one.
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  // The next change carries it, and the relay drops it again.
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.sidebarOrder).toBeUndefined();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // A change from another device leaves the order here.
  relay.workspace = structuredClone(relay.workspace);
  relay.workspace.conversations[0].title = 'Renamed elsewhere';
  relay.revision++;
  later();
  await polls(1);
  expect(workspace.conversations[0].title).toBe('Renamed elsewhere');
  expect(workspace.sidebarOrder).toEqual(placed);
  expect(apply).toHaveBeenCalledOnce();
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  // Once the relay keeps the order, the next change takes it there, and a forgotten place goes
  // by itself.
  older = false;
  workspace.conversations[0].title = 'Renamed again';
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.sidebarOrder).toEqual(placed);
  workspace.sidebarOrder = withoutRanks(placed, 'folders', ['two']);
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.sidebarOrder).toEqual({
    folders: [placed!.folders![0]],
  });
  expect((await polls(2)).state).toEqual(Array(2).fill('GET v1/state/revision'));
  await transport.disconnectRelay();
});

it('routes requests and account updates with the fleet alone, never a workspace copy', async () => {
  const { transport, relay, local, polls, here, there, peer } = await settledRelay();
  const reads = local.reads;
  await transport.readUsage('codex', '', false, here);
  expect(local.reads).toBe(reads);
  // Every heartbeat can carry other computers' live account usage.
  relay.presence = [
    {
      environmentId: peer,
      online: true,
      seenAt: Date.now(),
      connections: [],
      accountUpdates: [
        {
          connectionId: there,
          epoch: crypto.randomUUID(),
          revision: 1,
          accountChanged: 0,
          authMode: null,
          planType: null,
          creditsCheckedAt: null,
          limitStatus: null,
          snapshot: {
            provider: 'codex',
            checkedAt: Math.floor(Date.now() / 1000),
            windows: [],
            credits: null,
            context: null,
            detail: '',
          },
        },
      ],
    },
  ];
  expect((await polls(2)).reads).toBe(0);
  await transport.disconnectRelay();
});

it('gets the state from relays without the revision endpoint without syncing it again', async () => {
  // The manifest and revision probes were both answered 404 by the fixture's warm-up poll.
  const { transport, apply, polls } = await settledRelay(false);
  expect(await polls(3)).toEqual({ state: Array(3).fill('GET v1/state'), reads: 0 });
  expect(apply).not.toHaveBeenCalled();
  await transport.disconnectRelay();
});

it('publishes a running reply every poll without downloading the relay copy', async () => {
  const { transport, workspace, relay, local, polls } = await settledRelay();
  local.runs.push(crypto.randomUUID());
  // A reply changes this device between polls, and every poll sends its progress on.
  for (const title of ['Progress 1', 'Progress 2']) {
    workspace.conversations[0].title = title;
    local.changes++;
    // The relay still holds the baseline, so its revision answers instead of the whole state,
    // and rewriting the whole checkpoint waits until the reply has run for a while.
    expect((await polls(1)).state).toEqual(['GET v1/state/revision', 'PUT v1/state']);
    expect(relay.workspace.conversations[0].title).toBe(title);
  }
  // A reply waiting on a long tool call changes nothing, so its polls read nothing either.
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });
  // Once the interval passes, the next poll of the reply saves the checkpoint again.
  later();
  workspace.conversations[0].title = 'Progress 3';
  local.changes++;
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  vi.useRealTimers();
  local.runs.length = 0;
  await transport.disconnectRelay();
});

it('syncs and saves a workspace past the former 20 MB limit', async () => {
  const { transport, workspace, relay, local, polls } = await settledRelay();
  // Comfortably past the limit this app and its relay used to reject.
  workspace.conversations[0].messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    createdAt: '2026-09-26',
    status: 'complete',
    blocks: [{ type: 'markdown', text: 'x'.repeat(25_000_000) }],
  });
  local.changes++;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'PUT v1/state',
    'save_sync_state',
  ]);
  expect(relay.workspace.conversations[0].messages).toHaveLength(1);
  expect(JSON.stringify(relay.workspace).length).toBeGreaterThan(20_000_000);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  await transport.disconnectRelay();
});

// A relay with per-conversation revisions, so a poll publishes and takes in only what moved.
// `saved` replaces the checkpoint a restart reads, `onCheckpoint` runs as one is written, and
// `flush` stands in for the page writing its unsaved changes.
async function incrementalRelay(
  options: {
    saved?: (base: SharedWorkspace) => unknown;
    onCheckpoint?: (live: { workspace: Workspace; mark: (chatId?: string) => void }) => void;
    flush?: () => Promise<void>;
    started?: boolean;
    // Whether the relay keeps an image store, and which of the hashes this computer is asked
    // to upload the relay still lacks afterwards.
    images?: boolean;
    upload?: (hashes: string[]) => string[];
    // Changes this device makes before its first sync, which the relay does not have.
    prepare?: (workspace: Workspace) => void;
  } = {},
) {
  const transport = await import('./transport');
  const workspace = initialWorkspace();
  const chat = (title: string) => ({
    id: crypto.randomUUID(),
    title,
    createdAt: '2026-09-26',
    updatedAt: '2026-09-26',
    settings: { provider: 'codex' as const, model: '', reasoning: '' as const, instructions: '' },
    messages: [],
  });
  workspace.conversations.push(chat('First'), chat('Second'));
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'QA',
    platform: 'windows' as const,
  };
  workspace.fleet.computers.push({ id: installation.computerId, name: 'QA' });
  workspace.fleet.environments.push({
    id: installation.id,
    computerId: installation.computerId,
    name: 'QA',
    platform: 'windows',
  });
  const local = { changes: 0, reads: 0, runs: [] as string[] };
  const marks = chatMarks(options.started);
  transport.configureRuntime({
    installation,
    workspace: () => {
      local.reads++;
      return workspace;
    },
    shared: () => {
      local.reads++;
      return sharedWorkspace(workspace);
    },
    ...chatRuntime(() => workspace, marks),
    fleet: () => workspace.fleet,
    revision: () => local.changes,
    statuses: () => ({}),
    localRuns: () => local.runs,
    apply: async (value) => {
      local.reads++;
      Object.assign(workspace, value);
    },
    checkpointRun: async () => {},
    ...(options.flush ? { flush: options.flush } : {}),
  });
  // The relay's own copy, with the revision that last changed each part of it.
  const relay = {
    revision: 5,
    metaRevision: 5,
    workspace: sharedWorkspace(workspace),
    chats: Object.fromEntries(workspace.conversations.map((c) => [c.id, 5])),
  };
  const requests: string[] = [];
  // What each checkpoint write sent, as the host received it.
  const checkpointWrites: { value: any; order?: string[]; upsert?: Conversation[] }[] = [];
  // What the host has on disk, which a restart reads back.
  let saved: unknown = options.saved?.(relay.workspace) ?? {
    url: 'https://relay.example.com',
    instanceId: 'same-relay',
    base: relay.workspace,
  };
  const manifest = () => ({
    instanceId: 'same-relay',
    revision: relay.revision,
    metaRevision: relay.metaRevision,
    chats: relay.chats,
  });
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_resume') return 'https://relay.example.com/';
    if (command === 'load_sync_state') return saved;
    if (command === 'save_sync_state') {
      checkpointWrites.push(args);
      saved = writtenCheckpoint(saved, args);
      requests.push('save_sync_state');
      options.onCheckpoint?.({
        workspace,
        mark: (chatId) => {
          local.changes++;
          marks.mark(chatId);
        },
      });
    }
    if (command === 'upload_chat_images') {
      requests.push('upload_chat_images');
      return options.upload?.(args.hashes) ?? [];
    }
    if (command !== 'relay_request') return null;
    requests.push(`${args.method} ${args.path}`);
    if (args.path === 'v1/state/manifest') return { status: 200, body: manifest() };
    if (args.path === 'v1/state/meta') {
      const { conversations, ...meta } = relay.workspace;
      return { status: 200, body: { ...manifest(), meta } };
    }
    if (args.path === 'v1/state/chats') {
      const wanted = new Set(args.body.ids);
      return {
        status: 200,
        body: {
          ...manifest(),
          chats: relay.workspace.conversations.filter((c) => wanted.has(c.id)),
          chatRevisions: relay.chats,
        },
      };
    }
    if (args.path === 'v1/state/patch') {
      if (args.body.revision !== relay.revision) return { status: 409, body: manifest() };
      relay.revision++;
      const conversations = relay.workspace.conversations.filter(
        (c) => !(args.body.remove ?? []).includes(c.id),
      );
      for (const id of args.body.remove ?? []) delete relay.chats[id];
      for (const incoming of args.body.upsert ?? []) {
        const at = conversations.findIndex((c) => c.id === incoming.id);
        if (at >= 0) conversations[at] = incoming;
        else conversations.push(incoming);
        relay.chats[incoming.id] = relay.revision;
      }
      if (args.body.meta) {
        relay.workspace = { ...args.body.meta, conversations };
        relay.metaRevision = relay.revision;
      } else relay.workspace = { ...relay.workspace, conversations };
      return { status: 200, body: manifest() };
    }
    if (args.path === 'v1/state/revision')
      return {
        status: 200,
        body: {
          instanceId: 'same-relay',
          revision: relay.revision,
          ...(options.images ? { images: 1 } : {}),
        },
      };
    if (args.path === 'v1/state')
      return {
        status: 200,
        body: {
          instanceId: 'same-relay',
          revision: relay.revision,
          workspace: relay.workspace,
          chatRevisions: relay.chats,
          metaRevision: relay.metaRevision,
        },
      };
    return { status: 200, body: args.path === 'v1/heartbeat' ? [] : [] };
  });
  options.prepare?.(workspace);
  expect(await transport.resumeRelay()).toBe(true);
  // The first poll takes the whole-state path and learns the relay's per-conversation revisions.
  expect(await transport.pollRelay()).toEqual([]);
  const polls = async (count: number) => {
    const reads = local.reads;
    requests.length = 0;
    for (let i = 0; i < count; i++) expect(await transport.pollRelay()).not.toBeNull();
    return { state: requests.filter((r) => r.includes('state')), reads: local.reads - reads };
  };
  return {
    transport,
    workspace,
    relay,
    local,
    requests,
    polls,
    marks,
    checkpoint: () => saved,
    checkpointWrites,
  };
}

/** A message naming one image in the image store. */
const imageMessage = (hash: string) => ({
  id: crypto.randomUUID(),
  role: 'user' as const,
  blocks: [],
  images: [
    { id: crypto.randomUUID(), name: 'shot.png', mediaType: 'image/png' as const, hash, bytes: 68 },
  ],
  status: 'complete' as const,
  createdAt: '2026-09-27',
});

it('publishes a conversation with images once the relay holds them, asking about each once', async () => {
  const lacking = new Set<string>();
  const { transport, workspace, relay, local, requests, polls, marks } = await incrementalRelay({
    images: true,
    upload: (hashes) => hashes.filter((hash) => lacking.has(hash)),
  });
  const [first, second] = workspace.conversations;
  const hash = 'c'.repeat(64);
  first.messages.push(imageMessage(hash));
  second.title = 'Renamed with it';
  lacking.add(hash);
  local.changes++;
  marks.mark(first.id);
  marks.mark(second.id);
  later();
  await polls(1);
  // This computer cannot give the relay the image, so its conversation waits here while the
  // other one goes out.
  const published = (id: string) => relay.workspace.conversations.find((c) => c.id === id);
  expect(published(first.id)?.messages).toEqual([]);
  expect(published(second.id)?.title).toBe('Renamed with it');
  expect(transport.relaySyncNotice()).toContain('names images the relay does not have yet');
  // Once the image is there, the next poll publishes the conversation.
  lacking.delete(hash);
  await polls(1);
  expect(published(first.id)?.messages).toHaveLength(1);
  expect(transport.relaySyncNotice()).toBe('');
  // The relay holds the image now, so later changes do not ask about it again.
  requests.length = 0;
  first.title = 'Renamed';
  local.changes++;
  marks.mark(first.id);
  await polls(1);
  expect(published(first.id)?.title).toBe('Renamed');
  expect(requests).not.toContain('upload_chat_images');
});

it('hands a conversation the first whole sync held to the incremental polls after it', async () => {
  const lacking = new Set(['c'.repeat(64)]);
  const { transport, workspace, relay, polls } = await incrementalRelay({
    images: true,
    upload: (hashes) => hashes.filter((hash) => lacking.has(hash)),
    prepare: (workspace) => workspace.conversations[0].messages.push(imageMessage('c'.repeat(64))),
  });
  const [first] = workspace.conversations;
  const published = () => relay.workspace.conversations.find((c) => c.id === first.id)!;
  expect(published().messages).toEqual([]);
  expect(transport.relaySyncNotice()).toContain('names images the relay does not have yet');
  // Nothing changes here again, but the next poll sends it once the relay has the image.
  lacking.clear();
  await polls(1);
  expect(published().messages).toHaveLength(1);
  expect(transport.relaySyncNotice()).toBe('');
});

it('keeps conversations with images here while the relay predates the image store', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first] = workspace.conversations;
  first.messages.push(imageMessage('d'.repeat(64)));
  local.changes++;
  marks.mark(first.id);
  later();
  await polls(1);
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.messages).toEqual([]);
  expect(transport.relaySyncNotice()).toContain(
    'Update the relay to sync conversations with images.',
  );
});

it('syncs the whole workspace but a conversation whose images the relay lacks, which waits here', async () => {
  const lacking = new Set<string>();
  const { transport, workspace, relay, local, requests } = await settledRelay(true, lacking);
  const hash = 'e'.repeat(64);
  // One conversation the relay has gains an image, a new one names another, and a third
  // changes without images.
  const [settled] = workspace.conversations;
  settled.messages.push(imageMessage(hash));
  const added = { ...structuredClone(settled), id: crypto.randomUUID(), title: 'New with image' };
  added.messages = [imageMessage('b'.repeat(64))];
  const plain = { ...structuredClone(settled), id: crypto.randomUUID(), title: 'Plain' };
  plain.messages = [];
  workspace.conversations.push(added, plain);
  lacking.add(hash).add('b'.repeat(64));
  local.changes++;
  requests.length = 0;
  expect(await transport.pollRelay()).not.toBeNull();
  expect(requests).toContain('upload_chat_images');
  // Everything else went out; the relay keeps its copy of the first and has no second.
  const published = () => relay.workspace.conversations.map((c) => c.title);
  expect(published()).toEqual(['Settled chat', 'Plain']);
  expect(relay.workspace.conversations[0].messages).toEqual([]);
  expect(transport.relaySyncNotice()).toBe(
    '“Settled chat”, “New with image” name images the relay does not have yet. They sync once the computer that attached them is connected.',
  );
  // Neither was changed here by the relay's copy, or by its absence.
  expect(workspace.conversations.map((c) => c.title)).toEqual([
    'Settled chat',
    'New with image',
    'Plain',
  ]);
  expect(workspace.conversations[0].messages).toHaveLength(1);
  // Once the relay has the images, the next poll sends both.
  lacking.clear();
  requests.length = 0;
  expect(await transport.pollRelay()).not.toBeNull();
  expect(requests).toContain('PUT v1/state');
  // The relay lists the conversation it did not have after the others.
  expect(published()).toEqual(['Settled chat', 'Plain', 'New with image']);
  expect(relay.workspace.conversations[0].messages[0].images).toEqual(
    workspace.conversations[0].messages[0].images,
  );
  expect(transport.relaySyncNotice()).toBe('');
  await transport.disconnectRelay();
});

it('syncs the whole workspace with a relay from before the image store, keeping image chats here', async () => {
  const { transport, workspace, relay, local } = await settledRelay();
  workspace.conversations[0].messages.push(imageMessage('e'.repeat(64)));
  const plain = {
    ...structuredClone(workspace.conversations[0]),
    id: crypto.randomUUID(),
    title: 'Plain',
  };
  plain.messages = [];
  workspace.conversations.push(plain);
  local.changes++;
  expect(await transport.pollRelay()).not.toBeNull();
  expect(relay.workspace.conversations.map((c) => c.title)).toEqual(['Settled chat', 'Plain']);
  expect(relay.workspace.conversations[0].messages).toEqual([]);
  expect(workspace.conversations[0].messages).toHaveLength(1);
  expect(transport.relaySyncNotice()).toBe(
    '“Settled chat” stays on this device. Update the relay to sync conversations with images.',
  );
  await transport.disconnectRelay();
});

/** A reply to run on the other computer, naming one image by hash. */
const imageRun = (workspace: Workspace, connectionId: string, hash: string) => ({
  runId: crypto.randomUUID(),
  agent: { ...settingsFor(workspace.preferences, 'codex'), connectionId },
  messages: [
    { role: 'user' as const, text: 'What does this show?', images: imageMessage(hash).images },
  ],
});

it('sends a reply naming images to another computer only once the relay holds them', async () => {
  const lacking = new Set<string>();
  const { transport, workspace, requests, there } = await settledRelay(true, lacking);
  const hash = 'f'.repeat(64);
  // The computer that runs the reply reads its images from the relay, so none may be missing.
  lacking.add(hash);
  requests.length = 0;
  await expect(transport.runAgent(imageRun(workspace, there, hash), () => {})).rejects.toThrow(
    'An image in this chat is not on the relay yet.',
  );
  expect(requests).toEqual(['upload_chat_images']);
  // Once it is there, the reply goes out naming the image by reference.
  lacking.delete(hash);
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path.startsWith('v1/jobs/'))
      return { status: 200, body: { status: 'complete', events: [], result: 'complete' } };
    return original(command, args);
  });
  expect(await transport.runAgent(imageRun(workspace, there, hash), () => {})).toBe('complete');
  const job = native.invoke.mock.calls.find(
    ([, args]) => args?.method === 'POST' && args?.path === 'v1/jobs',
  );
  expect(job?.[1].body.args.request.messages[0].images).toEqual([
    { id: expect.any(String), name: 'shot.png', mediaType: 'image/png', hash, bytes: 68 },
  ]);
  await transport.disconnectRelay();
});

it('keeps a reply naming images here while the relay predates the image store', async () => {
  const { transport, workspace, requests, there } = await settledRelay();
  requests.length = 0;
  await expect(
    transport.runAgent(imageRun(workspace, there, 'a'.repeat(64)), () => {}),
  ).rejects.toThrow('Update the relay to sync conversations with images.');
  expect(requests).toEqual([]);
  await transport.disconnectRelay();
});

it('publishes only the conversation that changed, and takes in only what moved', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  // Settled: the relay's small revision answers, as nothing moved there, and nothing here is
  // copied or validated whole.
  expect(await polls(2)).toEqual({ state: Array(2).fill('GET v1/state/revision'), reads: 0 });

  // One conversation changes here. Only it is sent, and the other is never downloaded.
  const [first, second] = workspace.conversations;
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'POST v1/state/patch',
    'save_sync_state',
  ]);
  const sent = relay.workspace.conversations.find((c) => c.id === first.id);
  expect(sent?.title).toBe('Renamed here');
  expect(relay.chats[first.id]).toBeGreaterThan(relay.chats[second.id]);
  expect(await polls(1)).toEqual({ state: ['GET v1/state/revision'], reads: 0 });

  // Another device renames the other conversation. Only that one is fetched.
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) =>
      c.id === second.id ? { ...c, title: 'Renamed elsewhere' } : c,
    ),
  };
  relay.chats[second.id] = relay.revision;
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'GET v1/state/manifest',
    'POST v1/state/chats',
    'save_sync_state',
  ]);
  expect(workspace.conversations.find((c) => c.id === second.id)?.title).toBe('Renamed elsewhere');
  expect(workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Renamed here');
  expect(await polls(1)).toEqual({ state: ['GET v1/state/revision'], reads: 0 });
  await transport.disconnectRelay();
});

it('writes the checkpoint at once for a change it takes in other than a reply moving on', async () => {
  // A copy saved after its checkpoint looks edited here after a restart, and merged with a rewind
  // or retry made elsewhere meanwhile it left a conflict copy of the chat. Only a reply's progress
  // waits for the interval.
  const { transport, workspace, relay, local, polls, marks, checkpoint } = await incrementalRelay();
  const id = workspace.conversations[0].id;
  const here = () => workspace.conversations.find((c) => c.id === id)!;
  const elsewhere = (change: (conversation: Conversation) => void) => {
    relay.revision++;
    relay.workspace = {
      ...relay.workspace,
      conversations: relay.workspace.conversations.map((c) => {
        if (c.id !== id) return c;
        const changed = structuredClone(c);
        change(changed);
        return changed;
      }),
    };
    relay.chats[id] = relay.revision;
  };
  // Another device sends a message, and its reply starts.
  elsewhere((c) =>
    c.messages.push(
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '2026-10-09',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Continue' }],
      },
      {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        createdAt: '2026-10-09',
        status: 'running',
        blocks: [{ type: 'markdown', text: 'Work' }],
      },
    ),
  );
  expect((await polls(1)).state).toContain('save_sync_state');
  const saved = () =>
    (checkpoint() as { base: SharedWorkspace }).base.conversations.find((c) => c.id === id)!;
  expect(saved().messages).toHaveLength(2);
  // The reply's progress is saved here, and its checkpoint waits.
  elsewhere((c) => (c.messages[1].blocks = [{ type: 'markdown', text: 'Working' }]));
  expect((await polls(1)).state).not.toContain('save_sync_state');
  expect(here().messages[1].blocks).toEqual([{ type: 'markdown', text: 'Working' }]);
  expect(saved().messages[1].blocks).toEqual([{ type: 'markdown', text: 'Work' }]);
  // The chat moved to History there goes in at once.
  elsewhere((c) => (c.archived = true));
  expect((await polls(1)).state).toContain('save_sync_state');
  expect(saved().archived).toBe(true);
  // A change this computer makes and publishes still writes the checkpoint at intervals. The
  // page edits its own copy of a chat it received, never the baseline’s.
  workspace.conversations = workspace.conversations.map((c) =>
    c.id === id ? { ...structuredClone(c), title: 'Renamed here' } : c,
  );
  local.changes++;
  marks.mark(id);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision', 'POST v1/state/patch']);
  await transport.disconnectRelay();
});

it('sends replicated settings only when they move, and deletes on both sides', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  // A computer added here belongs to the settings the relay keeps beside its conversations.
  workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Laptop' });
  local.changes++;
  marks.mark();
  later();
  expect((await polls(1)).state).toEqual([
    'GET v1/state/revision',
    'POST v1/state/patch',
    'save_sync_state',
  ]);
  expect(relay.workspace.fleet.computers.map((c) => c.name)).toEqual(['QA', 'Laptop']);
  expect(relay.metaRevision).toBe(relay.revision);

  // A conversation deleted here is removed there, and one deleted there disappears here.
  const [first, second] = workspace.conversations;
  workspace.conversations = workspace.conversations.filter((c) => c.id !== first.id);
  local.changes++;
  marks.mark();
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(relay.workspace.conversations.map((c) => c.id)).toEqual([second.id]);
  expect(relay.chats[first.id]).toBeUndefined();
  relay.revision++;
  relay.workspace = { ...relay.workspace, conversations: [] };
  delete relay.chats[second.id];
  expect((await polls(1)).state).toContain('GET v1/state/manifest');
  expect(workspace.conversations).toEqual([]);
  await transport.disconnectRelay();
});

it('resumes from its checkpoint without syncing the whole workspace again', async () => {
  const { transport, workspace, relay, local, polls, marks, checkpoint } = await incrementalRelay();
  const [first] = workspace.conversations;
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  later();
  expect((await polls(1)).state).toContain('save_sync_state');
  // The checkpoint carries the revisions its baseline came from.
  expect(checkpoint()).toMatchObject({
    revisions: { revision: relay.revision, metaRevision: relay.metaRevision },
  });
  // Connecting again reads it back, as a restarted app does, so the first poll is already
  // incremental instead of downloading and uploading the whole workspace once.
  await transport.disconnectRelay();
  expect(await transport.resumeRelay()).toBe(true);
  expect((await polls(1)).state).toEqual(['GET v1/state/revision']);
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Renamed here');
  await transport.disconnectRelay();
});

it('keeps a conversation unpublished when another device wrote first', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first] = workspace.conversations;
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  // The relay moves between this poll's manifest and its patch, so the patch is refused.
  const original = native.invoke.getMockImplementation()!;
  let moved = false;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state/patch' && !moved) {
      moved = true;
      relay.revision++;
      return original(command, { ...args, body: { ...args.body, revision: -1 } });
    }
    return original(command, args);
  });
  expect((await polls(1)).state).toEqual(['GET v1/state/revision', 'POST v1/state/patch']);
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('First');
  // The next poll tries again with a fresh manifest and the change is still there.
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Renamed here');
  await transport.disconnectRelay();
});
it('publishes a change made here while a whole-state sync ran', async () => {
  let ended = false;
  // A reply ends here while the connection's first, whole-state sync writes its checkpoint.
  const { transport, workspace, relay, polls } = await incrementalRelay({
    onCheckpoint: ({ workspace, mark }) => {
      if (ended) return;
      ended = true;
      workspace.conversations[0].title = 'Changed during the whole sync';
      mark(workspace.conversations[0].id);
    },
  });
  expect(ended).toBe(true);
  // That sync read this device before the change, so the next poll publishes it.
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  const [first] = workspace.conversations;
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe(
    'Changed during the whole sync',
  );
  await transport.disconnectRelay();
});

it('keeps an edit made here while the patch was on its way', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first, second] = workspace.conversations;
  // A reply runs here in Second, and its start is already published.
  second.messages.push(
    {
      id: crypto.randomUUID(),
      role: 'user',
      status: 'complete',
      createdAt: '2026-09-27',
      blocks: [{ type: 'markdown', text: 'Go' }],
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      runId: crypto.randomUUID(),
      status: 'running',
      createdAt: '2026-09-27',
      blocks: [{ type: 'markdown', text: 'Working' }],
    },
  );
  local.changes++;
  marks.mark(second.id);
  await polls(1);
  // The phone picks another model for Second's next reply while this device edits First, so
  // the next poll both sends a conversation and takes one in.
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) =>
      c.id === second.id ? { ...c, settings: { ...c.settings, model: 'gpt-5.5' } } : c,
    ),
  };
  relay.chats[second.id] = relay.revision;
  first.title = 'Edited here';
  local.changes++;
  marks.mark(first.id);
  // The reply in Second ends while that poll's patch is on its way.
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request' && args.path === 'v1/state/patch') {
      native.invoke.mockImplementation(original);
      const reply = workspace.conversations.find((c) => c.id === second.id)!.messages.at(-1)!;
      reply.status = 'complete';
      reply.blocks = [{ type: 'markdown', text: 'Working, done' }];
      local.changes++;
      marks.mark(second.id);
    }
    return original(command, args);
  });
  await polls(1);
  const here = workspace.conversations.find((c) => c.id === second.id)!;
  expect(here.settings.model).toBe('gpt-5.5');
  expect(here.messages.at(-1)).toMatchObject({ status: 'complete' });
  // The next poll publishes both changes together.
  await polls(1);
  const there = relay.workspace.conversations.find((c) => c.id === second.id)!;
  expect(there.settings.model).toBe('gpt-5.5');
  expect(there.messages.at(-1)).toMatchObject({ status: 'complete' });
  await transport.disconnectRelay();
});

it('saves unsaved changes before writing a checkpoint', async () => {
  const order: string[] = [];
  const { transport, workspace, local, marks, polls } = await incrementalRelay({
    flush: async () => {
      order.push('flush');
    },
    onCheckpoint: () => order.push('checkpoint'),
  });
  // The connection's first sync wrote one, after saving.
  expect(order).toEqual(['flush', 'checkpoint']);
  workspace.conversations[0].title = 'Renamed here';
  local.changes++;
  marks.mark(workspace.conversations[0].id);
  // Within the interval, a sync publishes without rewriting the whole checkpoint.
  await polls(1);
  expect(order).toEqual(['flush', 'checkpoint']);
  // After it, the next sync catches the checkpoint up, again after saving.
  later();
  await polls(1);
  expect(order).toEqual(['flush', 'checkpoint', 'flush', 'checkpoint']);
  await transport.disconnectRelay();
});

it('publishes a change at once after the poll under way', async () => {
  const { transport, workspace, relay, local, marks } = await incrementalRelay();
  // A poll is under way, past reading this device, when a reply ends here.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const original = native.invoke.getMockImplementation()!;
  let holding = true;
  native.invoke.mockImplementation(async (command, args) => {
    if (holding && command === 'relay_request' && args.path === 'v1/notification-view') {
      holding = false;
      await held;
    }
    return original(command, args);
  });
  const underWay = transport.pollRelay();
  await vi.waitFor(() => expect(holding).toBe(false));
  const [first] = workspace.conversations;
  first.title = 'Reply ended';
  local.changes++;
  marks.mark(first.id);
  // An ordinary poll is skipped while one runs; publishing at once waits for it instead.
  expect(await transport.pollRelay()).toBeNull();
  const now = transport.pollRelayNow();
  release();
  expect(await underWay).not.toBeNull();
  expect(await now).not.toBeNull();
  expect(relay.workspace.conversations.find((c) => c.id === first.id)?.title).toBe('Reply ended');
  await transport.disconnectRelay();
});

// This page's clock, which decides when a conversation's next upload may go.
function pageClock() {
  const clock = { now: 1_000_000 };
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  onTestFinished(() => spy.mockRestore());
  return clock;
}

it('publishes a long conversation again when its turn comes, and at once when a reader waits', async () => {
  // A long chat went to the relay whole with every poll while its reply ran: 9.8 MB each time.
  const clock = pageClock();
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first, second] = workspace.conversations;
  first.messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    createdAt: '2026-10-13',
    status: 'complete',
    blocks: [{ type: 'markdown', text: 'x'.repeat(4_000_000) }],
  });
  const change = (conversation: Conversation, title: string) => {
    conversation.title = title;
    local.changes++;
    marks.mark(conversation.id);
  };
  const remote = (conversation: Conversation) =>
    relay.workspace.conversations.find((c) => c.id === conversation.id)!.title;
  change(first, 'Long, first publish');
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(remote(first)).toBe('Long, first publish');
  // Four megabytes take their turn about eight seconds later, at half a megabyte a second.
  clock.now += 2_000;
  change(first, 'Long, too soon');
  change(second, 'Short, any time');
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(remote(second)).toBe('Short, any time');
  expect(remote(first)).toBe('Long, first publish');
  clock.now += 7_000;
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(remote(first)).toBe('Long, too soon');
  // A change someone waits for, such as a reply's end, goes out at once.
  change(first, 'Long, reply ended');
  expect(await transport.pollRelayNow()).not.toBeNull();
  expect(remote(first)).toBe('Long, reply ended');
  // A conversation another device edited too is merged with the next poll, without waiting its
  // turn: here two edits of it with no reply between them, which leave a conflict copy.
  change(first, 'Long, edited here');
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) =>
      c.id === first.id ? { ...c, archived: true } : c,
    ),
  };
  relay.chats[first.id] = relay.revision;
  const { state } = await polls(1);
  expect(state).toContain('POST v1/state/chats');
  expect(state).toContain('POST v1/state/patch');
  expect(workspace.conversations.find((c) => c.id === first.id)?.archived).toBe(true);
  expect(workspace.conversations.map((c) => c.title)).toContain(
    'Long, edited here (conflict copy)',
  );
  await transport.disconnectRelay();
});

it('publishes a running call’s elapsed time now and then, and with any other change at once', async () => {
  const clock = pageClock();
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first] = workspace.conversations;
  const reply = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant' as const,
    createdAt: '2026-10-13',
    status: 'running' as const,
    blocks: [] as Conversation['messages'][number]['blocks'],
  };
  first.messages.push(reply);
  local.changes++;
  marks.mark(first.id);
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  const tool = (elapsedMs: number, revision: number) => ({
    type: 'activity' as const,
    text: 'Run command',
    tool: {
      id: 'claude:call',
      revision,
      category: 'tool' as const,
      name: 'Run command',
      status: 'running' as const,
      facts: [],
      sources: [],
      agents: [],
      elapsedMs,
    },
  });
  const tick = (second: number) => {
    reply.blocks = [tool(second * 1000, second)];
    local.changes++;
    marks.changes.quiet(first.id, reply.id);
  };
  const remoteElapsed = () => {
    const sent = relay.workspace.conversations.find((c) => c.id === first.id)!;
    const block = sent.messages[0].blocks[0];
    return block?.type === 'activity' ? block.tool?.elapsedMs : undefined;
  };
  // The call ticks every second; the polls in between send nothing.
  for (let second = 1; second <= 6; second++) {
    clock.now += 1_000;
    tick(second);
    if (second % 2 === 0) expect((await polls(1)).state).not.toContain('POST v1/state/patch');
  }
  expect(remoteElapsed()).toBeUndefined();
  // A while later the running time goes out.
  clock.now += 10_000;
  tick(16);
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(remoteElapsed()).toBe(16_000);
  // Any other change goes out with the next poll, taking the running time along.
  clock.now += 1_000;
  tick(17);
  first.title = 'Call finished';
  marks.mark(first.id);
  expect((await polls(1)).state).toContain('POST v1/state/patch');
  expect(remoteElapsed()).toBe(17_000);
  await transport.disconnectRelay();
});

it('writes the checkpoint with only the conversations that changed, and whole when asked', async () => {
  const { transport, workspace, local, polls, marks, checkpoint, checkpointWrites } =
    await incrementalRelay();
  const [first, second] = workspace.conversations;
  // The first whole sync wrote everything.
  expect(checkpointWrites.at(-1)).toEqual({ value: expect.anything() });
  first.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  later();
  expect((await polls(1)).state).toContain('save_sync_state');
  const write = checkpointWrites.at(-1)!;
  expect(write.order).toEqual([first.id, second.id]);
  expect(write.upsert?.map((c) => c.id)).toEqual([first.id]);
  expect(write.value.base.conversations).toBeUndefined();
  const held = (checkpoint() as { base: SharedWorkspace }).base.conversations;
  expect(held.map((c) => [c.id, c.title])).toEqual([
    [first.id, 'Renamed here'],
    [second.id, 'Second'],
  ]);
  // A host that cannot complete it from its file asks for everything, which follows at once.
  const original = native.invoke.getMockImplementation()!;
  let refused = 0;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'save_sync_state' && args.order) {
      refused++;
      throw 'The whole sync checkpoint is needed to save this change.';
    }
    return original(command, args);
  });
  second.title = 'Renamed too';
  local.changes++;
  marks.mark(second.id);
  later();
  expect((await polls(1)).state).toContain('save_sync_state');
  expect(refused).toBe(1);
  expect(checkpointWrites.at(-1)).toEqual({ value: expect.anything() });
  expect(
    (checkpoint() as { base: SharedWorkspace }).base.conversations.map((c) => c.title),
  ).toEqual(['Renamed here', 'Renamed too']);
  await transport.disconnectRelay();
});

it('reads conversations the relay leaves for another request', async () => {
  const { transport, workspace, relay, polls } = await incrementalRelay();
  // Another device renames both conversations, and the relay answers one per request.
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) => ({
      ...c,
      title: `${c.title} elsewhere`,
    })),
  };
  for (const c of relay.workspace.conversations) relay.chats[c.id] = relay.revision;
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command, args) => {
    const answer = await original(command, args);
    if (command !== 'relay_request' || args.path !== 'v1/state/chats') return answer;
    const [head, ...rest] = answer.body.chats;
    return {
      ...answer,
      body: { ...answer.body, chats: [head], rest: rest.map((c: Conversation) => c.id) },
    };
  });
  const { state } = await polls(1);
  expect(state.filter((r) => r === 'POST v1/state/chats')).toHaveLength(2);
  expect(workspace.conversations.map((c) => c.title)).toEqual([
    'First elsewhere',
    'Second elsewhere',
  ]);
  await transport.disconnectRelay();
});

it('sends a conversation larger than one upload in an upload of its own, beside the others', async () => {
  const { transport, workspace, relay, local, polls, marks } = await incrementalRelay();
  const [first, second] = workspace.conversations;
  // Past what one upload carries, as a conversation holding a long transcript can be.
  const large = { type: 'markdown' as const, text: 'x'.repeat(49_000_000) };
  first.messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    createdAt: '2026-09-27',
    status: 'complete',
    blocks: [large],
  });
  second.title = 'Renamed here';
  local.changes++;
  marks.mark(first.id);
  marks.mark(second.id);
  const { state } = await polls(1);
  // Each goes out in an upload of its own, and nothing is left out.
  expect(state.filter((r) => r === 'POST v1/state/patch')).toHaveLength(2);
  expect(relay.workspace.conversations.find((c) => c.id === second.id)?.title).toBe('Renamed here');
  const sent = relay.workspace.conversations.find((c) => c.id === first.id)!;
  expect(sent.messages.map((m) => m.blocks)).toEqual([[large]]);
  expect(transport.relaySyncNotice()).toBe('');
  // The relay holds what this device wrote, so an edit there merges with it, with no copy.
  relay.revision++;
  relay.workspace = {
    ...relay.workspace,
    conversations: relay.workspace.conversations.map((c) =>
      c.id === first.id ? { ...c, title: 'Renamed elsewhere' } : c,
    ),
  };
  relay.chats[first.id] = relay.revision;
  await polls(1);
  const here = workspace.conversations.find((c) => c.id === first.id)!;
  expect(here.title).toBe('Renamed elsewhere');
  expect(here.messages.map((m) => m.blocks)).toEqual([[large]]);
  expect(workspace.conversations.map((c) => c.title)).toEqual([
    'Renamed elsewhere',
    'Renamed here',
  ]);
  await transport.disconnectRelay();
});

it('asks for the manifest when a checkpoint names none of its conversations', async () => {
  // A checkpoint an earlier release wrote after a whole sync that reported no revisions. The
  // relay is still at its revision, but trusting its empty list would take every conversation
  // for one the relay no longer has.
  const { transport, workspace, relay, requests, polls } = await incrementalRelay({
    started: true,
    saved: (base) => ({
      url: 'https://relay.example.com',
      instanceId: 'same-relay',
      base,
      revisions: { revision: 5, chats: {}, metaRevision: 0 },
    }),
  });
  expect(workspace.conversations.map((c) => c.title)).toEqual(['First', 'Second']);
  expect(relay.workspace.conversations).toHaveLength(2);
  // The first poll asked for the manifest and learned the relay's own revisions.
  expect(requests).toContain('GET v1/state/manifest');
  expect(await polls(1)).toEqual({ state: ['GET v1/state/revision'], reads: 0 });
  await transport.disconnectRelay();
});

it('deletion waits for the remote response to stop and merges its final checkpoint', async () => {
  const connection = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  const original = native.invoke.getMockImplementation()!;
  const order: string[] = [];
  let reads = 0;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'relay_request') {
      if (args.path === `v1/jobs/${runId}/cancel`) {
        order.push('cancel');
        return { status: 200, body: {} };
      }
      if (args.path === `v1/jobs/${runId}`) {
        const status = ++reads === 1 ? 'running' : 'cancelled';
        order.push(status);
        return { status: 200, body: { status } };
      }
      if (args.path === 'v1/state') order.push('checkpoint');
    }
    return original(command, args);
  });
  await transport.cancelRun(runId, connection, true);
  expect(order).toEqual(['cancel', 'running', 'cancelled', 'checkpoint']);
  expect(native.invoke.mock.calls.some(([command]) => command === 'cancel_run')).toBe(false);
});

it('a remote cancellation error never falls back to stopping a local run', async () => {
  const connection = crypto.randomUUID();
  const transport = await fixture(connection);
  await transport.resumeRelay();
  native.invoke.mockResolvedValueOnce({ status: 503, body: { error: 'Host unavailable' } });
  await expect(transport.cancelRun(crypto.randomUUID(), connection, true)).rejects.toThrow();
  expect(native.invoke.mock.calls.some(([command]) => command === 'cancel_run')).toBe(false);
});

it('leaves an unpaired desktop local and retries a temporary startup outage', async () => {
  const transport = await fixture();
  native.invoke.mockResolvedValueOnce(null);
  expect(await transport.resumeRelay()).toBe(false);
  native.invoke.mockRejectedValueOnce('Cannot connect to the relay');
  await expect(transport.resumeRelay()).rejects.toBe('Cannot connect to the relay');
  expect(await transport.resumeRelay()).toBe(true);
});

it('does not silently merge a replaced relay during automatic restoration', async () => {
  const transport = await fixture();
  native.invoke
    .mockResolvedValueOnce('https://relay.example.com/')
    .mockResolvedValueOnce({ status: 200, body: { instanceId: 'replacement' } });
  await expect(transport.resumeRelay()).rejects.toThrow('Relay data was replaced');
  expect(await transport.pollRelay()).toBeNull();
  expect(native.invoke.mock.calls.some(([, args]) => args?.method === 'PUT')).toBe(false);
});

it('an explicit disconnect wins over a late restoration', async () => {
  const transport = await fixture();
  let finish!: (value: string) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transport.resumeRelay();
  await transport.disconnectRelay();
  finish('https://relay.example.com/');
  expect(await pending).toBe(false);
  expect(await transport.pollRelay()).toBeNull();
  expect(native.invoke).toHaveBeenCalledWith('relay_disconnect');
});

it('failed forgetting keeps the existing connection available for a retry', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  native.invoke.mockRejectedValueOnce('Cannot remove saved pairing');
  await expect(transport.disconnectRelay()).rejects.toBe('Cannot remove saved pairing');
  expect(await transport.pollRelay()).toEqual([]);
});

it('hides administration for older relays without hiding mutation errors', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  native.invoke.mockResolvedValueOnce({ status: 404, body: { error: 'Not found' } });
  expect(await transport.readWorkspaceAdministration()).toBeNull();
  native.invoke.mockResolvedValueOnce({
    status: 404,
    body: { error: 'Workspace not found', code: 'workspace_not_found' },
  });
  await expect(transport.updateManagedWorkspace('missing', 'Name', 'member')).rejects.toMatchObject(
    { status: 404, code: 'workspace_not_found' },
  );
});

it('uses typed private administration requests without persisting newly issued keys', async () => {
  const transport = await fixture();
  await transport.resumeRelay();
  const workspace = {
    id: crypto.randomUUID(),
    name: 'Member workspace',
    role: 'member' as const,
    enabled: true,
    createdAt: Date.now(),
  };
  native.invoke.mockResolvedValueOnce({
    status: 201,
    body: { workspace, token: 'synthetic-issued-private-workspace-key' },
  });
  const result = await transport.createManagedWorkspace(workspace.name, workspace.role);
  expect(result?.workspace).toEqual(workspace);
  expect(result?.token).toBe('synthetic-issued-private-workspace-key');
  expect(native.invoke).toHaveBeenLastCalledWith('relay_request', {
    method: 'POST',
    path: 'v1/workspace-admin/workspaces',
    body: { name: workspace.name, role: 'member' },
  });
  expect(
    native.invoke.mock.calls.some(([command]) =>
      ['save_workspace', 'save_sync_state'].includes(command),
    ),
  ).toBe(false);
  native.invoke.mockResolvedValueOnce({
    status: 403,
    body: { error: 'An administrator role is required.', code: 'admin_required' },
  });
  await expect(transport.disableManagedWorkspace(workspace.id)).rejects.toMatchObject({
    status: 403,
    code: 'admin_required',
  });
});

it('discards a late native administration key after the connection changes', async () => {
  const transport = await fixture();
  const connectionChanges: boolean[] = [];
  const stopWatching = transport.watchRelayConnection((ready) => connectionChanges.push(ready));
  await transport.resumeRelay();
  let finish!: (response: unknown) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transport.rotateManagedWorkspaceKey(crypto.randomUUID());
  const rejected = expect(pending).rejects.toMatchObject({
    message: 'The private workspace connection changed.',
    status: 401,
  });
  await transport.disconnectRelay();
  finish({ status: 200, body: { token: 'synthetic-secret-must-not-reach-the-old-view' } });
  await rejected;
  expect(transport.relayConnectionGeneration()).toBeNull();
  await expect(transport.readWorkspaceAdministration()).rejects.toMatchObject({ status: 401 });
  expect(connectionChanges).toEqual([true, false]);
  stopWatching();
  await transport.resumeRelay();
  expect(connectionChanges).toEqual([true, false]);
});
