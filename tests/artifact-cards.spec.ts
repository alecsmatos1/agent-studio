import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// An artifact a reply writes shows as a card that opens it, in place of its code: in the answer,
// in the reply's own comments, and while the reply still writes it (src/lib/artifacts.ts).
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const comment = (id: string, revision: number, text: string) => ({
  kind: 'progress',
  id,
  revision,
  text,
});
const finish = (page: Page, status: string) =>
  page.evaluate((status) => (window as any).finishCapabilities(status), status);

async function ask(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
}

/** The reply's blocks in the order they read: paragraphs, cards and code. */
const reading = (scope: Locator) =>
  scope.evaluate((element) =>
    [...element.querySelectorAll(':scope > p, :scope > .artifact-card, :scope > .code-block')].map(
      (child) =>
        child.classList.contains('artifact-card')
          ? `card: ${child.querySelector('.artifact-open')?.textContent}`
          : child.classList.contains('code-block')
            ? 'code'
            : child.textContent,
    ),
  );

const source = '<!doctype html>\n<title>Q3</title>\n<h1>Third quarter</h1>';
const written = `Here is the report.\n\n\`\`\`html Quarterly report\n${source}\n\`\`\`\n\nOpen it beside the chat.`;

test('an artifact shows as a card in place of its code, also while the reply writes it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Write the quarterly report');
  const reply = page.locator('.message').last();
  // Claude streams the turn's text as a comment of the reply's work until the turn ends.
  await emit(page, comment('turn', 1, written.slice(0, written.indexOf('<h1>') + 4)));
  const writing = reply.locator('.artifact-writing');
  await expect(writing).toHaveText(/Quarterly report\s*Writing · 3 lines/);
  await expect(reply.locator('.code-block')).toHaveCount(0);
  await expect(reply.getByRole('button', { name: /Quarterly report/ })).toHaveCount(0);
  await emit(page, comment('turn', 2, written));
  await emit(page, { kind: 'text', text: written });
  await finish(page, 'complete');
  const answer = reply.locator(':scope > .message-content > .prose');
  await expect(answer).toHaveCount(1);
  expect(await reading(answer)).toEqual([
    'Here is the report.',
    'card: Quarterly reportOpen HTML',
    'Open it beside the chat.',
  ]);
  await expect(reply.locator('.artifact-writing, .code-block, .response-artifacts')).toHaveCount(0);
  const open = reply.getByRole('button', { name: 'Quarterly report Open HTML', exact: true });
  // From the keyboard, so the card holds focus to take back in every engine.
  await open.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', { name: 'Quarterly report', exact: true });
  await expect(
    page.frameLocator('iframe[title="Quarterly report preview"]').getByRole('heading'),
  ).toHaveText('Third quarter');
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe(source);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
  await reply
    .getByRole('button', { name: 'Open Quarterly report in side panel', exact: true })
    .click();
  await expect(viewer).toHaveClass(/docked/);
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await page.screenshot({ path: 'artifacts/artifact-card.png' });
  // Saved history shows it the same way.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Write the quarterly report/ }).click();
  await expect(
    page.getByRole('button', { name: 'Quarterly report Open HTML', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message').last().locator('.code-block')).toHaveCount(0);
  // A phone keeps the card within the conversation.
  await page.setViewportSize({ width: 390, height: 844 });
  const card = (await page
    .locator('.message')
    .last()
    .locator('.prose .artifact-card')
    .boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/artifact-card-mobile.png' });
});

test('html a reply explains stays code, and reasoning and a stopped reply show no artifact cards', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'How do I center a div?');
  let reply = page.locator('.message').last();
  // Thinking never makes an artifact, whatever it writes.
  await emit(page, {
    kind: 'reasoning',
    id: 'r1',
    revision: 1,
    text: 'Draft:\n\n```html Draft page\n<!doctype html><title>Draft</title>\n```',
    truncated: false,
  });
  await expect(reply.locator('.reasoning-entry .code-block')).toHaveCount(1);
  const snippet =
    'Use flexbox:\n\n```html\n<div class="center">Hi</div>\n```\n\n```svg\n<svg/>\n```';
  await emit(page, { kind: 'text', text: snippet });
  await finish(page, 'complete');
  const answer = reply.locator(':scope > .message-content > .prose');
  await expect(answer.locator('.code-block')).toHaveCount(2);
  await expect(reply.locator('.artifact-card:not(.response-artifacts *)')).toHaveCount(0);
  // Code the reply explains still opens as an artifact from below it, as before.
  await expect(
    reply.locator('.response-artifacts').getByRole('button', { name: 'HTML artifact 1 Open HTML' }),
  ).toBeVisible();
  await reply.getByLabel('Work history', { exact: true }).click();
  await expect(reply.locator('.reasoning-entry .artifact-card')).toHaveCount(0);

  // A reply stopped while it wrote an artifact keeps what it wrote, as code.
  await ask(page, 'Write the onboarding page');
  reply = page.locator('.message').last();
  const unfinished = 'Here it is.\n\n```html Onboarding\n<!doctype html>\n<h1>Welcome</h1>';
  await emit(page, comment('turn', 1, unfinished));
  await expect(reply.locator('.artifact-writing')).toHaveText(/Onboarding\s*Writing · 2 lines/);
  await finish(page, 'cancelled');
  await expect(reply).toHaveAttribute('data-status', 'cancelled');
  await expect(reply.locator('.artifact-writing')).toHaveCount(0);
  await expect(reply.locator(':scope > .message-content > .prose .code-block')).toContainText(
    'Welcome',
  );
});

