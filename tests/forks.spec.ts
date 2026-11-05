import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import type { Workspace } from '../src/lib/domain';

const saved = (page: Page): Promise<Workspace> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
const input = (page: Page) => page.getByLabel('Message', { exact: true });
const row = (page: Page, title: string) =>
  page.locator('.conversation-item').getByText(title, { exact: true });
async function start(page: Page, mode = 'success') {
  await mockDesktop(page, mode);
  await page.goto('/');
  await chooseTestFolder(page);
}
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await expect
    .poll(async () => (await saved(page)).conversations[0]?.messages.at(-1)?.status)
    .toBe('complete');
}

test('forks the full chat, sends nothing automatically, and preserves the source draft', async ({
  page,
}) => {
  await start(page);
  await send(page, 'Original question');
  await expect
    .poll(async () => (await saved(page)).conversations[0].titleStatus)
    .not.toBe('pending');
  const source = (await saved(page)).conversations[0];
  await input(page).fill('Unsent source draft');
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.locator('.page-title')).toHaveText(`${source.title} (fork)`);
  await expect(input(page)).toHaveValue('');
  await expect(input(page)).toBeFocused();
  const fork = (await saved(page)).conversations.find((c) => c.id !== source.id)!;
  expect(fork.settings).toEqual(source.settings);
  expect(fork.location).toEqual(source.location);
  expect(fork.messages).toHaveLength(2);
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  await send(page, 'Only in the fork');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.conversationId).toBe(fork.id);
  expect(request.forked).toBe(true);
  // Its first reply continues the source's native session after the reply it was copied through.
  expect(request.forkedFrom).toEqual([source.id]);
  expect(request.lastReply).toEqual({ runId: source.messages[1].runId });
  expect(request.rewound).toBeUndefined();
  expect(request.agent.connectionId).toBe(source.settings.connectionId);
  expect(request.messages[0].text).toBe('Original question');
  expect((await saved(page)).conversations.find((c) => c.id === source.id)).toEqual(source);
  await row(page, source.title).click();
  await expect(input(page)).toHaveValue('Unsent source draft');
  await expect(page.getByText('Only in the fork', { exact: true })).toHaveCount(0);
});

test('forks through an earlier reply and keeps only its preceding history after reload', async ({
  page,
}) => {
  await start(page);
  await send(page, 'First question');
  await send(page, 'Later question to exclude');
  const source = (await saved(page)).conversations[0];
  await page.getByRole('button', { name: 'Fork from here', exact: true }).first().click();
  await expect(page.getByTestId('message')).toHaveCount(2);
  await expect(page.getByText('Later question to exclude', { exact: true })).toHaveCount(0);
  const fork = (await saved(page)).conversations.find((c) => c.id !== source.id)!;
  await page.screenshot({ path: 'artifacts/fork-earlier-browser.png' });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await row(page, fork.title).click();
  await expect(page.getByTestId('message')).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toBeDisabled();
});

test('forks a History row with keyboard navigation without restoring or editing the source', async ({
  page,
}) => {
  await start(page);
  await send(page, 'History source');
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect.poll(async () => (await saved(page)).conversations[0].archived).toBe(true);
  await page.getByRole('tab', { name: /History/ }).click();
  const source = (await saved(page)).conversations[0];
  const sourceRow = page
    .locator('.conversation-item')
    .filter({ has: page.getByText(source.title, { exact: true }) });
  await sourceRow.focus();
  await sourceRow.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Fork conversation' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete conversation' })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-title')).toHaveText(`${source.title} (fork)`);
  await expect(page.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true');
  expect((await saved(page)).conversations.find((c) => c.id === source.id)).toEqual(source);
});

test('during a running reply only forks finished history and leaves the original run alive', async ({
  page,
}) => {
  await start(page, 'capabilities');
  await input(page).fill('First request');
  await input(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fork conversation', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Finished answer' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const source = (await saved(page)).conversations[0];
  await input(page).fill('In-flight question');
  await input(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.getByTestId('message')).toHaveCount(2);
  expect(
    (await saved(page)).conversations.find((c) => c.id === source.id)?.messages.at(-1)?.status,
  ).toBe('running');
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Original completed later' });
    (window as any).finishCapabilities('complete');
  });
  await expect
    .poll(
      async () =>
        (await saved(page)).conversations.find((c) => c.id === source.id)?.messages.at(-1)?.status,
    )
    .toBe('complete');
  await expect(page.getByText('Original completed later', { exact: true })).toHaveCount(0);
});

test('save failure keeps the original and draft and allows retry without a duplicate fork', async ({
  page,
}) => {
  await start(page);
  await send(page, 'Preserve on failure');
  await input(page).fill('Draft to preserve');
  await page.evaluate(() => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const original = bridge.invoke.bind(bridge);
    bridge.invoke = (command: string, args: any) => {
      args = (window as any).studioCallArguments(command, args);
      const conversations =
        command === 'save_workspace'
          ? args.workspace.conversations
          : command === 'save_workspace_patch'
            ? args.upsert
            : [];
      if (
        conversations.some((c: any) => c.title.endsWith('(fork)')) &&
        !(window as any).allowForkSave
      )
        throw new Error('Synthetic disk full');
      return original(command, args);
    };
  });
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.getByText(/Could not fork conversation:/)).toBeVisible();
  await expect(input(page)).toHaveValue('Draft to preserve');
  expect((await saved(page)).conversations).toHaveLength(1);
  await page.evaluate(() => ((window as any).allowForkSave = true));
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.locator('.page-title')).toContainText('(fork)');
  expect((await saved(page)).conversations).toHaveLength(2);
  await expect(page.getByText(/Could not fork conversation:/)).toHaveCount(0);
});

test('fork actions fit a narrow screen and work from the mobile actions menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await send(page, 'Mobile fork');
  await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.locator('.page-title')).toContainText('(fork)');
  await expect(
    page.getByRole('button', { name: 'Conversation actions', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Fork from here' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/fork-mobile-browser.png' });
});
