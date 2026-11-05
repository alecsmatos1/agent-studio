import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  conversationSchema,
  filesUndoneMark,
  historyFor,
  lastReplyOf,
  type Conversation,
} from './domain';
import type { DraftContent } from './drafts';
import type { DraftImage } from './images';
import type { QueuedMessage } from './queue';
import {
  returnedDraft,
  rewindConversation,
  rewoundMessage,
  sameReturned,
  undoRewind,
} from './rewind';
import { emptyShared, mergeShared } from './sync';
import { forkConversation } from './forks';

function chat(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Rewind',
    createdAt: '2026-09-19',
    updatedAt: '2026-09-19',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: ['First question', 'First answer', 'Second question', 'Second answer'].map(
      (text, i) => ({
        id: crypto.randomUUID(),
        role: i % 2 ? 'assistant' : 'user',
        status: 'complete',
        createdAt: '2026-09-19',
        blocks: [{ type: 'markdown', text }],
        ...(i % 2 ? { runId: crypto.randomUUID(), durationMs: 500 } : {}),
      }),
    ),
  };
}
// A 1×1 PNG of 68 bytes.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const mention = {
  kind: 'file' as const,
  name: 'src/app.ts',
  path: 'C:\\Projects\\studio\\src\\app.ts',
  token: '@src/app.ts',
};
const image = (name: string): DraftImage => ({
  id: crypto.randomUUID(),
  name,
  mediaType: 'image/png',
  hash: 'a'.repeat(64),
  bytes: 8,
  blob: new Blob([]),
});
const noDraft = (): DraftContent => ({
  text: '',
  images: [],
  mentions: [],
  staleMentions: [],
  mentionScope: 'scope',
});
describe('rewinding saved conversations', () => {
  it('names the reply a message follows, which a native session continues after', () => {
    const original = chat();
    const [first, second] = [original.messages[1], original.messages[3]];
    expect(lastReplyOf(original)).toEqual({ runId: second.runId });
    // After a rewind, it is the last reply the chat kept.
    const rewound = rewindConversation(original, original.messages[2].id);
    expect(lastReplyOf(rewound)).toEqual({ runId: first.runId });
    // A rewind to the first message leaves no reply to continue after.
    expect(lastReplyOf(rewindConversation(original, original.messages[0].id))).toBeUndefined();
    // Its steering are messages of that reply, not the next one.
    second.steering = [{ id: crypto.randomUUID(), runId: second.runId!, sequence: 1, text: 'Hm' }];
    expect(lastReplyOf(original)).toEqual({
      runId: second.runId,
      steering: [second.steering[0].id],
    });
    // A reply without a run, as older imports have, names nothing.
    delete second.runId;
    delete second.steering;
    expect(lastReplyOf(original)).toEqual({ runId: first.runId });
  });
  it('marks an undone reply in the words the host recognizes', () => {
    const original = chat();
    original.messages[1].filesUndone = true;
    expect(historyFor(original)[1].text).toBe(`First answer${filesUndoneMark}`);
    const host = readFileSync('src-tauri/src/providers/sessions.rs', 'utf8');
    expect(host).toContain(JSON.stringify(filesUndoneMark));
  });
  it('forks only retained messages and leaves the source rewind independently recoverable', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const fork = forkConversation(rewound);
    expect(fork.messages).toHaveLength(2);
    expect(fork.historyRevision).toBeUndefined();
    expect(fork.rewind).toBeUndefined();
    expect(undoRewind(rewound).messages).toEqual(original.messages);
    expect(fork.messages).toHaveLength(2);
  });
  it('keeps removed messages recoverable through validation and export, without replaying them', () => {
    const original = chat();
    const rewound = conversationSchema.parse(rewindConversation(original, original.messages[2].id));
    expect(rewound.messages).toEqual(original.messages.slice(0, 2));
    expect(historyFor(rewound).map((m) => m.text)).toEqual(['First question', 'First answer']);
    expect(rewound.historyRevision).toBe(1);
    const restored = undoRewind(JSON.parse(JSON.stringify(rewound)));
    expect(restored.messages).toEqual(original.messages);
    expect(restored.settings).toEqual(original.settings);
    expect(restored.historyRevision).toBe(2);
    expect(restored.rewind).toBeUndefined();
  });
  it('supports the first message and repeated rewinds without losing the suffix', () => {
    const original = chat();
    const once = rewindConversation(original, original.messages[2].id);
    const twice = rewindConversation(once, original.messages[0].id);
    expect(twice.messages).toEqual([]);
    expect(undoRewind(twice).messages).toEqual(original.messages);
  });
  it('rejects running, stale, and assistant targets', () => {
    const original = chat();
    expect(() => rewindConversation(original, crypto.randomUUID())).toThrow();
    expect(() => rewindConversation(original, original.messages[1].id)).toThrow();
    original.messages[3].status = 'running';
    expect(() => rewindConversation(original, original.messages[0].id)).toThrow(/finish/);
  });
  it('does not resurrect removed turns when an old checkpoint arrives', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const stale = structuredClone(original);
    stale.updatedAt = '2026-09-20';
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [rewound] },
      { ...base, conversations: [stale] },
    );
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].messages).toHaveLength(2);
    const reverse = mergeShared(
      base,
      { ...base, conversations: [stale] },
      { ...base, conversations: [rewound] },
    );
    expect(reverse.conversations[0].messages).toHaveLength(2);
  });
  it('keeps a concurrent deliberate edit as a conflict copy while retaining the rewind identity', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const changed = structuredClone(original);
    changed.messages.push({ ...original.messages[0], id: crypto.randomUUID() });
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [rewound] },
      { ...base, conversations: [changed] },
    );
    expect(result.conversations.find((c) => c.id === original.id)?.messages).toHaveLength(2);
    expect(result.conversations.find((c) => c.id !== original.id)?.messages).toHaveLength(5);
  });
  it('keeps a one-sided archive from another device without a conflict copy', () => {
    const original = chat();
    const rewound = rewindConversation(original, original.messages[2].id);
    const archived = { ...structuredClone(original), archived: true };
    const base = { ...emptyShared(), conversations: [original] };
    for (const [local, remote] of [
      [rewound, archived],
      [archived, rewound],
    ]) {
      const result = mergeShared(
        base,
        { ...base, conversations: [local] },
        { ...base, conversations: [remote] },
      );
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].messages).toHaveLength(2);
      expect(result.conversations[0].archived).toBe(true);
      expect(undoRewind(result.conversations[0]).messages).toEqual(original.messages);
    }
  });
  it('tells the agent when the user undid recorded file edits', () => {
    const original = chat();
    original.messages[1].filesUndone = true;
    expect(historyFor(original)[1].text).toContain('user undid');
  });
  it('reads the rewound message back with its images and mentions, leaving out unreadable images', async () => {
    const conversation = chat();
    const sent = conversation.messages[2];
    const connectionId = crypto.randomUUID();
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    sent.mentions = [mention];
    sent.images = [
      { id: crypto.randomUUID(), name: 'kept.png', mediaType: 'image/png', hash, bytes: 68 },
      {
        id: crypto.randomUUID(),
        name: 'gone.png',
        mediaType: 'image/png',
        hash: 'b'.repeat(64),
        bytes: 8,
      },
      // Saved inline by a release before the image store.
      { id: crypto.randomUUID(), name: 'inline.png', mediaType: 'image/png', data: png },
    ];
    conversation.messages[3].settings = { ...conversation.settings, connectionId };
    const reads: string[] = [];
    const { message, unread } = await rewoundMessage(conversation, sent.id, async (wanted) => {
      reads.push(wanted);
      if (wanted !== hash) throw new Error('This image is not on the relay.');
      return new Blob([bytes]);
    });
    expect(reads).toEqual([hash, 'b'.repeat(64)]);
    expect(unread).toBe(1);
    expect(message.text).toBe('Second question');
    expect(message.mentions).toEqual([mention]);
    expect(message.mentionConnectionId).toBe(connectionId);
    expect(message.images.map((i) => [i.name, i.mediaType, i.hash, i.bytes])).toEqual([
      ['kept.png', 'image/png', hash, 68],
      ['inline.png', 'image/png', hash, 68],
    ]);
    // Attached again as new images, their bytes in memory for the next send.
    const sentIds = sent.images.map((i) => i.id);
    expect(message.images.some((i) => sentIds.includes(i.id))).toBe(false);
    for (const image of message.images) {
      expect(new Uint8Array(await image.blob.arrayBuffer())).toEqual(bytes);
      expect(image.blob.type).toBe('image/png');
    }
    await expect(
      rewoundMessage(conversation, conversation.messages[1].id, async () => new Blob()),
    ).rejects.toThrow(/no longer/);
  });
  it('returns the message ahead of the draft, with mentions only for the account that answered it', () => {
    const connectionId = crypto.randomUUID();
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      text: 'Second question',
      images: [image('returned.png'), image('second.png')],
      mentions: [mention],
      mentionConnectionId: connectionId,
    };
    const draft = { ...noDraft(), text: 'Keep my draft\n', images: [image('draft.png')] };
    const same = returnedDraft(draft, message, { connectionId, mentionScope: 'scope' });
    expect(same.draft.text).toBe('Second question\n\nKeep my draft');
    expect(same.draft.images.map((i) => i.name)).toEqual([
      'returned.png',
      'second.png',
      'draft.png',
    ]);
    expect(same.draft.mentions).toEqual([mention]);
    expect(same.draft.staleMentions).toEqual([]);
    // Under another account they are chosen again, like mentions left from another scope.
    const other = returnedDraft(noDraft(), message, {
      connectionId: crypto.randomUUID(),
      mentionScope: 'scope',
    });
    expect(other.draft.text).toBe('Second question');
    expect(other.draft.mentions).toEqual([]);
    expect(other.draft.staleMentions).toEqual([mention.token]);
    const moved = returnedDraft(
      { ...noDraft(), text: mention.token, mentions: [mention], mentionScope: 'earlier' },
      { ...message, mentions: undefined },
      { connectionId, mentionScope: 'scope' },
    );
    expect(moved.draft.mentions).toEqual([]);
    expect(moved.draft.staleMentions).toEqual([mention.token]);
    expect(moved.draft.mentionScope).toBe('scope');
  });
  it('recognizes a returned message left as it was', () => {
    const returned = { text: 'Second question', images: [image('a.png')] };
    expect(sameReturned({ ...returned }, returned)).toBe(true);
    expect(sameReturned({ ...returned, text: 'Second question, edited' }, returned)).toBe(false);
    expect(sameReturned({ ...returned, images: [] }, returned)).toBe(false);
    expect(sameReturned({ ...returned, images: [image('a.png')] }, returned)).toBe(false);
  });
  it('preserves concurrent rewinds as separate histories even at the same revision', () => {
    const original = chat();
    const a = rewindConversation(original, original.messages[0].id);
    const b = rewindConversation(original, original.messages[2].id);
    const base = { ...emptyShared(), conversations: [original] };
    const result = mergeShared(
      base,
      { ...base, conversations: [a] },
      { ...base, conversations: [b] },
    );
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations.map((c) => c.messages.length).sort()).toEqual([0, 2]);
    for (const conversation of result.conversations)
      expect(undoRewind(conversation).messages).toEqual(original.messages);
  });
});