test('an artifact of an earlier turn stays in its comment and follows the answer', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Build the dashboard and check it');
  const reply = page.locator('.message').last();
  await emit(page, comment('first', 1, 'The dashboard:\n\n```html Dashboard\n<h1>KPIs</h1>\n```'));
  await emit(page, {
    kind: 'tool',
    tool: {
      id: 'check',
      operation: 'command',
      name: 'Bash',
      category: 'tool',
      revision: 1,
      status: 'complete',
      command: 'npm test',
      commandRun: true,
      facts: [],
      sources: [],
      agents: [],
    },
  });
  await emit(page, comment('last', 1, 'All checks passed.'));
  await emit(page, { kind: 'text', text: 'All checks passed.' });
  await finish(page, 'complete');
  // The answer is a short status, so the artifact its work wrote follows it.
  const below = reply.locator('.response-artifacts');
  await expect(below.getByRole('button', { name: 'Dashboard Open HTML' })).toBeVisible();
  await reply.getByLabel('Work history', { exact: true }).click();
  const history = reply.locator('.activity-timeline');
  await expect(history.locator('.code-block')).toHaveCount(0);
  await history.getByRole('button', { name: 'Dashboard Open HTML', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Dashboard', exact: true });
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe('<h1>KPIs</h1>');
});

// A page the agent wrote to a file and showed with its show_artifact tool: the reply keeps its
// source, places its card at the marker, and an open viewer follows each revision it shows.
test('a page shown with show_artifact sits at its marker and the viewer follows its revisions', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Make the quarterly page');
  const reply = page.locator('.message').last();
  const shown = (revision: number, heading: string) => ({
    kind: 'artifact',
    artifact: {
      id: 'report',
      revision,
      title: 'Quarterly report',
      language: 'html',
      source: `<!doctype html><title>Q3</title><h1>${heading}</h1>`,
    },
  });
  await emit(page, shown(1, 'First draft'));
  const card = reply.getByRole('button', { name: 'Quarterly report Open HTML', exact: true });
  await expect(card).toBeVisible();
  await reply
    .getByRole('button', { name: 'Open Quarterly report in side panel', exact: true })
    .click();
  const viewer = page.getByRole('dialog', { name: 'Quarterly report', exact: true });
  await expect(viewer).toHaveClass(/docked/);
  const frame = page.frameLocator('iframe[title="Quarterly report preview"]');
  await expect(frame.getByRole('heading')).toHaveText('First draft');
  // A page renders where it may load pinned CDN libraries.
  expect(await viewer.locator('iframe').getAttribute('src')).toBe('/artifact-page');
  // The agent fixed the page and showed it again under its id.
  await emit(page, shown(2, 'Final'));
  await expect(frame.getByRole('heading')).toHaveText('Final');
  await expect(card).toHaveCount(1);
  await emit(page, {
    kind: 'text',
    text: 'Here it is.\n\n<!-- artifact:report -->\n\nIt covers the third quarter.',
  });
  await finish(page, 'complete');
  const order = () =>
    page
      .locator('.message')
      .last()
      .locator(':scope > .message-content')
      .evaluate((content) =>
        [...content.children]
          .filter((child) => child.matches('.prose, .artifact-card'))
          .map((child) => (child.matches('.artifact-card') ? 'card' : child.textContent?.trim())),
      );
  expect(await order()).toEqual(['Here it is.', 'card', 'It covers the third quarter.']);
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  // Saved history keeps the page's latest source.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Make the quarterly page/ }).click();
  expect(await order()).toEqual(['Here it is.', 'card', 'It covers the third quarter.']);
  await page.getByRole('button', { name: 'Quarterly report Open HTML', exact: true }).click();
  await viewer.getByRole('tab', { name: 'Source', exact: true }).click();
  expect(await viewer.locator('pre code').textContent()).toBe(
    '<!doctype html><title>Q3</title><h1>Final</h1>',
  );
});

