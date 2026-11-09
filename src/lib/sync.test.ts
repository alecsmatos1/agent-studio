import { describe, expect, it } from 'vitest';
import {
  copiedReplyError,
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Message,
} from './domain';
import {
  applySharedMeta,
  emptyShared,
  mergeShared,
  metaOf,
  onlyRepliesMoved,
  replaceFields,
  sameMeta,
  sameShared,
  sharedSchema,
  sharedWorkspace,
} from './sync';
import { registerInstallation } from './fleet';
import { sameFolderIcons } from './folder-icons';
import { assignAccountColors, withAccountColor } from './account-colors';
import { withSnooze, withoutSnooze } from './snoozes';
import { withPin, withoutPin } from './pins';
import { withMove, withoutRanks } from './sidebar-order';
import { snapshotFor, type UsageSnapshot } from './usage';

const chat = (): Conversation => ({
  id: crypto.randomUUID(),
  settings: settingsFor(initialWorkspace().preferences),
  title: 'Original',
  createdAt: '2026-09-08',
  updatedAt: '2026-09-08',
  messages: [],
});
describe('workspace replication', () => {
  it('compares shared workspaces by item, whatever order each device keeps', () => {
    const first = chat(),
      second = chat();
    const local = { ...emptyShared(), conversations: [second, first] };
    const merged = { ...emptyShared(), conversations: [first, second] };
    expect(sameShared(local, merged)).toBe(true);
    expect(sameShared(local, { ...merged, conversations: [first] })).toBe(false);
    expect(sameShared(local, { ...merged, conversations: [first, first] })).toBe(false);
    expect(
      sameShared(local, { ...merged, conversations: [first, { ...second, title: 'Renamed' }] }),
    ).toBe(false);
    expect(sameShared(local, { ...merged, claudeInstructions: '' })).toBe(false);
  });
  it('syncs app sessions and keeps them when the relay predates them', () => {
    const session = (hour: number) => ({
      id: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      startedAt: new Date(2026, 8, 25, hour).toISOString(),
    });
    const [kept, ours, theirs] = [session(8), session(9), session(10)];
    const base = { ...emptyShared(), appSessions: [kept] };
    const local = { ...base, appSessions: [kept, ours] };
    const remote = { ...base, appSessions: [kept, theirs] };
    expect(mergeShared(base, local, remote).appSessions).toEqual([kept, ours, theirs]);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(sharedSchema.parse(local).appSessions).toEqual(local.appSessions);
    expect(mergeShared(base, local, older).appSessions).toEqual(local.appSessions);
    expect(sameShared(older, local)).toBe(true);
    // A relay that holds sessions this device lacks, or other ones, differs.
    expect(sameShared(remote, emptyShared())).toBe(false);
    expect(sameShared(remote, local)).toBe(false);
    expect(sameShared(local, { ...local, appSessions: [ours, kept] })).toBe(true);
    // No list stays absent, as older relays store it.
    expect('appSessions' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
  });
  it('syncs folder icons and keeps them when the relay predates them', () => {
    const icon = (path: string, name: string) => ({
      environmentId: crypto.randomUUID(),
      path,
      icon: name,
      chosenAt: new Date(2026, 9, 2).toISOString(),
    });
    const [kept, ours, theirs] = [
      icon('/kept', 'code'),
      icon('/ours', 'bot'),
      icon('/theirs', 'map'),
    ];
    const base = { ...emptyShared(), folderIcons: [kept] };
    const local = { ...base, folderIcons: [kept, ours] };
    const remote = { ...base, folderIcons: [kept, theirs] };
    expect(
      sameFolderIcons(mergeShared(base, local, remote).folderIcons, [kept, ours, theirs]),
    ).toBe(true);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(sharedSchema.parse(local).folderIcons).toEqual(local.folderIcons);
    expect(mergeShared(base, local, older).folderIcons).toEqual(local.folderIcons);
    expect(sameShared(older, local)).toBe(true);
    // A relay that holds icons this device lacks, or other ones, differs.
    expect(sameShared(remote, emptyShared())).toBe(false);
    expect(sameShared(remote, local)).toBe(false);
    expect(sameShared(local, { ...local, folderIcons: [ours, kept] })).toBe(true);
    // No list stays absent, as older relays store it, and a saved workspace keeps its icons.
    expect('folderIcons' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
    const saved = restoreWorkspace({ ...initialWorkspace(), folderIcons: local.folderIcons });
    expect(saved.folderIcons).toEqual(local.folderIcons);
    expect(sharedWorkspace(saved).folderIcons).toEqual(local.folderIcons);
  });
  it('syncs account colors and keeps them when the relay predates them', () => {
    const account = (name: string) => ({
      id: crypto.randomUUID(),
      name,
      provider: 'claude' as const,
      purpose: 'personal' as const,
    });
    const [kept, ours, theirs] = [account('Kept'), account('Ours'), account('Theirs')];
    const fleet = (...accounts: ReturnType<typeof account>[]) => ({
      ...emptyShared().fleet,
      accounts,
    });
    const base = {
      ...emptyShared(),
      fleet: fleet(kept),
      accountColors: assignAccountColors(undefined, [kept]),
    };
    // Each device adds an account, which takes a color there.
    const local = {
      ...base,
      fleet: fleet(kept, ours),
      accountColors: assignAccountColors(base.accountColors, [kept, ours]),
    };
    const remote = {
      ...base,
      fleet: fleet(kept, theirs),
      accountColors: assignAccountColors(base.accountColors, [kept, theirs]),
    };
    const merged = mergeShared(base, local, remote);
    expect(merged.fleet.accounts.map((a) => a.name).sort()).toEqual(['Kept', 'Ours', 'Theirs']);
    expect(merged.accountColors).toHaveLength(3);
    expect(sharedSchema.parse(merged).accountColors).toEqual(merged.accountColors);
    // Both new accounts took the same next color; the relay's keeps it and ours takes another.
    const colorOf = (list: typeof merged.accountColors, id: string) =>
      list?.find((c) => c.accountId === id)?.color;
    expect(colorOf(local.accountColors, ours.id)).toBe(colorOf(remote.accountColors, theirs.id));
    expect(colorOf(merged.accountColors, theirs.id)).toBe(colorOf(remote.accountColors, theirs.id));
    expect(new Set(merged.accountColors!.map((c) => c.color)).size).toBe(3);
    // The color the user chose on one device reaches the other, which kept the one it had.
    const chosen = {
      ...local,
      accountColors: withAccountColor(
        local.accountColors,
        kept.id,
        'teal',
        new Date(2026, 9, 12).toISOString(),
      ),
    };
    expect(mergeShared(local, local, chosen).accountColors).toEqual(chosen.accountColors);
    expect(mergeShared(local, chosen, local).accountColors).toEqual(chosen.accountColors);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = { ...emptyShared(), fleet: local.fleet };
    expect(mergeShared(base, local, { ...older, fleet: base.fleet }).accountColors).toEqual(
      local.accountColors,
    );
    expect(sameShared(older, local)).toBe(true);
    // A relay that holds colors this device lacks, or other ones, differs.
    expect(sameShared(local, older)).toBe(false);
    expect(sameShared(chosen, local)).toBe(false);
    expect(
      sameShared(local, { ...local, accountColors: [...local.accountColors!].reverse() }),
    ).toBe(true);
    // The settings alone compare the same way, but a relay without the list differs there: the
    // incremental path then sends it.
    expect(sameMeta(metaOf(chosen), metaOf(local))).toBe(false);
    expect(sameMeta(metaOf(older), metaOf(local))).toBe(false);
    expect(
      sameMeta(metaOf(local), {
        ...metaOf(local),
        accountColors: [...local.accountColors!].reverse(),
      }),
    ).toBe(true);
    // No list stays absent, as older relays store it, and a saved workspace keeps its colors.
    expect('accountColors' in mergeShared(emptyShared(), emptyShared(), emptyShared())).toBe(false);
    const saved = restoreWorkspace({
      ...initialWorkspace(),
      fleet: local.fleet,
      accountColors: local.accountColors,
    });
    expect(saved.accountColors).toEqual(local.accountColors);
    expect(sharedWorkspace(saved).accountColors).toEqual(local.accountColors);
  });
  it('syncs snoozes and keeps them when the relay predates them', () => {
    const [kept, ours, theirs] = [chat(), chat(), chat()];
    const held = (id: string) => [kept, ours, theirs].find((c) => c.id === id);
    const at = new Date(2026, 9, 14);
    const base = { ...emptyShared(), snoozes: withSnooze(undefined, kept, held, at) };
    const local = { ...base, snoozes: withSnooze(base.snoozes, ours, held, at) };
    const remote = { ...base, snoozes: withSnooze(base.snoozes, theirs, held, at) };
    const merged = mergeShared(base, local, remote);
    expect(merged.snoozes?.map((s) => s.conversationId)).toEqual(
      [kept.id, ours.id, theirs.id].sort(),
    );
    expect(sharedSchema.parse(merged).snoozes).toEqual(merged.snoozes);
    // Closed on one device, the snooze ends on the other.
    const closed = { ...local, snoozes: withoutSnooze(local.snoozes, kept.id, held) };
    expect(mergeShared(local, closed, local).snoozes).toEqual(closed.snoozes);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(mergeShared(base, local, older).snoozes).toEqual(local.snoozes);
    expect(sameShared(older, local)).toBe(true);
    expect(sameShared(local, older)).toBe(false);
    expect(sameShared(local, { ...local, snoozes: [...local.snoozes].reverse() })).toBe(true);
    expect(sameMeta(metaOf(older), metaOf(local))).toBe(false);
    expect(sameMeta(metaOf(closed), metaOf(local))).toBe(false);
    // No list stays absent, as older relays store it, and a saved workspace keeps its snoozes.
    expect('snoozes' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
    const saved = restoreWorkspace({ ...initialWorkspace(), snoozes: local.snoozes });
    expect(saved.snoozes).toEqual(local.snoozes);
    expect(sharedWorkspace(saved).snoozes).toEqual(local.snoozes);
  });
  it('syncs pins and keeps them when the relay predates them', () => {
    const [kept, ours, theirs] = [chat(), chat(), chat()];
    const at = new Date(2026, 10, 1);
    const base = { ...emptyShared(), pins: withPin(undefined, kept.id, at) };
    const local = { ...base, pins: withPin(base.pins, ours.id, at) };
    const remote = { ...base, pins: withPin(base.pins, theirs.id, at) };
    const merged = mergeShared(base, local, remote);
    expect(merged.pins?.map((p) => p.conversationId)).toEqual([kept.id, ours.id, theirs.id].sort());
    expect(sharedSchema.parse(merged).pins).toEqual(merged.pins);
    // Unpinned on one device, the chat is unpinned on the other.
    const unpinned = { ...local, pins: withoutPin(local.pins, kept.id) };
    expect(mergeShared(local, unpinned, local).pins).toEqual(unpinned.pins);
    expect(mergeShared(local, local, unpinned).pins).toEqual(unpinned.pins);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(mergeShared(base, local, older).pins).toEqual(local.pins);
    expect(sameShared(older, local)).toBe(true);
    expect(sameShared(local, older)).toBe(false);
    expect(sameShared(local, { ...local, pins: [...local.pins].reverse() })).toBe(true);
    expect(sameMeta(metaOf(older), metaOf(local))).toBe(false);
    expect(sameMeta(metaOf(unpinned), metaOf(local))).toBe(false);
    // No list stays absent, as older relays store it, and a saved workspace keeps its pins.
    expect('pins' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
    const saved = restoreWorkspace({ ...initialWorkspace(), pins: local.pins });
    expect(saved.pins).toEqual(local.pins);
    expect(sharedWorkspace(saved).pins).toEqual(local.pins);
  });
  it("syncs the sidebar's order and keeps it when the relay predates it", () => {
    const [a, b, c] = [chat(), chat(), chat()];
    const at = new Date(2026, 10, 9);
    const base = {
      ...emptyShared(),
      sidebarOrder: withMove(undefined, 'chats', [a.id, b.id], b.id, 0, at),
    };
    // One device moves a folder, the other a chat: both moves stand.
    const local = {
      ...base,
      sidebarOrder: withMove(base.sidebarOrder, 'folders', ['one', 'two'], 'two', 0, at),
    };
    const remote = {
      ...base,
      sidebarOrder: withMove(base.sidebarOrder, 'chats', [b.id, a.id, c.id], c.id, 0, at),
    };
    const merged = mergeShared(base, local, remote);
    expect(merged.sidebarOrder?.folders).toEqual(local.sidebarOrder?.folders);
    expect(merged.sidebarOrder?.chats).toEqual(remote.sidebarOrder?.chats);
    expect(sharedSchema.parse(merged).sidebarOrder).toEqual(merged.sidebarOrder);
    // A deleted chat's place goes on the other device too.
    const forgot = { ...local, sidebarOrder: withoutRanks(local.sidebarOrder, 'chats', [a.id]) };
    expect(mergeShared(local, forgot, local).sidebarOrder).toEqual(forgot.sidebarOrder);
    expect(mergeShared(local, local, forgot).sidebarOrder).toEqual(forgot.sidebarOrder);
    // An older relay drops the order; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(mergeShared(base, local, older).sidebarOrder).toEqual(local.sidebarOrder);
    expect(sameShared(older, local)).toBe(true);
    expect(sameShared(local, older)).toBe(false);
    expect(sameMeta(metaOf(older), metaOf(local))).toBe(false);
    expect(sameMeta(metaOf(forgot), metaOf(local))).toBe(false);
    expect('sidebarOrder' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
    const saved = restoreWorkspace({ ...initialWorkspace(), sidebarOrder: local.sidebarOrder });
    expect(saved.sidebarOrder).toEqual(local.sidebarOrder);
    expect(sharedWorkspace(saved).sidebarOrder).toEqual(local.sidebarOrder);
  });
  it('applies every replicated setting a sync received', () => {
    const kept = chat();
    const received = {
      ...emptyShared(),
      claudeInstructions: '',
      pins: withPin(undefined, kept.id, new Date(2026, 10, 9)),
      sidebarOrder: withMove(undefined, 'folders', ['one', 'two'], 'two', 0),
    };
    const workspace = { ...initialWorkspace(), conversations: [kept] };
    applySharedMeta(workspace, metaOf(received));
    expect(sameMeta(metaOf(sharedWorkspace(workspace)), metaOf(received))).toBe(true);
    expect(workspace.pins).toEqual(received.pins);
    expect(workspace.sidebarOrder).toEqual(received.sidebarOrder);
    expect(workspace.conversations).toEqual([kept]);
    // Settings the relay no longer holds go here too.
    applySharedMeta(workspace, emptyShared());
    expect(workspace.pins).toBeUndefined();
    expect(workspace.sidebarOrder).toBeUndefined();
    expect(workspace.conversations).toEqual([kept]);
  });
  it('migrates v2 and registers only this installation without inventing remote machines or accounts', () => {
    const old = {
      version: 2,
      preferences: initialWorkspace().preferences,
      conversations: [chat()],
    };
    const next = restoreWorkspace(old);
    expect(next.version).toBe(3);
    expect(next.conversations).toEqual(old.conversations);
    const installation = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'Desktop',
      platform: 'windows' as const,
    };
    registerInstallation(next.fleet, installation);
    registerInstallation(next.fleet, installation);
    expect(next.fleet.environments).toHaveLength(1);
    expect(next.fleet.accounts).toEqual([]);
  });
  it('merges independent offline chats and propagates deletions without resurrection', () => {
    const base = emptyShared();
    base.conversations.push(chat());
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations = [chat()];
    remote.conversations.push(chat());
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations.map((c) => c.id)).toEqual([
      local.conversations[0].id,
      remote.conversations[1].id,
    ]);
    expect(mergeShared(merged, structuredClone(merged), merged)).toEqual(merged);
  });
  it('retains concurrent edits and edit-versus-delete as named conflict copies', () => {
    const base = emptyShared();
    base.conversations.push(chat());
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations[0].title = 'Local';
    remote.conversations[0].title = 'Remote';
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations.map((c) => c.title)).toEqual(['Remote', 'Local (conflict copy)']);
    expect(merged.conversations[0].id).toBe(base.conversations[0].id);
    expect(merged.conversations[1].id).not.toBe(base.conversations[0].id);
    remote.conversations = [];
    expect(mergeShared(base, local, remote).conversations[0].title).toBe('Local (conflict copy)');
  });
  it('deletion wins over late reply and generated-title checkpoints while deliberate edits survive', () => {
    const base = emptyShared();
    const conversation = { ...chat(), titleStatus: 'pending' as const };
    conversation.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Hello' }],
    });
    base.conversations.push(conversation);
    const deleted = structuredClone(base);
    deleted.conversations = [];
    const checkpoint = structuredClone(base);
    const completed = checkpoint.conversations[0];
    completed.messages[0].status = 'cancelled';
    completed.messages[0].blocks[0].text = 'Hello world';
    completed.messages[0].durationMs = 500;
    completed.title = 'Generated title';
    completed.titleStatus = 'generated';
    completed.titleSource = { provider: 'codex', model: 'fixture' };
    completed.updatedAt = '2026-09-11';
    for (const [local, remote] of [
      [deleted, checkpoint],
      [checkpoint, deleted],
    ]) {
      expect(mergeShared(base, local, remote).conversations).toEqual([]);
    }
    for (const edit of ['settings', 'title', 'message']) {
      const deliberate = structuredClone(checkpoint);
      const chat = deliberate.conversations[0];
      if (edit === 'settings') chat.settings.instructions = 'Keep this deliberate edit';
      if (edit === 'title') {
        chat.title = 'My title';
        chat.titleStatus = 'fallback';
      }
      if (edit === 'message')
        chat.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: '',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'A new turn' }],
        });
      expect(mergeShared(base, deleted, deliberate).conversations).toHaveLength(1);
      expect(mergeShared(base, deliberate, deleted).conversations).toHaveLength(1);
    }
  });
  it('coalesces copies of the same live response and never downgrades completion', () => {
    const base = emptyShared();
    const c = chat();
    c.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: '' }],
    });
    base.conversations.push(c);
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations[0].messages[0].blocks[0].text = 'Hello';
    remote.conversations[0].messages[0].blocks[0].text = 'Hello world';
    remote.conversations[0].messages[0].status = 'complete';
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.conversations[0].messages[0].status).toBe('complete');
    expect(merged.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    local.conversations[0].messages[0].durationMs = 1200;
    local.conversations[0].messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      createdAt: '',
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Next turn' }],
    });
    const continued = mergeShared(base, local, remote);
    expect(continued.conversations).toHaveLength(1);
    expect(continued.conversations[0].messages).toHaveLength(2);
    expect(continued.conversations[0].messages[0].durationMs).toBe(1200);
  });
  it('keeps the later copy of a reply whose answer started over, instead of copying the chat', () => {
    // A long reply writes its earlier text down as a progress comment when it calls a tool, and
    // its answer starts again, so a copy from an earlier step holds text the later one no longer
    // extends. A phone that saw that step merged it with the finished reply as a conflict copy.
    const runId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const step = (steps: number, text: string) => ({
      id: replyId,
      runId,
      role: 'assistant' as const,
      createdAt: '',
      status: 'running' as const,
      blocks: [
        { type: 'markdown' as const, text },
        ...Array.from({ length: steps }, (_, i) => ({
          type: 'activity' as const,
          text: `Progress ${i}`,
          order: i + 1,
          progress: { id: `progress-${i}`, revision: 0 },
        })),
      ],
    });
    const at = (message: Message) => {
      const shared = emptyShared();
      shared.conversations.push({ ...chat(), id: 'chat', messages: [message] });
      return shared;
    };
    const base = at(step(1, 'The fourth round'));
    const earlier = at(step(2, 'The fourth round is running. Before starting it, I reorganised'));
    const later = at({ ...step(4, 'Round 4 is still running.'), status: 'complete' as const });
    const running = at(step(4, 'Round 4 is still running.'));
    for (const [local, remote] of [
      [earlier, later],
      [later, earlier],
      [earlier, running],
      [running, earlier],
    ]) {
      const merged = mergeShared(base, local, remote);
      const newer = local === earlier ? remote : local;
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].messages[0].status).toBe(
        newer.conversations[0].messages[0].status,
      );
      expect(merged.conversations[0].messages[0].blocks).toEqual(
        newer.conversations[0].messages[0].blocks,
      );
    }
    // A copy an older Viewer restored as interrupted yields to the finished one the same way.
    const stopped = at({
      ...step(2, 'The fourth round is running.'),
      status: 'cancelled' as const,
      error: interruptedReplyError,
    });
    const finished = mergeShared(base, stopped, later).conversations;
    expect(finished).toHaveLength(1);
    expect(finished[0].messages[0]).toMatchObject({ status: 'complete' });
    expect(finished[0].messages[0].error).toBeUndefined();
    // Copies at the same step whose answers differ take the relay's, which its computer published.
    const theirs = at(step(2, 'Round 4 is running.'));
    expect(mergeShared(base, earlier, theirs).conversations).toEqual(theirs.conversations);
    // A reply that waited for background work goes on in another turn, which empties the answer
    // the turn before left, before it records anything: that copy is the later one on either
    // side, or a sync in that moment would bring the old answer back under the new turn's work.
    const held = at(step(2, 'The agents are working.'));
    const emptied = at(step(2, ''));
    for (const [local, remote] of [
      [held, emptied],
      [emptied, held],
    ])
      expect(mergeShared(base, local, remote).conversations).toEqual(emptied.conversations);
  });
  it('keeps the reply a reply took over when an older relay drops it', () => {
    const tookOver = crypto.randomUUID();
    const reply = (blocks: number, named: boolean): Message => ({
      id: 'b3f0c7f1-8a0e-4c47-9f64-7a2f9b1d0c11',
      runId: 'f0e5a9d2-3b1c-4c8e-a7d4-2e6b8f9c0a13',
      role: 'assistant',
      createdAt: '',
      status: 'running',
      ...(named ? { tookOver } : {}),
      blocks: Array.from({ length: blocks }, (_, i) => ({ type: 'activity', text: `Step ${i}` })),
    });
    const at = (message: Message) => {
      const shared = emptyShared();
      shared.conversations.push({ ...chat(), id: 'chat', messages: [message] });
      return shared;
    };
    const base = at(reply(1, true));
    // Its own copy moved on too, or only the relay's did.
    for (const local of [at(reply(2, true)), base]) {
      const merged = mergeShared(base, local, at(reply(3, false)));
      expect(merged.conversations[0].messages[0]).toMatchObject({ tookOver });
      expect(merged.conversations[0].messages[0].blocks).toHaveLength(3);
    }
  });
  it('keeps an account switched on one device with the reply another device saw end', () => {
    // A reply hit a usage limit; the desktop switched the chat to another account and went on,
    // while a phone still held the first account and the reply as it was before.
    const first = crypto.randomUUID(),
      second = crypto.randomUUID();
    const conversation = chat();
    conversation.settings.connectionId = first;
    const reply = {
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant' as const,
      createdAt: '',
      status: 'running' as const,
      settings: { ...conversation.settings },
      blocks: [{ type: 'markdown' as const, text: 'Working' }],
    };
    conversation.messages.push(reply);
    const base = { ...emptyShared(), conversations: [conversation] };
    const phone = structuredClone(base);
    phone.conversations[0].messages[0] = {
      ...reply,
      status: 'cancelled',
      error: interruptedReplyError,
    };
    const desktop = structuredClone(base);
    const switched = desktop.conversations[0];
    switched.settings.connectionId = second;
    switched.messages[0] = { ...reply, status: 'error', error: 'You hit your session limit.' };
    switched.messages.push(
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Continue from where you stopped' }],
      },
      {
        ...reply,
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        status: 'complete',
        settings: { ...switched.settings },
        blocks: [{ type: 'markdown', text: 'Continued.' }],
      },
    );
    for (const [local, remote] of [
      [phone, desktop],
      [desktop, phone],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].settings.connectionId).toBe(second);
      expect(merged.conversations[0].messages).toEqual(switched.messages);
    }
    // Switching to two different accounts is still a conflict, never a silent choice.
    const elsewhere = structuredClone(phone);
    elsewhere.conversations[0].settings.connectionId = crypto.randomUUID();
    expect(mergeShared(base, elsewhere, desktop).conversations).toHaveLength(2);
  });
  it('tells a reply moving on from any other change, which the checkpoint must hold at once', () => {
    const conversation = chat();
    conversation.messages.push(
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Go' }],
      },
      {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        createdAt: '',
        status: 'running',
        blocks: [{ type: 'markdown', text: 'Wor' }],
      },
    );
    const moved = structuredClone(conversation);
    moved.messages[1] = {
      ...moved.messages[1],
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Worked' }],
    };
    moved.updatedAt = '2026-10-09';
    expect(onlyRepliesMoved(conversation, moved)).toBe(true);
    expect(onlyRepliesMoved(conversation, structuredClone(conversation))).toBe(true);
    const changes: ((c: Conversation) => void)[] = [
      (c) => c.messages.push({ ...c.messages[0], id: crypto.randomUUID() }),
      (c) => c.messages.pop(),
      (c) => (c.messages[1] = { ...c.messages[1], id: crypto.randomUUID() }),
      (c) => (c.messages[0] = { ...c.messages[0], blocks: [{ type: 'markdown', text: 'Stop' }] }),
      (c) => (c.historyRevision = 1),
      (c) => (c.archived = true),
      (c) => (c.title = 'Renamed'),
      (c) => (c.settings = { ...c.settings, model: 'another' }),
    ];
    for (const change of changes) {
      const changed = structuredClone(conversation);
      change(changed);
      expect(onlyRepliesMoved(conversation, changed)).toBe(false);
    }
    // A conversation new to this device is a change of its own.
    expect(onlyRepliesMoved(undefined, conversation)).toBe(false);
  });
  it('lets only the restarted execution host interrupt its dead run over a newer checkpoint', () => {
    const base = emptyShared();
    const c = chat();
    const runId = crypto.randomUUID();
    c.messages.push({
      id: crypto.randomUUID(),
      runId,
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Hel' }],
    });
    base.conversations.push(c);
    const local = structuredClone(base),
      remote = structuredClone(base);
    // This device restarted: its saved copy was restored as interrupted.
    local.conversations[0].messages[0].status = 'cancelled';
    local.conversations[0].messages[0].error = interruptedReplyError;
    // The relay holds a later checkpoint of the same run.
    remote.conversations[0].messages[0].blocks[0].text = 'Hello world';
    const viewer = mergeShared(base, local, remote);
    expect(viewer.conversations[0].messages[0].status).toBe('running');
    expect(viewer.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    const live = mergeShared(base, local, remote, { deadRun: () => false });
    expect(live.conversations[0].messages[0].status).toBe('running');
    const seen: string[] = [];
    const host = mergeShared(base, local, remote, {
      deadRun: (conversation, message) => {
        seen.push(`${conversation.id}:${message.runId}`);
        return true;
      },
    });
    expect(seen).toEqual([`${c.id}:${runId}`]);
    expect(host.conversations[0].messages[0]).toMatchObject({
      status: 'cancelled',
      error: interruptedReplyError,
    });
    expect(host.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    remote.conversations[0].messages[0].status = 'complete';
    const finished = mergeShared(base, local, remote, { deadRun: () => true });
    expect(finished.conversations[0].messages[0].status).toBe('complete');
    expect(finished.conversations[0].messages[0].error).toBeUndefined();
  });
  it('preserves archive and restore changes alongside a concurrent response checkpoint', () => {
    for (const archived of [true, false]) {
      const base = emptyShared();
      const conversation = { ...chat(), archived: !archived };
      conversation.messages.push({
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        createdAt: '',
        status: 'running',
        blocks: [{ type: 'markdown', text: 'Hello' }],
      });
      base.conversations.push(conversation);
      const edited = structuredClone(base);
      edited.conversations[0].archived = archived;
      const checkpoint = structuredClone(base);
      checkpoint.conversations[0].messages[0].status = 'complete';
      checkpoint.conversations[0].messages[0].blocks[0].text = 'Hello world';
      for (const [local, remote] of [
        [edited, checkpoint],
        [checkpoint, edited],
      ]) {
        const merged = mergeShared(base, local, remote);
        expect(merged.conversations).toHaveLength(1);
        expect(merged.conversations[0].id).toBe(conversation.id);
        expect(merged.conversations[0].archived).toBe(archived);
        expect(merged.conversations[0].messages).toEqual(checkpoint.conversations[0].messages);
      }
      // Without a baseline, the copy holding an earlier step of the reply is the earlier one, so
      // the archive state of the copy further along stands, whichever device merges.
      for (const [local, remote] of [
        [edited, checkpoint],
        [checkpoint, edited],
      ]) {
        const merged = mergeShared(emptyShared(), local, remote);
        expect(merged.conversations).toHaveLength(1);
        expect(merged.conversations[0].archived).toBe(!archived);
        expect(merged.conversations[0].messages).toEqual(checkpoint.conversations[0].messages);
      }
    }
  });
  it('takes in a chat this device holds without its baseline when the other copy is further along', () => {
    // A phone saved what a sync took in, then closed before it saved the baseline that came with
    // it. Meanwhile the computer finished the reply, answered another message and moved the chat
    // to History. Merging without a baseline made a conflict copy of the chat, its reply left
    // running for good (2026-10-15).
    const conversation = chat();
    const user = (text: string): Message => ({
      id: crypto.randomUUID(),
      role: 'user',
      status: 'complete',
      createdAt: '2026-10-15T14:15:42.204Z',
      blocks: [{ type: 'markdown', text }],
    });
    const reply = (status: Message['status'], text: string): Message => ({
      id: crypto.randomUUID(),
      role: 'assistant',
      status,
      createdAt: '2026-10-15T14:15:42.204Z',
      runId: crypto.randomUUID(),
      settings: conversation.settings,
      blocks: text ? [{ type: 'markdown', text }] : [],
      plan: { revision: 9, steps: [] },
    });
    const first = reply('running', '');
    conversation.messages.push(user('Increase the memory and install Chunky'), first);
    const phone = { ...emptyShared(), conversations: [conversation] };
    const computer = structuredClone(phone);
    const done = computer.conversations[0];
    Object.assign(done.messages[1], {
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'The server now has more memory.' }],
      plan: { revision: 11, steps: [] },
    });
    done.messages.push(user('Is it running?'), reply('complete', 'Yes.'));
    done.archived = true;
    done.updatedAt = '2026-10-15T15:02:03.116Z';
    for (const [local, remote] of [
      [phone, computer],
      [computer, phone],
    ]) {
      const merged = mergeShared(emptyShared(), local, remote);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0]).toMatchObject({
        id: conversation.id,
        title: 'Original',
        archived: true,
        updatedAt: '2026-10-15T15:02:03.116Z',
      });
      expect(merged.conversations[0].messages).toEqual(done.messages);
    }
    // A copy that holds something the other lacks, such as a message of its own, still keeps
    // both, as nothing tells which device moved the chat.
    const sent = structuredClone(phone);
    sent.conversations[0].messages.push(user('Written on the phone'));
    const merged = mergeShared(emptyShared(), sent, computer);
    expect(merged.conversations.map((c) => c.title)).toEqual([
      'Original',
      'Original (conflict copy)',
    ]);
  });
  it('lets a conversation the Viewer only received follow the relay, never into a copy', () => {
    // The phone holds chats it received but whose baseline it never saved. Meanwhile the
    // computer rewound one and deleted another, and a reply the phone follows moved on.
    const conversation = chat();
    const message = (role: Message['role'], text: string, status: Message['status'] = 'complete') =>
      ({
        id: crypto.randomUUID(),
        role,
        status,
        createdAt: '2026-10-15T16:00:00.000Z',
        blocks: [{ type: 'markdown', text }],
        ...(role === 'assistant'
          ? { runId: crypto.randomUUID(), settings: conversation.settings }
          : {}),
      }) as Message;
    conversation.messages.push(
      message('user', 'Plan the continent'),
      message('assistant', 'Planned.'),
    );
    const following = { ...chat(), title: 'Following' };
    const reply = message('assistant', 'Step 1', 'running');
    following.messages.push(message('user', 'Generate it'), reply);
    const deleted = { ...chat(), title: 'Deleted elsewhere' };
    const unbased = { ...chat(), title: 'Deleted before the baseline' };
    const ownChat = { ...chat(), title: 'Started on the phone' };
    const phone = {
      ...emptyShared(),
      conversations: [conversation, following, deleted, unbased, ownChat],
    };
    const relay = structuredClone(phone);
    relay.conversations = relay.conversations.filter(
      (c) => c.id !== deleted.id && c.id !== unbased.id && c.id !== ownChat.id,
    );
    const rewound = relay.conversations[0];
    rewound.historyRevision = 1;
    rewound.messages = [message('user', 'Plan the island')];
    rewound.archived = true;
    // The relay's copy of the followed reply is a step behind what the phone heard, and the chat
    // moved to History.
    const followed = relay.conversations[1];
    followed.archived = true;
    const ahead = structuredClone(phone.conversations[1]);
    ahead.messages[1] = {
      ...ahead.messages[1],
      blocks: [{ type: 'markdown', text: 'Step 2' }],
      usage: { revision: 2 } as Message['usage'],
    };
    phone.conversations[1] = ahead;
    // The baseline lacks all of them.
    const base = { ...emptyShared(), conversations: [deleted] };
    // Merged as edits, the rewound chat split into a copy and the deleted one came back.
    expect(mergeShared(emptyShared(), phone, relay).conversations.map((c) => c.title)).toEqual([
      'Original',
      'Original (conflict copy)',
      'Following',
      'Deleted elsewhere',
      'Deleted before the baseline',
      'Started on the phone',
    ]);
    const own = new Set([ownChat.id]);
    const merged = mergeShared(base, phone, relay, { received: (id) => !own.has(id) });
    expect(merged.conversations.map((c) => c.title)).toEqual([
      'Original',
      'Following',
      'Started on the phone',
    ]);
    expect(merged.conversations[0]).toEqual(rewound);
    expect(merged.conversations[1]).toMatchObject({ archived: true });
    expect(merged.conversations[1].messages[1].blocks).toEqual([
      { type: 'markdown', text: 'Step 2' },
    ]);
    // A chat the phone changed itself merges as before: its next-reply settings, changed while
    // the computer rewound the chat, stay in a copy.
    const edited = structuredClone(phone);
    edited.conversations[0].settings = { ...conversation.settings, instructions: 'Phone' };
    const kept = mergeShared(emptyShared(), edited, relay, {
      received: (id) => id !== conversation.id && !own.has(id),
    });
    expect(kept.conversations.map((c) => c.title)).toContain('Original (conflict copy)');
  });
  it('never leaves a reply running in a conflict copy, whose run goes on in the original', () => {
    const base = emptyShared();
    const conversation = chat();
    const running: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'running',
      createdAt: '2026-10-15T14:39:32.398Z',
      runId: crypto.randomUUID(),
      settings: conversation.settings,
      blocks: [{ type: 'markdown', text: 'Working' }],
      backgroundWait: 1,
    };
    conversation.messages.push(running);
    base.conversations.push(conversation);
    // The next reply's settings changed on both devices, which keeps both copies.
    const local = structuredClone(base);
    local.conversations[0].settings = { ...conversation.settings, instructions: 'Here' };
    const remote = structuredClone(base);
    remote.conversations[0].settings = { ...conversation.settings, instructions: 'There' };
    const [original, copy] = mergeShared(base, local, remote).conversations;
    expect(original).toEqual(remote.conversations[0]);
    expect(original.messages[0].status).toBe('running');
    expect(copy.id).not.toBe(conversation.id);
    expect(copy.title).toBe('Original (conflict copy)');
    const { backgroundWait, ...stopped } = running;
    expect(backgroundWait).toBe(1);
    expect(copy.messages).toEqual([{ ...stopped, status: 'cancelled', error: copiedReplyError }]);
    // So does a copy a rewind elsewhere leaves.
    const rewound = structuredClone(remote);
    rewound.conversations[0].historyRevision = 1;
    rewound.conversations[0].settings = conversation.settings;
    const kept = mergeShared(base, local, rewound).conversations;
    expect(kept.map((c) => c.messages[0].status)).toEqual(['running', 'cancelled']);
    expect(kept[1].messages[0].error).toBe(copiedReplyError);
  });
  it('surfaces conflicting connection routing instead of silently choosing an account', () => {
    const base = emptyShared();
    base.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.fleet.computers[0].name = 'Local name';
    remote.fleet.computers[0].name = 'Remote name';
    expect(() => mergeShared(base, local, remote)).toThrow('changed on both devices');
  });
  it('merges next-reply settings with an independently completing response on either host', () => {
    const base = emptyShared();
    const conversation = chat();
    conversation.settings.model = 'gpt-6-astra';
    conversation.settings.reasoning = 'low';
    conversation.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [],
      settings: { ...conversation.settings },
      modelName: 'GPT-6-Astra',
    });
    base.conversations.push(conversation);
    const edited = structuredClone(base),
      completed = structuredClone(base);
    edited.conversations[0].settings = {
      ...conversation.settings,
      model: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    completed.conversations[0].messages[0].status = 'complete';
    completed.conversations[0].messages[0].blocks = [
      { type: 'markdown', text: 'Original model response' },
    ];
    for (const [local, remote] of [
      [edited, completed],
      [completed, edited],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].settings).toEqual(edited.conversations[0].settings);
      expect(merged.conversations[0].messages).toEqual(completed.conversations[0].messages);
    }
    // Two deliberate settings edits remain a conflict, never a silent last-writer choice.
    completed.conversations[0].settings.model = 'gpt-5.6-luna';
    expect(mergeShared(base, edited, completed).conversations).toHaveLength(2);
    completed.conversations[0].settings = { ...conversation.settings };
    completed.conversations[0].messages[0].settings!.model = 'a-different-in-flight-model';
    expect(mergeShared(base, edited, completed).conversations).toHaveLength(2);
  });
  it('keeps an account chosen on one device while another device runs the reply', () => {
    const first = crypto.randomUUID(),
      second = crypto.randomUUID();
    const conversation = chat();
    conversation.settings.connectionId = first;
    conversation.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Working' }],
      settings: { ...conversation.settings },
    });
    const base = { ...emptyShared(), conversations: [conversation] };
    const phone = structuredClone(base),
      host = structuredClone(base);
    phone.conversations[0].settings.connectionId = second;
    host.conversations[0].messages[0].status = 'complete';
    host.conversations[0].messages[0].blocks = [{ type: 'markdown', text: 'Done.' }];
    for (const [local, remote] of [
      [phone, host],
      [host, phone],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations).toHaveLength(1);
      // The next message goes to the account chosen; the reply stays with its own.
      expect(merged.conversations[0].settings.connectionId).toBe(second);
      expect(merged.conversations[0].messages).toEqual(host.conversations[0].messages);
      expect(merged.conversations[0].messages[0].settings?.connectionId).toBe(first);
    }
  });
  it('exports shared content without local preferences or injected secrets', () => {
    const workspace = {
      ...initialWorkspace(),
      relayToken: 'not-a-real-token',
      installation: { id: 'private' },
    };
    const shared = sharedWorkspace(workspace);
    expect(Object.keys(shared).sort()).toEqual(['conversations', 'fleet']);
    expect(JSON.stringify(shared)).not.toContain('not-a-real-token');
  });
  it('never uses another connection’s quota reading, even when it is newer', () => {
    const settings = {
      ...settingsFor(initialWorkspace().preferences),
      connectionId: crypto.randomUUID(),
    };
    const reading: UsageSnapshot = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      checkedAt: 500,
      windows: [],
      context: null,
      detail: '',
    };
    expect(snapshotFor({ other: reading }, settings)).toBeUndefined();
  });
});

it('replaces fields in place and drops the ones the copy no longer has', () => {
  // A device kept a removed Undo rewind this way, then published it back to every other one.
  const live: Record<string, unknown> = {
    id: 'a',
    title: 'Old',
    rewind: { removed: [] },
    archived: true,
  };
  const held = live;
  replaceFields(live, { id: 'a', title: 'New', archived: false });
  expect(live).toBe(held);
  expect(live).toEqual({ id: 'a', title: 'New', archived: false });
  expect('rewind' in live).toBe(false);
});
