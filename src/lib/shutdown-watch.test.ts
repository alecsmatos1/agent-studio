import { describe, expect, it } from 'vitest';
import { initialWorkspace, settingsFor, type Conversation, type Message } from './domain';
import {
  countdownMs,
  countdownOver,
  timeLeft,
  unfinishedChats,
  waitingText,
  watchStep,
  type WatchState,
} from './shutdown-watch';

const settings = { ...settingsFor(initialWorkspace().preferences), provider: 'claude' as const };
const at = new Date(Date.UTC(2026, 10, 3, 2, 0)).toISOString();
const line = "You've hit your session limit · resets 4:00am (America/Sao_Paulo)";

const reply = (status: Message['status'], extra: Partial<Message> = {}): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status,
  createdAt: at,
  settings,
  blocks: [{ type: 'markdown', text: 'Working on it.' }],
  ...extra,
});
const chat = (...messages: Message[]): Conversation => ({
  id: crypto.randomUUID(),
  title: 'Overnight refactor',
  createdAt: at,
  updatedAt: at,
  settings,
  messages: [
    {
      id: crypto.randomUUID(),
      role: 'user',
      status: 'complete',
      createdAt: at,
      blocks: [{ type: 'markdown', text: 'Refactor the parser.' }],
    },
    ...messages,
  ],
});
const limited = (autoContinue?: Message['autoContinue']) =>
  reply('error', {
    error: line,
    usageLimit: { revision: 1, text: line },
    ...(autoContinue ? { autoContinue } : {}),
  });

describe('the work a computer still has before it turns off', () => {
  const running = (c: Conversation) => c.messages.some((m) => m.status === 'running');
  it('counts replies running here, queued messages behind a running reply and continuations', () => {
    const here = chat(reply('running'));
    const queuedBehindRemote = chat(reply('running'));
    const queuedAfterFailure = chat(reply('error', { error: 'The CLI stopped.' }));
    const continues = chat(limited({ at: '2026-11-03T07:01:00.000Z', changedAt: at }));
    const cancelled = chat(limited({ off: true, changedAt: at }));
    const elsewhere = chat(limited({ at: '2026-11-03T07:01:00.000Z', changedAt: at }));
    const done = chat(reply('complete'));
    const conversations = [
      here,
      queuedBehindRemote,
      queuedAfterFailure,
      continues,
      cancelled,
      elsewhere,
      done,
    ];
    const chats = unfinishedChats(conversations, {
      // A reply another device asked for has no chat here yet.
      running: [here.id, 'chat-from-a-phone'],
      queued: { [queuedBehindRemote.id]: [{}], [queuedAfterFailure.id]: [{}], [done.id]: [] },
      replying: running,
      continuesHere: (c) => c.id !== elsewhere.id,
    });
    expect([...chats].sort()).toEqual(
      [here.id, 'chat-from-a-phone', queuedBehindRemote.id, continues.id].sort(),
    );
  });
  it('waits for a continuation whose time is not known yet', () => {
    const started = chat(limited({ changedAt: at }));
    expect(
      unfinishedChats([started], {
        running: [],
        queued: {},
        replying: running,
        continuesHere: () => true,
      }).has(started.id),
    ).toBe(true);
  });
  it('holds nothing once every chat finished', () => {
    expect(
      unfinishedChats([chat(reply('complete')), chat(reply('cancelled'))], {
        running: [],
        queued: {},
        replying: running,
        continuesHere: () => true,
      }).size,
    ).toBe(0);
  });
});

describe('what the button says it waits for', () => {
  it('names chats and workflows', () => {
    expect(waitingText({ chats: 0, workflows: 0 })).toBe('');
    expect(waitingText({ chats: 1, workflows: 0 })).toBe('Waiting for 1 chat');
    expect(waitingText({ chats: 3, workflows: 0 })).toBe('Waiting for 3 chats');
    expect(waitingText({ chats: 0, workflows: 1 })).toBe('Waiting for 1 workflow');
    expect(waitingText({ chats: 2, workflows: 2 })).toBe('Waiting for 2 chats and 2 workflows');
  });
});

describe('the watch', () => {
  const now = 1_000_000;
  it('counts down once no work is left, and goes back to waiting when work begins', () => {
    const watching: WatchState = { phase: 'watching' };
    expect(watchStep(watching, { armed: true, busy: true, now })).toBe(watching);
    const counting = watchStep(watching, { armed: true, busy: false, now });
    expect(counting).toEqual({ phase: 'counting', until: now + countdownMs });
    // The countdown keeps its end while nothing changes.
    expect(watchStep(counting, { armed: true, busy: false, now: now + 5_000 })).toBe(counting);
    expect(countdownOver(counting, now + countdownMs - 1)).toBe(false);
    expect(countdownOver(counting, now + countdownMs)).toBe(true);
    // A reply that begins during the countdown ends it, and a new one starts after it.
    expect(watchStep(counting, { armed: true, busy: true, now: now + 10_000 })).toEqual(watching);
    expect(watchStep(watching, { armed: true, busy: false, now: now + 90_000 })).toEqual({
      phase: 'counting',
      until: now + 90_000 + countdownMs,
    });
  });
  it('turns off when disarmed, but never stops shutting down', () => {
    const off: WatchState = { phase: 'off' };
    expect(watchStep({ phase: 'watching' }, { armed: false, busy: true, now })).toEqual(off);
    expect(watchStep(off, { armed: false, busy: false, now })).toBe(off);
    const shutting: WatchState = { phase: 'shutting', asked: false };
    expect(watchStep(shutting, { armed: true, busy: true, now })).toBe(shutting);
    expect(countdownOver(shutting, now)).toBe(false);
  });
  it('shows the time left in minutes and seconds', () => {
    expect(timeLeft(now + countdownMs, now)).toBe('1:00');
    expect(timeLeft(now + 42_300, now)).toBe('0:43');
    expect(timeLeft(now + 1, now)).toBe('0:01');
    expect(timeLeft(now, now + 5_000)).toBe('0:00');
  });
});