// An artifact a Claude reply published to claude.ai with Claude Code's own Artifact tool
// (requested 2026-10-21): its card opens it, a new artifact opens once in the window that sent
// the message, as the CLI's terminal opens it, and saved history keeps the card. On Windows it
// opens beside the chat (requested 2026-10-29), in a WebView2 of its own signed in to the
// claude.ai session of the reply's account, which the page places over the panel's slot and
// hides while anything covers it (src-tauri/src/claude_pages.rs).
const pageUrl = 'https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax';
const published = (revision: number, open: boolean) => ({
  kind: 'publishedartifact',
  publishedArtifact: {
    id: '61f14ff2-c402-429d-ad1b-42de9c796ca9',
    revision,
    url: pageUrl,
    title: 'Quarterly report',
  },
  ...(open ? { open } : {}),
});
/** Records the links the browser opens and what the page asks of the claude.ai panes. */
async function recordPages(page: Page, platform?: string) {
  await page.addInitScript((platform) => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.openedPages = [];
    w.pageRequests = [];
    w.pageCloses = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any, options: any) => {
      if (command === 'plugin:opener|open_url') {
        w.openedPages.push(args.url);
        return;
      }
      if (command === 'claude_page') {
        w.pageRequests.push(args.request);
        return;
      }
      if (command === 'close_claude_pages') {
        w.pageCloses.push(args.keep);
        return;
      }
      const answer = await original(command, args, options);
      return platform && command === 'get_installation' ? { ...answer, platform } : answer;
    };
  }, platform);
}
const opened = (page: Page) => page.evaluate(() => (window as any).openedPages as string[]);
const lastPageRequest = (page: Page) =>
  page.evaluate(() => (window as any).pageRequests.at(-1) ?? null);

test('a claude.ai artifact opens beside the chat in the claude.ai session of its account', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await recordPages(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Publish the quarterly page on claude.ai');
  const reply = page.locator('.message').last();
  await emit(page, published(1, true));
  const card = reply.getByRole('button', { name: 'Quarterly report claude.ai', exact: true });
  await expect(card).toBeVisible();
  // A new artifact opens beside the chat, and the pane covers the panel's slot.
  const viewer = page.locator('#claude-page-viewer');
  await expect(viewer.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  await expect.poll(async () => (await lastPageRequest(page))?.bounds ?? null).not.toBeNull();
  const shown = await lastPageRequest(page);
  expect(shown.url).toBe(pageUrl);
  expect(shown.account).toMatch(/^[0-9a-f-]{36}$/);
  const slot = (await viewer.locator('.page-slot').boundingBox())!;
  for (const side of ['x', 'y', 'width', 'height'] as const)
    expect(shown.bounds[side]).toBeCloseTo(slot[side], 0);
  expect(await opened(page)).toEqual([]);
  // Anything of the page over the slot hides the pane until it goes.
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'test-cover';
    cover.style.cssText = 'position: fixed; inset: 0; z-index: 100';
    document.body.append(cover);
    window.dispatchEvent(new Event('pointerdown'));
  });
  await expect.poll(async () => (await lastPageRequest(page)).bounds).toBeNull();
  await page.evaluate(() => {
    document.getElementById('test-cover')!.remove();
    window.dispatchEvent(new Event('pointerdown'));
  });
  await expect.poll(async () => (await lastPageRequest(page)).bounds).not.toBeNull();
  // Republishing it loads it again; opening it again opens nothing more by itself.
  const firstLoad = shown.load;
  await emit(page, published(2, false));
  await expect.poll(async () => (await lastPageRequest(page)).load).not.toBe(firstLoad);
  await emit(page, published(3, true));
  await emit(page, { kind: 'text', text: 'Published it.' });
  await finish(page, 'complete');
  await expect(card).toHaveCount(1);
  const republished = (await lastPageRequest(page)).load;
  await viewer.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect.poll(async () => (await lastPageRequest(page)).load).not.toBe(republished);
  // The browser stays one click away, from the panel and from the card.
  await viewer.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await reply.getByRole('button', { name: 'Open Quarterly report in browser', exact: true }).click();
  await expect.poll(() => opened(page)).toEqual([pageUrl, pageUrl]);
  // Closing it hides the pane and closes the account's session.
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect.poll(async () => (await lastPageRequest(page)).bounds).toBeNull();
  await expect.poll(() => page.evaluate(() => (window as any).pageCloses.at(-1))).toEqual([]);
  await card.click();
  await expect(viewer.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  await expect.poll(async () => (await lastPageRequest(page)).bounds).not.toBeNull();
  // Saved history keeps the card.
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Publish the quarterly page/ }).click();
  await expect(
    page.getByRole('button', { name: 'Quarterly report claude.ai', exact: true }),
  ).toBeVisible();
});

