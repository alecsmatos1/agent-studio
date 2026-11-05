import { describe, expect, it } from 'vitest';
import {
  conversationSchema,
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  type Conversation,
  type Message,
} from './domain';
import { forkConversation, forkPoint } from './forks';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';

const message = (
  role: Message['role'],
  text: string,
  status: Message['status'] = 'complete',
): Message => ({
  id: crypto.randomUUID(),
  role,
  status,
  createdAt: '2026-09-19T12:00:00Z',
  blocks: [{ type: 'markdown', text }],
});
function source(): Conversation {
  const settings = {
    provider: 'codex' as const,
    connectionId: crypto.randomUUID(),
    model: 'test-model',
    reasoning: 'low' as const,
    instructions: 'Preserve this instruction',
  };
  return {
    id: crypto.randomUUID(),
    title: 'Original',
    titleStatus: 'pending',
    archived: true,
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    settings,
    location: {
      computerId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      executionEnvironmentId: crypto.randomUUID(),
      path: '/home/test/project',
    },
    messages: [
      message('user', 'First question'),
      {
        ...message('assistant', 'First answer'),
        settings: { ...settings, model: 'earlier-model' },
      },
      message('user', 'Later question'),
      message('assistant', 'Later answer'),
    ],
  };
}

describe('conversation forks', () => {
  it('copies full history and current settings with independent IDs and nested data', () => {
    const original = source();
    const before = structuredClone(original);
    const fork = forkConversation(original);
    expect(conversationSchema.parse(fork)).toEqual(fork);
    expect(fork).toMatchObject({
      title: 'Original (fork)',
      archived: false,
      titleStatus: 'generated',
      settings: original.settings,
      location: original.location,
    });
    expect(fork.id).not.toBe(original.id);
    // Its first reply forks the source's native session, or an earlier chat's when a fork of a
    // fork has no session of its own yet.
    expect(fork.forkedFrom).toEqual([original.id]);
    expect(forkConversation(fork).forkedFrom).toEqual([fork.id, original.id]);
    expect(fork.createdAt).not.toBe(original.createdAt);
    expect(fork.messages.every((m) => !original.messages.some((o) => o.id === m.id))).toBe(true);
    expect(historyFor(fork)).toEqual(historyFor(original));
    fork.messages[0].blocks[0].text = 'Changed in fork';
    fork.settings.instructions = 'Different';
    fork.location!.path = '/another';
    expect(original).toEqual(before);
    // A title of any length is kept whole.
    original.title = '😀'.repeat(500);
    const long = forkConversation(original);
    expect(long.title).toBe(`${'😀'.repeat(500)} (fork)`);
    expect(conversationSchema.parse(long).title).toBe(long.title);
  });
  it('names the copy of the reply a copied reply took over', () => {
    const original = source();
    original.messages[3].tookOver = original.messages[1].id;
    const fork = forkConversation(original);
    expect(fork.messages[3].tookOver).toBe(fork.messages[1].id);
    expect(conversationSchema.safeParse(fork).success).toBe(true);
    // A reply the fork leaves out is named by no copy.
    original.messages[1].tookOver = crypto.randomUUID();
    expect(forkConversation(original).messages[1]).not.toHaveProperty('tookOver');
  });
  it('branches at the chosen finished reply and retains that reply settings', () => {
    const original = source();
    const fork = forkConversation(original, original.messages[1].id);
    expect(fork.messages).toHaveLength(2);
    expect(fork.settings.model).toBe('earlier-model');
    expect(historyFor(fork).map((m) => m.text)).toEqual(['First question', 'First answer']);
    expect(() => forkConversation(original, original.messages[0].id)).toThrow(/finished reply/);
    expect(() => forkConversation(original, crypto.randomUUID())).toThrow(/finished reply/);
  });
  it('never copies an unfinished turn or revives pending questions', () => {
    const original = source();
    original.messages[3].status = 'running';
    original.messages[3].blocks = [{ type: 'markdown', text: 'Partial output' }];
    original.messages[1].questions = [
      {
        id: crypto.randomUUID(),
        revision: 1,
        status: 'pending',
        questions: [
          { id: 'q', question: 'Old question', header: '', multiSelect: false, options: [] },
        ],
      },
    ];
    expect(forkPoint(original)).toBe(1);
    expect(forkPoint(original, original.messages[3].id)).toBe(-1);
    const fork = forkConversation(original);
    expect(fork.messages).toHaveLength(2);
    expect(fork.messages[1].questions?.[0].status).toBe('cancelled');
    expect(original.messages[1].questions?.[0].status).toBe('pending');
    expect(conversationSchema.safeParse(fork).success).toBe(true);
    original.messages[1].status = 'running';
    expect(() => forkConversation(original)).toThrow(/finished reply/);
  });
  it('retains recorded rich history through export and relay without merging source checkpoints', () => {
    const original = source();
    const runId = crypto.randomUUID();
    original.messages[1].runId = runId;
    original.messages[1].usage = { input: 30, output: 12, scope: 'reply', costUsd: 0.03 };
    original.messages[1].accountUsage = {
      version: 1,
      revision: 2,
      runId,
      before: null,
      after: null,
    };
    original.messages[1].blocks.push({
      type: 'reasoning',
      id: 'thought',
      revision: 1,
      text: 'Recorded reasoning',
      truncated: false,
    });
    original.messages[0].images = [
      {
        id: crypto.randomUUID(),
        name: 'fixture.png',
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
      },
    ];
    original.messages[1].visualizations = [
      { id: 'visual', revision: 1, title: 'Saved visual', source: '<p>Preserved</p>' },
    ];
    original.messages[1].steering = [
      { id: crypto.randomUUID(), runId, sequence: 1, text: 'Keep this correction' },
    ];
    const workspace = initialWorkspace();
    workspace.conversations = [original];
    const base = sharedWorkspace(workspace);
    const fork = forkConversation(original);
    workspace.conversations.unshift(fork);
    const exported = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(exported.conversations[0]).toEqual(fork);
    const remote = structuredClone(base);
    remote.conversations[0].messages.push(message('user', 'Only in original'));
    const merged = mergeShared(base, sharedWorkspace(workspace), remote);
    expect(merged.conversations.find((c) => c.id === fork.id)).toEqual(fork);
    expect(merged.conversations.find((c) => c.id === original.id)?.messages).toHaveLength(5);
    expect(mergeShared(emptyShared(), emptyShared(), merged).conversations).toHaveLength(2);
  });
  it('keeps Standalone and stopped/failed history without changing its outcomes', () => {
    const original = source();
    original.location!.path = '';
    original.messages[3].status = 'error';
    original.messages[3].error = 'Recorded failure';
    const fork = forkConversation(original);
    expect(fork.location).toEqual(original.location);
    expect(fork.messages[3]).toMatchObject({ status: 'error', error: 'Recorded failure' });
    delete original.location;
    expect(forkConversation(original).location).toBeUndefined();
  });
});
