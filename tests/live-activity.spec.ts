import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const call = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'tool',
  tool: {
    id,
    name: 'Read',
    category: 'tool',
    revision: 1,
    status: 'running',
    sources: [],
    agents: [],
    ...extra,
  },
});
const image = { name: 'View image', operation: 'viewImage', path: '/fixture/screens/home.png' };
const command = {
  name: 'Run command',
  commandRun: true,
  operation: 'command',
  command: 'npm test -- --run',
  shell: 'bash',
};
const read = (path: string) => ({ operation: 'read', path });

async function start(page: Page, message: string, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
}
// Folded rows fade out over a quarter of a second before they leave the page.
const settled = (page: Page) => page.waitForTimeout(400);

for (const mobile of [false, true])
  test(`running calls show what they do, then fold into their group ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    await start(page, 'Check the screenshot and run the tests', mobile);
    const shot = (name: string) =>
      page.screenshot({
        path: `artifacts/live-activity/${name}-${mobile ? 'mobile' : 'desktop'}.png`,
      });
    const rows = page.locator('.live-row');
    const summaries = page.locator('.activity-group > summary');
    await emit(page, {
      kind: 'progress',
      id: 'plan',
      revision: 1,
      text: 'I will look at the screenshot, then run the tests.',
    });
    await emit(page, call('shot', image));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Viewing');
    await expect(rows.first()).toContainText('fixture/screens/home.png');
    await expect(rows.first().locator('.live-sheen')).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'running');
    await expect(summaries).toHaveCount(0);
    await settled(page);
    await shot('image');

    // A finished call stays in view, marked done, until the agent takes its next step.
    await emit(page, call('shot', { ...image, revision: 2, status: 'complete' }));
    await expect(rows.first()).toContainText('Viewed');
    await expect(rows.first()).toHaveAttribute('data-status', 'complete');
    await expect(rows.first().locator('.live-sheen')).toHaveCount(0);
    await expect(summaries).toHaveCount(0);

    // The next call takes its place, and the finished one folds into the group's count.
    await emit(page, call('tests', { ...command, elapsedMs: 0 }));
    await expect(summaries).toHaveText(['Viewed 1 image']);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Running');
    await expect(rows.first()).toContainText('npm test -- --run');
    await expect(rows.first().locator('.live-target')).toHaveAttribute('class', /code/);
    await emit(
      page,
      call('tests', {
        ...command,
        revision: 2,
        elapsedMs: 12000,
        progress: { kind: 'output', atElapsedMs: 11000 },
      }),
    );
    await expect(rows.first()).toContainText('Output received');
    await expect(rows.first()).toContainText('12s');
    await settled(page);
    await shot('command');

    // Parallel calls each get a row; finished ones fold while the others still run.
    for (const name of ['app', 'menu', 'tests'])
      await emit(page, call(`read-${name}`, read(`/fixture/src/${name}.ts`)));
    await expect(rows).toHaveCount(4);
    await settled(page);
    await shot('parallel');
    await emit(
      page,
      call('read-app', { ...read('/fixture/src/app.ts'), revision: 2, status: 'complete' }),
    );
    await emit(
      page,
      call('read-menu', { ...read('/fixture/src/menu.ts'), revision: 2, status: 'complete' }),
    );
    await expect(summaries).toHaveText(['Viewed 1 image and read 2 files']);
    await expect(rows).toHaveCount(2);
    await emit(
      page,
      call('tests', { ...command, revision: 3, status: 'complete', elapsedMs: 14000 }),
    );
    await emit(
      page,
      call('read-tests', { ...read('/fixture/src/tests.ts'), revision: 2, status: 'complete' }),
    );
    await expect(summaries).toHaveText(['Viewed 1 image, ran 1 command, and read 2 files']);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Read');
    await expect(rows.first()).toContainText('fixture/src/tests.ts');

    // A running sub-agent shows its own latest call beneath it.
    const agent = (status: string, revision: number) =>
      call('agents', {
        category: 'agent',
        name: 'Sub-agents',
        status,
        revision,
        agents: [{ id: 'explore', name: 'Explore the auth flow', status, task: 'Find sessions' }],
      });
    await emit(page, agent('running', 1));
    await emit(
      page,
      call('child-read', { ...read('/fixture/src/auth/session.ts'), parentId: 'explore' }),
    );
    await expect(summaries).toHaveText(['Viewed 1 image, ran 1 command, and read 3 files']);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Working with');
    await expect(rows.first()).toContainText('Explore the auth flow');
    await expect(rows.first().locator('.live-child')).toContainText('Reading');
    await expect(rows.first().locator('.live-child')).toContainText('session.ts');
    await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
    await settled(page);
    await shot('sub-agent');

    // Expanding the group lists the folded calls; the row of the running call stays below it.
    await summaries.first().click();
    await expect(page.locator('.activity-group .tool-card')).toHaveCount(5);
    await expect(rows).toHaveCount(1);
    await summaries.first().click();

    // Moving on folds the latest call too.
    await emit(
      page,
      call('child-read', {
        ...read('/fixture/src/auth/session.ts'),
        parentId: 'explore',
        revision: 2,
        status: 'complete',
      }),
    );
    await emit(page, agent('complete', 2));
    await expect(rows.first()).toContainText('Worked with');
    await expect(rows.first().locator('.live-child')).toHaveCount(0);
    await emit(page, { kind: 'progress', id: 'done', revision: 1, text: 'Everything passed.' });
    await expect(rows).toHaveCount(0);
    await expect(summaries).toHaveText([
      'Viewed 1 image, ran 1 command, read 3 files, and worked with 1 sub-agent',
    ]);
    await settled(page);
    await expect(page.locator('.live-item')).toHaveCount(1);
    expect(
      await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);

    await emit(page, { kind: 'text', text: 'Everything passed.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await page.getByLabel('Work history', { exact: true }).click();
    await expect(summaries).toHaveText([
      'Viewed 1 image, ran 1 command, read 3 files, and worked with 1 sub-agent',
    ]);
    await expect(page.locator('.live-row, .live-item')).toHaveCount(0);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  });

test('an opened row shows its call and stays until it is closed', async ({ page }) => {
  await start(page, 'Build the app');
  const rows = page.locator('.live-row');
  const script = 'npm run build\nnpm run lint';
  await emit(page, call('build', { ...command, command: script }));
  const build = rows.first();
  await expect(build.locator('.live-target')).toHaveText('npm run build …');
  await expect(build.locator('.live-line')).toHaveAttribute('title', script);
  await expect(build.locator('.tool-body')).toHaveCount(0);
  await build.locator(':scope > summary').click();
  await expect(build.getByTestId('tool-result')).toContainText('npm run lint');
  await emit(page, call('build', { ...command, command: script, revision: 2, status: 'complete' }));
  await emit(page, call('next', read('/fixture/next.ts')));
  // The opened call stays in view after the agent moves on.
  await expect(rows).toHaveCount(2);
  await expect(build).toHaveAttribute('open', '');
  await expect(build.locator('.live-verb')).toHaveText('Ran');
  await expect(page.locator('.activity-group')).toHaveCount(0);
  // Closing it lets it fold into its group.
  await build.locator(':scope > summary').click();
  await expect(page.locator('.activity-group > summary')).toHaveText(['Ran 1 command']);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Reading');
});

test('failed and unfinished calls keep a truthful row until they fold', async ({ page }) => {
  await start(page, 'Run the checks');
  const rows = page.locator('.live-row');
  await emit(page, call('lint', { ...command, command: 'npm run lint' }));
  await emit(
    page,
    call('lint', { ...command, command: 'npm run lint', revision: 2, status: 'error' }),
  );
  await expect(rows.first()).toHaveAttribute('data-status', 'error');
  // The unfinished form names the call without claiming it ran.
  await expect(rows.first().locator('.live-verb')).toHaveText('Command');
  await expect(rows.first().locator('.live-status')).toContainText('Failed');
  await emit(page, call('web', { category: 'search', name: 'Web search', query: 'svelte flip' }));
  // The failed command's words are red, with no outcome beside them.
  const summary = page.locator('.activity-group > summary');
  await expect(summary.locator('.failed-part')).toHaveText('1 command');
  await expect(summary.locator('.tool-status')).toHaveCount(0);
  await expect(summary).toMatchAriaSnapshot('- text: 1 command failed');
  const colors = await summary.evaluate((row) => {
    const part = row.querySelector('.failed-part')!;
    const danger = document.createElement('span');
    danger.style.color = 'var(--danger)';
    row.append(danger);
    const color = (element: Element) => getComputedStyle(element).color;
    const found = [color(part), color(danger), color(row)];
    danger.remove();
    return found;
  });
  expect(colors[0]).toBe(colors[1]);
  expect(colors[0]).not.toBe(colors[2]);
  await expect(rows.first()).toContainText('Searching the web for');
  await expect(rows.first()).toContainText('svelte flip');
  await page.evaluate(() => (window as any).finishCapabilities('cancelled'));
  await expect(rows).toHaveCount(0);
  await page.getByLabel('Work history', { exact: true }).click();
  // The failed command is red; the web search the stop left unfinished is marked beside it.
  const history = page.locator('.activity-group > summary');
  await expect(history).toContainText('1 command failed and 1 web search');
  await expect(history.locator('.failed-part')).toHaveText('1 command');
  await expect(history.locator('.tool-status')).toHaveText('Stopped');
});

test('folding rows keep a followed chat in place until new content fills the space', async ({
  page,
}) => {
  // A long first message makes the conversation scroll above the reply.
  const context = Array.from({ length: 40 }, (_, i) => `Context line ${i + 1}`).join('\n');
  await start(page, context);
  await emit(page, { kind: 'progress', id: 'plan', revision: 1, text: 'Reading the sources.' });
  for (const name of ['a', 'b', 'c', 'd'])
    await emit(page, call(`read-${name}`, read(`/fixture/src/${name}.ts`)));
  await expect(page.locator('.live-row')).toHaveCount(4);
  const measure = () =>
    page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!;
      const top = scroll.getBoundingClientRect().top;
      return {
        end: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
        space: document.querySelector<HTMLElement>('.chat-virtual-space')!.offsetHeight,
        plan: document.querySelector('.progress-message')!.getBoundingClientRect().top - top,
      };
    });
  await settled(page);
  // The chat glides to its end after the first message.
  await expect.poll(async () => (await measure()).end).toBeLessThan(1);
  const before = await measure();
  for (const name of ['a', 'b', 'c'])
    await emit(
      page,
      call(`read-${name}`, { ...read(`/fixture/src/${name}.ts`), revision: 2, status: 'complete' }),
    );
  await expect(page.locator('.live-row')).toHaveCount(1);
  await settled(page);
  const held = await measure();
  // Three rows became one summary and one row: the chat did not move down.
  expect(Math.abs(held.plan - before.plan)).toBeLessThan(1);
  expect(held.space).toBeGreaterThan(20);
  expect(held.end).toBeLessThan(2);
  await emit(
    page,
    call('read-d', { ...read('/fixture/src/d.ts'), revision: 2, status: 'complete' }),
  );
  await emit(page, {
    kind: 'progress',
    id: 'next',
    revision: 1,
    text: 'The sources are ready.\n\n'.repeat(12),
  });
  await expect(page.locator('.live-row')).toHaveCount(0);
  await expect
    .poll(async () => {
      const next = await measure();
      return next.space === 0 && next.end < 2;
    })
    .toBe(true);
  expect((await measure()).plan).toBeLessThan(held.plan - 100);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
});

test('reduced motion folds rows at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page, 'Read two files');
  await emit(page, call('one', { ...read('/fixture/one.ts'), status: 'complete' }));
  await emit(page, call('two', read('/fixture/two.ts')));
  await expect(page.locator('.activity-group > summary')).toHaveText(['Read 1 file']);
  // Nothing moves: no faded copy of the folded row lingers, and no row slides or sweeps.
  await expect(page.locator('.live-item')).toHaveCount(2);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(
    await page
      .locator('.live-row')
      .evaluate((el) => getComputedStyle(el.querySelector('.live-sheen')!).opacity),
  ).toBe('0');
});
