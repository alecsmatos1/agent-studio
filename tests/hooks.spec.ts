import { expect, test } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true]) {
  test(`hooks appear in context and revisioned Work history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.evaluate(() => {
      (window as any).hookEntries = [
        {
          name: 'PreToolUse · Command 1',
          path: '/fixture/hooks.json',
          kind: 'hooks',
          scope: 'Project',
          status: 'configured',
          detail: 'Command hook. Trust: trusted. Matcher: Bash.',
        },
        {
          name: 'Stop · Command 2',
          path: '/fixture/hooks.json',
          kind: 'hooks',
          scope: 'Project',
          status: 'needsReview',
          detail: 'Command hook. Trust: modified.',
        },
        {
          name: 'SessionStart · Command 3',
          path: '/profile/hooks.json',
          kind: 'hooks',
          scope: 'User',
          status: 'disabled',
          detail: 'Disabled in the selected profile.',
        },
      ];
    });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Keep this draft');
    if (mobile) await page.getByRole('button', { name: 'Conversation actions' }).click();
    await page.getByRole('button', { name: 'Model context', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Model context' });
    await dialog.getByRole('button', { name: /^Hooks/ }).click();
    await expect(dialog.locator('.context-entry')).toHaveCount(3);
    await expect(dialog.getByText('Review required', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Disabled', { exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Filter context sources' }).fill('Bash');
    await expect(dialog.locator('.context-entry')).toHaveCount(1);
    await dialog.getByRole('textbox', { name: 'Filter context sources' }).fill('');
    await page.screenshot({ path: `artifacts/hooks/context-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.keyboard.press('Escape');
    await expect(composer).toHaveValue('Keep this draft');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const hook = (revision: number, status: string) => ({
      kind: 'tool',
      tool: {
        id: 'hook:one',
        category: 'hook',
        name: 'PreToolUse hook',
        revision,
        status,
        facts: [
          { label: 'Event', value: 'PreToolUse' },
          { label: 'Handler', value: 'Command' },
        ],
        sources: [],
        agents: [],
      },
    });
    await emit(hook(1, 'running'));
    // A running hook shows what it does in a row of its own, which opens like a call.
    const row = page.locator('.live-row').last();
    await expect(row.locator(':scope > summary')).toContainText('Running');
    await expect(row.locator(':scope > summary')).toContainText('PreToolUse hook');
    await row.locator(':scope > summary').click();
    await emit(hook(2, 'blocked'));
    await emit(hook(1, 'running'));
    await expect(page.locator('.live-row')).toHaveCount(1);
    await expect(row).toHaveAttribute('open', '');
    await expect(row.locator(':scope > summary')).toContainText('Blocked');
    await expect(row.getByText('Command', { exact: true })).toBeVisible();
    await emit({ kind: 'text', text: 'Hook verification complete.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await page.getByLabel('Work history', { exact: true }).click();
    const group = page.locator('.activity-group').last();
    await group.locator(':scope > summary').click();
    await group.locator('.tool-card > summary').click();
    await expect(group.getByText('Command', { exact: true })).toBeVisible();
    await page.screenshot({ path: `artifacts/hooks/history-${mobile ? 'mobile' : 'desktop'}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('test-workspace') ?? ''))
      .toContain('hook:one');
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('tab', { name: /History/ }).click();
    await page.locator('.conversation-item').first().click();
    await page.getByLabel('Work history', { exact: true }).click();
    // The blocked hook's words are red, with no outcome beside them.
    const summary = page.locator('.activity-group').last().locator(':scope > summary');
    await expect(summary.locator('.failed-part')).toHaveText('1 hook');
    await expect(summary.locator('.tool-status')).toHaveCount(0);
    await expect(summary).toMatchAriaSnapshot('- text: 1 hook blocked');
  });
}
