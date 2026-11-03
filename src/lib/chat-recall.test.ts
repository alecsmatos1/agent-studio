import { expect, it } from 'vitest';
import { recalled, type ChatRecall } from './chat-recall';
import { revealedDisclosures } from './disclosures';
import { pageScrollReport } from './page-scroll';

it('keeps each part of a chat apart and forgets what is cleared', () => {
  const chat: ChatRecall = new Map();
  const footer = recalled(chat, 'reply/footer');
  const viewer = recalled(chat, 'artifact/page');
  footer.set('expanded', 'files');
  viewer.set('tab', 'source');
  viewer.set('page', [{ path: [], x: 0, y: 1200 }]);
  expect(recalled(chat, 'reply/footer').get('expanded')).toBe('files');
  expect(recalled(chat, 'artifact/page').get('expanded')).toBeUndefined();
  // Forgetting a value leaves the rest; forgetting the last drops the part.
  viewer.set('tab', undefined);
  expect(viewer.get('page')).toEqual([{ path: [], x: 0, y: 1200 }]);
  footer.set('expanded', undefined);
  expect(chat.has('reply/footer')).toBe(false);
  viewer.clear();
  expect(chat.size).toBe(0);
});

it('recalls nothing outside a chat or without a scope', () => {
  for (const part of [recalled(undefined, 'reply'), recalled(new Map(), undefined)]) {
    part.set('expanded', 'usage');
    expect(part.get('expanded')).toBeUndefined();
  }
});

const toggle = (open: boolean) => ({ currentTarget: { open } }) as unknown as Event;

it('mounts disclosures as the reader left them in their chat', () => {
  const chat: ChatRecall = new Map();
  const first = revealedDisclosures(recalled(chat, 'reply/'));
  first.opened('history')(toggle(true));
  first.opened('tool:a')(toggle(true));
  first.opened('tool:b')(toggle(true));
  first.opened('tool:b')(toggle(false));
  // A running call's row is never recalled.
  first.opened('tool:live', false)(toggle(true));
  expect(first.has('tool:live')).toBe(true);

  const again = revealedDisclosures(recalled(chat, 'reply/'));
  expect(again.open('history')).toBe(true);
  expect(again.has('history')).toBe(true);
  expect(again.open('tool:a')).toBe(true);
  // Closed by the reader: closed, even where it would start open.
  expect(again.open('tool:b', true)).toBe(false);
  expect(again.has('tool:b')).toBe(false);
  expect(again.open('tool:live')).toBe(false);
  expect(again.open('group', true)).toBe(true);
  // Another part of the chat recalls its own.
  expect(revealedDisclosures(recalled(chat, 'other/')).open('history')).toBe(false);
  // Without a chat, disclosures start as they always did.
  const plain = revealedDisclosures();
  plain.opened('history')(toggle(true));
  expect(plain.has('history')).toBe(true);
  expect(plain.open('history')).toBe(false);
});

it('recalls the live activity of a running reply apart from the Work history it becomes', () => {
  const chat: ChatRecall = new Map();
  let view = 'live';
  const running = revealedDisclosures(recalled(chat, 'reply/'), () => view);
  running.opened('group:1')(toggle(true));
  expect(revealedDisclosures(recalled(chat, 'reply/'), () => 'live').open('group:1')).toBe(true);
  // Finished, the reply's Work history starts collapsed, and keeps what is opened in it.
  view = 'history';
  expect(running.open('group:1')).toBe(false);
  running.opened('group:2')(toggle(true));
  const finished = revealedDisclosures(recalled(chat, 'reply/'), () => 'history');
  expect(finished.open('group:1')).toBe(false);
  expect(finished.open('group:2')).toBe(true);
  expect(finished.has('group:2')).toBe(true);
  expect(finished.has('group:1')).toBe(false);
});

it('accepts only a scroll report from the frame given its token', () => {
  const places = [
    { path: [], x: 0, y: 1200 },
    { path: [1, 0, 3], x: 40, y: 0 },
  ];
  const report = { type: 'studio-artifact-scroll', token: 'loading', places };
  expect(pageScrollReport(report, 'loading')).toEqual(places);
  expect(pageScrollReport({ ...report, places: [] }, 'loading')).toEqual([]);
  // Right-to-left pages scroll to negative offsets.
  expect(pageScrollReport({ ...report, places: [{ path: [], x: -80, y: 3 }] }, 'loading')).toEqual([
    { path: [], x: -80, y: 3 },
  ]);
  for (const bad of [
    null,
    'studio-artifact-scroll',
    { ...report, token: 'earlier' },
    { ...report, type: 'studio-visualization-size' },
    { ...report, places: 'all' },
    { ...report, places: [{ path: [-1], x: 0, y: 0 }] },
    { ...report, places: [{ path: [0.5], x: 0, y: 0 }] },
    { ...report, places: [{ path: '1/2', x: 0, y: 0 }] },
    { ...report, places: [{ path: [], x: Number.NaN, y: 0 }] },
    { ...report, places: [{ path: [], x: 0, y: Infinity }] },
    { ...report, places: [{ path: [], x: '1', y: 0 }] },
    { ...report, places: [null] },
  ])
    expect(pageScrollReport(bad, 'loading')).toBeUndefined();
  expect(pageScrollReport(report, '')).toBeUndefined();
});
