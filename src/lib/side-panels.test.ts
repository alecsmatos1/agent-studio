import { expect, it } from 'vitest';
import { leaveChats, newestPage, type ArtifactView, type SubagentView } from './side-panels';

const artifact = (id: string, mode: ArtifactView['mode']): ArtifactView => ({
  artifact: { id, title: id, language: 'html', source: `<p>${id}</p>` },
  mode,
  focus: true,
});
const subagent = (agentId: string): SubagentView => ({ messageId: 'reply', agentId, focus: true });

it('finds the newest card of an artifact, a later reply being newer whatever its revision', () => {
  const card = (id: string, revision: number, title = 'Report') => ({
    id,
    revision,
    title,
    url: 'https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax',
  });
  const first = { id: 'first', publishedArtifacts: [card('page', 3)] };
  const none = { id: 'none' };
  const other = { id: 'other', publishedArtifacts: [card('other page', 7)] };
  expect(newestPage([], 'page')).toBeUndefined();
  expect(newestPage([none, other], 'page')).toBeUndefined();
  expect(newestPage([first, none, other], 'page')).toEqual({
    page: card('page', 3),
    version: 'first:3',
  });
  // Each reply counts from one, so this update reads below the revision the first reply reached.
  const later = { id: 'later', publishedArtifacts: [card('page', 1, 'Renamed')] };
  expect(newestPage([first, later, none], 'page')).toEqual({
    page: card('page', 1, 'Renamed'),
    version: 'later:1',
  });
  // Publishing again within a reply moves on too.
  const again = { id: 'later', publishedArtifacts: [card('page', 2, 'Renamed')] };
  expect(newestPage([first, again], 'page')?.version).toBe('later:2');
});

it('keeps the side panels of the chats left behind, which no longer take focus', () => {
  const artifacts = { a: artifact('a:0', 'panel'), b: artifact('b:0', 'panel') };
  const subagents = { c: subagent('reader'), b: subagent('writer') };
  leaveChats(artifacts, subagents, 'b');
  expect(artifacts).toEqual({
    a: { ...artifact('a:0', 'panel'), focus: false },
    b: artifact('b:0', 'panel'),
  });
  expect(subagents).toEqual({ c: { ...subagent('reader'), focus: false }, b: subagent('writer') });
});

it('closes the modal of a chat left behind, and keeps the one on screen', () => {
  const artifacts = { a: artifact('a:0', 'modal'), b: artifact('b:0', 'modal') };
  const subagents = { a: subagent('reader') };
  leaveChats(artifacts, subagents, 'b');
  expect(artifacts).toEqual({ b: artifact('b:0', 'modal') });
  // Its sub-agent stays beside the chat beneath the modal.
  expect(subagents).toEqual({ a: { ...subagent('reader'), focus: false } });
});

it('leaves every chat while none is on screen', () => {
  const artifacts = { a: artifact('a:0', 'modal'), b: artifact('b:0', 'panel') };
  const subagents = { c: subagent('reader') };
  leaveChats(artifacts, subagents, null);
  expect(artifacts).toEqual({ b: { ...artifact('b:0', 'panel'), focus: false } });
  expect(subagents).toEqual({ c: { ...subagent('reader'), focus: false } });
});
