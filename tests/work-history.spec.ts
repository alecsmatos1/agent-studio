import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true])
  test(`tool batches stay compact while running and in saved history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Check the source and run tests');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const tool = (id: string, operation: string, name: string, extra = {}) => ({
      kind: 'tool',
      tool: {
        id,
        operation,
        name,
        category: 'tool',
        revision: 1,
        status: 'complete',
        sources: [],
        agents: [],
        ...extra,
      },
    });
    await emit({
      kind: 'progress',
      id: 'before',
      revision: 1,
      text: 'I will check the source files.',
    });
    await emit(tool('read1', 'read', 'Read', { path: '/fixture/app.ts' }));
    await emit(tool('read2', 'read', 'Read', { path: '/fixture/menu.ts' }));
    const groups = page.locator('.activity-group');
    const rows = page.locator('.live-row');
    await expect(groups).toHaveCount(1);
    // The latest call keeps a row of its own until the agent moves on.
    await expect(groups.first().locator(':scope > summary')).toHaveText('Read 1 file');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(':scope > summary')).toContainText('menu.ts');
    await expect(groups.first()).not.toHaveAttribute('open', '');
    await expect(page.locator('.tool-card').first()).not.toBeVisible();
    await groups.first().locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(groups.first().locator('.tool-card')).toHaveCount(1);
    await expect(groups.first().locator('.tool-card').first()).not.toHaveAttribute('open', '');
    await emit(
      tool('read2', 'read', 'Read', {
        revision: 2,
        path: '/fixture/menu.ts',
        facts: [{ label: 'Lines read', value: '8' }],
      }),
    );
    await emit(tool('read3', 'read', 'Read', { path: '/fixture/tests.ts' }));
    // Reading a file again adds a call but not another file.
    await emit(tool('read4', 'read', 'Read', { path: '/fixture/app.ts' }));
    await expect(groups.first()).toHaveAttribute('open', '');
    await expect(groups.first().locator('.tool-card')).toHaveCount(3);
    await expect(groups.first().locator(':scope > summary')).toHaveText('Read 3 files');
    await expect(rows.first().locator(':scope > summary')).toContainText('app.ts');
    await groups.first().locator('.tool-card > summary').nth(1).click();
    await expect(page.getByText('Lines read', { exact: true })).toBeVisible();
    await groups.first().locator(':scope > summary').focus();
    await page.keyboard.press('Space');
    await emit({
      kind: 'progress',
      id: 'middle',
      revision: 1,
      text: 'The source is ready. I will update it and run the checks.',
    });
    await emit(tool('edit', 'edit', 'Edit', { path: '/fixture/app.ts' }));
    await emit(
      tool('run', 'command', 'Run command', {
        commandRun: true,
        status: 'running',
        detail: 'Run the fixture tests',
      }),
    );
    await expect(groups).toHaveCount(2);
    await expect(groups.first().locator(':scope > summary')).toHaveText('Read 3 files');
    await expect(groups.last().locator(':scope > summary')).toHaveText('Edited 1 file');
    await expect(groups.last()).not.toHaveAttribute('open', '');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(':scope > summary')).toContainText(
      'Running Run the fixture tests',
    );
    await page.getByLabel('Message', { exact: true }).fill('Keep my next message');
    await page.screenshot({
      path: `artifacts/grouped-activity-running-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await emit(
      tool('run', 'command', 'Run command', {
        commandRun: true,
        revision: 2,
        status: 'error',
        detail: 'Run the fixture tests',
        facts: [{ label: 'Exit code', value: '1' }],
      }),
    );
    await expect(rows.first()).toHaveAttribute('data-status', 'error');
    await expect(rows.first().locator(':scope > summary')).toContainText('Failed');
    await expect(rows.first().locator(':scope > summary')).not.toContainText('Ran');
    await emit({ kind: 'text', text: 'The update is ready, but a check failed.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    const history = page.locator('.activity-summary');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(page.getByLabel('Work history', { exact: true })).toHaveText('Work history');
    await page.getByLabel('Work history', { exact: true }).click();
    await expect(history.getByLabel('Filter activity')).toHaveCount(0);
    await expect(groups).toHaveCount(2);
    // Only the failed command's words are red, with no outcome beside the label.
    await expect(groups.locator(':scope > summary')).toHaveText([
      'Read 3 files',
      'Edits to 1 file and 1 command failed',
    ]);
    await expect(groups.locator('.failed-part')).toHaveText(['1 command']);
    await expect(groups.locator(':scope > summary .tool-status')).toHaveCount(0);
    await expect(page.locator('.activity-group[open], .tool-card[open]')).toHaveCount(0);
    const sequence = () =>
      page
        .locator('.activity-timeline')
        .evaluate((el) =>
          [...el.children].map((child) =>
            (child.querySelector(':scope > summary') ?? child).textContent
              ?.replace(/\s+/g, ' ')
              .trim(),
          ),
        );
    const savedSequence = await sequence();
    expect(savedSequence).toEqual([
      'Connected',
      'I will check the source files.',
      'Read 3 files',
      'The source is ready. I will update it and run the checks.',
      'Edits to 1 file and 1 command failed',
    ]);
    await page
      .locator('.chat-scroll')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
    await page.screenshot({
      path: `artifacts/grouped-activity-history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await groups.last().locator(':scope > summary').click();
    await groups.last().locator('.tool-card > summary').last().click();
    await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my next message');
    expect(await history.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await page.getByLabel('Work history', { exact: true }).click();
    expect(await sequence()).toEqual(savedSequence);
    await expect(page.locator('.activity-group[open], .tool-card[open]')).toHaveCount(0);
    await expect(page.getByLabel('Work history', { exact: true })).toHaveText('Work history');
    await expect(history.getByLabel('Filter activity')).toHaveCount(0);
    await expect(groups).toHaveCount(2);
    await groups.last().locator(':scope > summary').click();
    await groups.last().locator('.tool-card > summary').last().click();
    await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
  });

for (const mobile of [false, true])
  test(`progress-only work history stays above the answer ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Compare the options');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    await page.evaluate(() => {
      const emit = (window as any).emitCapability;
      emit({ kind: 'activity', text: 'Starting the provider CLI' });
      emit({ kind: 'activity', text: 'Connected to Claude' });
    });
    await expect(page.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const emit = (window as any).emitCapability;
      emit({ kind: 'progress', id: 'first', revision: 1, text: 'I will compare the options.' });
      emit({
        kind: 'progress',
        id: 'second',
        revision: 1,
        text: 'The second option fits your requirements.',
      });
      emit({ kind: 'text', text: 'Choose the second option.' });
      (window as any).finishCapabilities('complete');
    });
    const reply = page.locator('.message[data-status="complete"]').last();
    const history = reply.locator('.activity-summary');
    const toggle = reply.getByLabel('Work history', { exact: true });
    // Expanded history ends with a divider, which starts with a control that closes it.
    const divider = history.locator('.history-end');
    const collapse = divider.getByRole('button', { name: 'Collapse Work history', exact: true });
    const draft = page.getByLabel('Message', { exact: true });
    await draft.fill('Keep this next message');
    await expect(toggle).toHaveText('Work history');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(divider).toBeHidden();
    await expect(reply.locator('.message-heading + .tool-activity + .prose')).toHaveText(
      'Choose the second option.',
    );
    await expect(history.locator('.progress-message').first()).not.toBeVisible();
    await page.screenshot({
      path: `artifacts/work-history-collapsed-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(history.locator('.progress-message')).toHaveText([
      'I will compare the options.',
      'The second option fits your requirements.',
    ]);
    await expect(history.locator('.activity-filters')).toHaveCount(0);
    await expect(collapse).toHaveText('Collapse');
    expect(await divider.evaluate((el) => getComputedStyle(el, '::after').borderTopStyle)).toBe(
      'solid',
    );
    await expect(history.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(history.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await expect(draft).toHaveValue('Keep this next message');
    expect(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/work-history-expanded-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(divider).toBeHidden();
    await expect(draft).toHaveValue('Keep this next message');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await toggle.click();
    await expect(history.getByText('Starting the provider CLI', { exact: true })).toHaveCount(0);
    await expect(history.getByText('Connected to Claude', { exact: true })).toHaveCount(0);
    await expect(history.locator('.progress-message')).toHaveCount(2);
    // Closing from the end hands the control's focus to the summary.
    await collapse.focus();
    await page.keyboard.press('Enter');
    await expect(history).not.toHaveAttribute('open', '');
    await expect(divider).toBeHidden();
    await expect(toggle).toBeFocused();
  });

test('collapsed disclosures render on first expansion and keep nested expansion', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Check the source');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit({ kind: 'progress', id: 'plan', revision: 1, text: 'I will read the source.' });
  for (const [id, path] of [
    ['read1', '/fixture/app.ts'],
    ['read2', '/fixture/menu.ts'],
  ])
    await emit({
      kind: 'tool',
      tool: {
        id,
        operation: 'read',
        name: 'Read',
        category: 'tool',
        revision: 1,
        status: 'complete',
        path,
        facts: [{ label: 'Lines read', value: '8' }],
        sources: [],
        agents: [],
      },
    });
  // A collapsed group has no calls in the page while the reply runs, and the latest call's own
  // row renders its details only when opened.
  const group = page.locator('.activity-group');
  await expect(group.locator(':scope > summary')).toHaveText('Read 1 file');
  await expect(page.locator('.live-row')).toHaveCount(1);
  await expect(group.locator('.tool-card')).toHaveCount(0);
  await expect(page.locator('.tool-body')).toHaveCount(0);
  await emit({ kind: 'text', text: 'The source is fine.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  const history = page.locator('.activity-summary');
  await expect(history).not.toHaveAttribute('open', '');
  await expect(history.locator('.activity-timeline')).toHaveCount(0);
  // Closed content is out of rendering rather than Chromium's content-visibility: hidden,
  // which a text selection across it restyles all at once.
  const content = () => history.evaluate((el) => getComputedStyle(el, '::details-content').display);
  expect(await content()).toBe('none');
  await history.locator(':scope > summary').click();
  await expect(history.getByText('I will read the source.', { exact: true })).toBeVisible();
  expect(await content()).toBe('block');
  await expect(group.locator('.tool-card')).toHaveCount(0);
  await group.locator(':scope > summary').click();
  await expect(group.locator('.tool-card')).toHaveCount(2);
  const card = group.locator('.tool-card').first();
  await expect(card.locator('.tool-body')).toHaveCount(0);
  await card.locator(':scope > summary').click();
  await expect(card.getByText('Lines read', { exact: true })).toBeVisible();
  // Collapsing keeps what was rendered, so reopening restores the nested expansion.
  await history.locator(':scope > summary').click();
  await expect(history).not.toHaveAttribute('open', '');
  expect(await content()).toBe('none');
  await history.locator(':scope > summary').click();
  await expect(group).toHaveAttribute('open', '');
  await expect(card).toHaveAttribute('open', '');
  await expect(card.getByText('Lines read', { exact: true })).toBeVisible();
});
