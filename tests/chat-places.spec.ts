import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const row = (page: Page, title: string) => page.locator('.conversation-item', { hasText: title });
// Opens a chat from its sidebar row with the keyboard, which every engine handles alike.
async function choose(page: Page, title: string) {
  await row(page, title).focus();
  await page.keyboard.press('Enter');
  await expect(row(page, title)).toHaveAttribute('aria-current', 'page');
}
const newChat = (page: Page) =>
  page.getByRole('button', { name: 'New conversation', exact: true }).first().click();
const paragraphs = (label: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}.`).join('\n\n');

// Sends a message in the open chat, whose reply reports these events and completes.
async function reply(page: Page, text: string, events: unknown[]) {
  const runs = await page.evaluate(() => Object.keys((window as any).capabilityRuns ?? {}).length);
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    (runs) => Object.keys((window as any).capabilityRuns ?? {}).length > runs,
    runs,
  );
  await page.evaluate((events) => {
    for (const event of events) (window as any).emitCapability(event);
    (window as any).finishCapabilities('complete');
  }, events);
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
}
// Opens a chat as clicking its desktop notification does.
async function notificationClick(page: Page, title: string) {
  await page.evaluate((title) => {
    const chat = JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
      (c: { title: string }) => c.title === title,
    );
    (window as any).emitTauriEvent('studio-notification-open', chat.id);
  }, title);
}
const scroller = (page: Page) => page.locator('.chat-scroll');
const fromEnd = (page: Page) =>
  scroller(page).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
// The paragraph at the top of the conversation's view, and how far the chat is scrolled.
const reading = (page: Page) =>
  scroller(page).evaluate((scroll) => {
    const box = scroll.getBoundingClientRect();
    const paragraph = [...scroll.querySelectorAll('.prose p')].find(
      (p) => p.getBoundingClientRect().bottom > box.top + 1,
    );
    return { paragraph: paragraph?.textContent, top: Math.round(scroll.scrollTop) };
  });
// How far below the top of the conversation's view an element begins.
const below = (page: Page, selector: string, index = 0) =>
  scroller(page).evaluate(
    (scroll, { selector, index }) =>
      Math.round(
        scroll.querySelectorAll(selector)[index].getBoundingClientRect().top -
          scroll.getBoundingClientRect().top,
      ),
    { selector, index },
  );
// Scroll events and the messages they send arrive a frame or two later.
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
const jump = (page: Page) => page.getByRole('button', { name: 'Jump to latest', exact: true });

test('each chat opens where the reader left it, and at its end when they followed it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await reply(page, 'Write the long notes', [{ kind: 'text', text: paragraphs('Long', 90) }]);
  await scroller(page).evaluate((scroll) => (scroll.scrollTop = 900));
  await expect.poll(async () => (await reading(page)).top).toBe(900);
  const long = await reading(page);
  expect(long.paragraph).toMatch(/^Long paragraph \d+\.$/);
  await expect(jump(page)).toBeVisible();

  await newChat(page);
  await reply(page, 'Write the short notes', [{ kind: 'text', text: paragraphs('Short', 60) }]);
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);

  // Before, every chat opened at its end.
  await choose(page, 'Write the long notes');
  await expect.poll(async () => (await reading(page)).paragraph).toBe(long.paragraph);
  expect(Math.abs((await reading(page)).top - long.top)).toBeLessThanOrEqual(1);
  await expect(jump(page)).toBeVisible();
  // The chat left at its end opens there.
  await choose(page, 'Write the short notes');
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  await expect(jump(page)).toHaveCount(0);

  // Each keeps its own place, through Settings too.
  await scroller(page).evaluate((scroll) => (scroll.scrollTop = 300));
  await expect.poll(async () => (await reading(page)).top).toBe(300);
  const short = await reading(page);
  await choose(page, 'Write the long notes');
  await expect.poll(async () => (await reading(page)).paragraph).toBe(long.paragraph);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(scroller(page)).toHaveCount(0);
  await choose(page, 'Write the short notes');
  await expect.poll(async () => (await reading(page)).paragraph).toBe(short.paragraph);
  expect(Math.abs((await reading(page)).top - short.top)).toBeLessThanOrEqual(1);

  // Back at its end, a chat follows again and opens there.
  await jump(page).click();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  await choose(page, 'Write the long notes');
  await expect.poll(async () => (await reading(page)).paragraph).toBe(long.paragraph);
  await choose(page, 'Write the short notes');
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);

  // An alert about a chat shows its latest reply.
  await notificationClick(page, 'Write the long notes');
  await expect(row(page, 'Write the long notes')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
});

test('a chat comes back with what the reader opened in it, at the call being read @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const calls = Array.from({ length: 10 }, (_, i) => ({
    kind: 'tool',
    tool: {
      id: `call-${i}`,
      revision: 1,
      category: 'tool',
      name: 'Run command',
      status: 'complete',
      detail: `Read project context ${i}`,
      commandRun: true,
      command: `cat docs/context-${i}.md`,
      sources: [],
      agents: [],
    },
  }));
  await reply(page, 'Read the context', [
    ...calls,
    { kind: 'text', text: paragraphs('Answer', 40) },
  ]);
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').first().click();
  for (const summary of await page.locator('.tool-card > summary').all()) await summary.click();
  await expect(page.locator('.tool-card[open]')).toHaveCount(10);
  // Each opened call reads its result before the reader settles on one.
  await expect(page.locator('.tool-card .result-section')).toHaveCount(10);
  await expect(page.getByText('Loading output…')).toHaveCount(0);
  // The reply's footer shows the chat's changes.
  await page.locator('.files-toggle').click();
  await page.getByRole('tab', { name: 'All chat changes', exact: true }).click();
  // A disclosure settles in the frame after its activation.
  await frames(page);
  // Reading inside the Work history.
  await scroller(page).evaluate((scroll) => {
    const call = scroll.querySelectorAll('.tool-card')[6];
    scroll.scrollTop += call.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 80;
  });
  await frames(page);
  const call = await below(page, '.tool-card', 6);
  expect(Math.abs(call - 80)).toBeLessThanOrEqual(1);

  await newChat(page);
  await expect(page.locator('.tool-card')).toHaveCount(0);
  await choose(page, 'Read the context');
  await expect(page.locator('.activity-summary')).toHaveAttribute('open', '');
  await expect(page.locator('.activity-group').first()).toHaveAttribute('open', '');
  await expect(page.locator('.tool-card[open]')).toHaveCount(10);
  await expect(page.locator('.files-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('tab', { name: 'All chat changes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(async () => Math.abs((await below(page, '.tool-card', 6)) - call))
    .toBeLessThanOrEqual(1);

  // What the reader closed stays closed.
  await page.locator('.tool-card > summary').nth(2).click();
  await expect(page.locator('.tool-card[open]')).toHaveCount(9);
  await frames(page);
  await newChat(page);
  await choose(page, 'Read the context');
  await expect(page.locator('.tool-card[open]')).toHaveCount(9);
  await expect(page.locator('.tool-card').nth(2)).not.toHaveAttribute('open', '');
});

// A page longer than its viewer, with its source on many lines.
const guide = [
  '```html Guide',
  '<!doctype html><title>Guide</title>',
  ...Array.from({ length: 160 }, (_, i) => `<p>Section ${i + 1}</p>`),
  '```',
].join('\n');