test('a later reply that changes a claude.ai artifact loads it again beside the chat', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await recordPages(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Make the quarterly page');
  await emit(page, published(1, true));
  // The first reply publishes it twice, so what shows is at revision 2.
  const viewer = page.locator('#claude-page-viewer');
  await expect(viewer.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
  await expect.poll(async () => (await lastPageRequest(page))?.bounds ?? null).not.toBeNull();
  const first = (await lastPageRequest(page)).load;
  await emit(page, published(2, false));
  await expect.poll(async () => (await lastPageRequest(page)).load).not.toBe(first);
  await emit(page, { kind: 'text', text: 'Published it.' });
  await finish(page, 'complete');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const before = (await lastPageRequest(page)).load;
  // A reply counts its own revisions from one: this update reads below what shows.
  await ask(page, 'Rename it');
  await emit(page, {
    kind: 'publishedartifact',
    publishedArtifact: { ...published(1, false).publishedArtifact, title: 'Annual report' },
  });
  await expect.poll(async () => (await lastPageRequest(page)).load).not.toBe(before);
  await expect(viewer.getByRole('heading', { name: 'Annual report' })).toBeVisible();
  await emit(page, { kind: 'text', text: 'Renamed it.' });
  await finish(page, 'complete');
  // Each reply keeps its card, and the panel stays open on the artifact without loading it again.
  await expect(page.locator('.published-card')).toHaveCount(2);
  const settled = (await lastPageRequest(page)).load;
  await page.evaluate(() => window.dispatchEvent(new Event('pointerdown')));
  expect((await lastPageRequest(page)).load).toBe(settled);
  // Closed and opened from the earlier reply's card, it shows the latest, loading once.
  await viewer.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  const requests = () => page.evaluate(() => (window as any).pageRequests.length as number);
  const loads = () =>
    page.evaluate(() =>
      new Set((window as any).pageRequests.map((request: { load: string }) => request.load)).size,
    );
  const known = await loads();
  await page.locator('.published-card').first().getByRole('button').first().click();
  await expect(viewer.getByRole('heading', { name: 'Annual report' })).toBeVisible();
  await expect.poll(requests).toBeGreaterThan(0);
  await expect.poll(async () => (await lastPageRequest(page)).bounds ?? null).not.toBeNull();
  expect(await loads()).toBe(known + 1);
});

test('a claude.ai artifact opens in the browser where the window shows none', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await recordPages(page, 'linux');
  await page.goto('/');
  await chooseTestFolder(page);
  await ask(page, 'Publish the quarterly page on claude.ai');
  const reply = page.locator('.message').last();
  await emit(page, published(1, true));
  const card = reply.getByRole('button', {
    name: 'Quarterly report Open on claude.ai',
    exact: true,
  });
  await expect(card).toBeVisible();
  await expect.poll(() => opened(page)).toEqual([pageUrl]);
  await emit(page, { kind: 'text', text: 'Published it.' });
  await finish(page, 'complete');
  await card.click();
  await expect.poll(() => opened(page)).toEqual([pageUrl, pageUrl]);
  await expect(page.locator('#claude-page-viewer')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pageRequests)).toEqual([]);
});