test('an artifact beside its chat opens again where the reader scrolled it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await reply(page, 'Write the guide', [{ kind: 'text', text: guide }]);
  await page.getByRole('button', { name: 'Open Guide in side panel', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Guide', exact: true });
  const frame = page.frameLocator('iframe[title="Guide preview"]');
  const pageTop = () => frame.locator('body').evaluate(() => Math.round(window.scrollY));
  await expect(frame.getByText('Section 160', { exact: true })).toBeAttached();
  await frame.locator('body').evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(pageTop).toBe(1200);
  await frame
    .locator('body')
    .evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  await frames(page);

  // Before, the page started again from its top.
  await newChat(page);
  await expect(viewer).toHaveCount(0);
  await choose(page, 'Write the guide');
  await expect(viewer).toHaveClass(/docked/);
  await expect(frame.getByText('Section 160', { exact: true })).toBeAttached();
  await expect.poll(pageTop).toBe(1200);

  // The source keeps its tab and its place as well.
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  const source = viewer.getByRole('tabpanel', { name: 'Artifact source' });
  await expect(source).toContainText('Section 160');
  await source.evaluate((element) => (element.scrollTop = 400));
  await frames(page);
  await newChat(page);
  await choose(page, 'Write the guide');
  await expect(viewer.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(() => source.evaluate((element) => element.scrollTop)).toBe(400);
  // Its page is still where the reader left it.
  await viewer.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(frame.getByText('Section 160', { exact: true })).toBeAttached();
  await expect.poll(pageTop).toBe(1200);

  // Closed and opened again, it starts from its top.
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Guide in side panel', exact: true }).click();
  await expect(frame.getByText('Section 160', { exact: true })).toBeAttached();
  await frames(page);
  expect(await pageTop()).toBe(0);
});

test('a sub-agent beside its chat opens again where the reader left it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await reply(page, 'Explore the auth code', [
    {
      kind: 'tool',
      tool: {
        id: 'claude:agents',
        name: 'Sub-agents',
        category: 'agent',
        revision: 1,
        status: 'complete',
        sources: [],
        agents: [
          {
            id: 'reader',
            name: 'Explore the auth flow',
            status: 'complete',
            task: 'Find where sessions are created.',
            result: paragraphs('Finding', 60),
          },
        ],
      },
    },
    { kind: 'text', text: 'Done.' },
  ]);
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').first().click();
  await page.locator('.subagent-row').first().click();
  const panel = page.getByRole('dialog', { name: 'Explore the auth flow' });
  const scroll = panel.locator('.panel-scroll');
  await expect(panel.getByText('Finding paragraph 60.', { exact: true })).toBeAttached();
  await scroll.evaluate((element) => (element.scrollTop = 700));
  await frames(page);

  await newChat(page);
  await expect(panel).toHaveCount(0);
  await choose(page, 'Explore the auth code');
  await expect(panel).toHaveClass(/docked/);
  await expect.poll(() => scroll.evaluate((element) => Math.round(element.scrollTop))).toBe(700);
});
