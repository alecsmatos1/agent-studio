import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const title = (page: Page) => page.locator('.page-title');
const folder = (page: Page) => page.getByRole('combobox', { name: 'Folder', exact: true });
const activeTab = (page: Page) => page.getByRole('tab', { name: /^Active/ });
// Row titles, without the elapsed time a running reply shows beside its title.
const titles = (page: Page, panel: string) =>
  page
    .locator(`#conversation-panel-${panel} .conversation-item > span:not(.conversation-running)`)
    .allTextContents();
const activeRows = (page: Page) => titles(page, 'active');
const historyRows = (page: Page) => titles(page, 'history');
const row = (page: Page, name: string) =>
  page.locator('.conversation-row').filter({
    has: page.getByRole('button', { name, exact: true }),
  });
const archive = (page: Page, name: string) =>
  page.getByRole('button', { name: `Move ${name} to history`, exact: true });

async function start(page: Page, mode = 'success') {
  await mockDesktop(page, mode);
  await page.goto('/');
  await chooseTestFolder(page);
}
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
}
// Sends each chat from a new conversation. The sidebar lists the newest first.
async function chats(page: Page, ...names: string[]) {
  for (const name of names) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await send(page, name);
  }
}
// Chooses C:\Projects\<name> as the new chat's folder.
async function chooseProject(page: Page, name: string) {
  await folder(page).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a folder' });
  await dialog
    .getByRole('navigation', { name: 'Current folder' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await dialog
    .getByRole('list', { name: 'Folders' })
    .getByRole('button', { name, exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
// Two chats in studio, newer first, then one in tools, listed in that order.
async function projects(page: Page, studio: [string, string], tools: string) {
  await chats(page, studio[1]);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseProject(page, 'tools');
  await send(page, tools);
  await page
    .getByRole('button', { name: 'New conversation in studio on Desktop', exact: true })
    .click();
  await send(page, studio[0]);
  expect(await activeRows(page)).toEqual([...studio, tools]);
}
const lastRequest = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));

test('the toolbar moves the open chat to history first and opens the next Active chat', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'Third chat', 'Second chat', 'First chat');
  expect(await activeRows(page)).toEqual(['First chat', 'Second chat', 'Third chat']);
  const actions = page.locator('.chat-toolbar .action-items > button');
  await expect(actions.first()).toHaveAccessibleName('Move to history');
  expect(await actions.evaluateAll((buttons) => buttons.map((b) => b.ariaLabel))).toEqual([
    'Move to history',
    'Snooze',
    'Pin',
    'Fork conversation',
    'Model context',
    'Chat instructions',
  ]);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  // The chat listed below takes its place, and the sidebar stays on Active.
  await expect(title(page)).toHaveText('Second chat');
  await expect(activeTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#conversation-panel-history')).toBeHidden();
  await expect(row(page, 'Second chat').locator('.conversation-item')).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await activeRows(page)).toEqual(['Second chat', 'Third chat']);
  expect(await historyRows(page)).toEqual(['First chat']);
  await expect(input(page)).toBeFocused();
  // The last chat in the list gives way to the one above it.
  await page.getByRole('button', { name: 'Third chat', exact: true }).click();
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('Second chat');
  // With no Active conversation left, a new chat opens.
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('New conversation');
  await expect(activeTab(page)).toHaveAttribute('aria-selected', 'true');
  expect(await activeRows(page)).toEqual([]);
  expect(await historyRows(page)).toEqual(['Second chat', 'Third chat', 'First chat']);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations.map(
      (c: { archived?: boolean }) => c.archived,
    ),
  );
  expect(saved).toEqual([true, true, true]);
});

test('while searching, the next matching chat opens first', async ({ page }) => {
  await start(page);
  await chats(page, 'Deploy notes', 'Unrelated chat', 'Deploy checklist');
  await page.getByLabel('Search conversations').fill('deploy');
  expect(await activeRows(page)).toEqual(['Deploy checklist', 'Deploy notes']);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('Deploy notes');
  // The only match left falls back to the next chat outside the search.
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('Unrelated chat');
});

test('a project keeps its place: its next chat, or a new chat in it after its last', async ({
  page,
}) => {
  await start(page);
  await projects(page, ['Studio newer', 'Studio older'], 'Tools chat');
  // The bottom chat of a project gives way to the one above it, not to the next project's chat.
  await page.getByRole('button', { name: 'Studio older', exact: true }).click();
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('Studio newer');
  // Its last chat, here from its row, leaves a new chat with the project selected.
  await row(page, 'Studio newer').hover();
  await archive(page, 'Studio newer').click();
  await expect(title(page)).toHaveText('New conversation');
  await expect(folder(page)).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(page.getByRole('button', { name: 'Tools chat', exact: true })).toBeFocused();
  await expect(activeTab(page)).toHaveAttribute('aria-selected', 'true');
  expect(await activeRows(page)).toEqual(['Tools chat']);
  await send(page, 'Studio again');
  expect((await lastRequest(page)).location.path).toBe('C:\\Projects\\studio');
  // The same from the toolbar, which moves focus to the new chat's composer.
  await page.getByRole('button', { name: 'Tools chat', exact: true }).click();
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('New conversation');
  await expect(folder(page)).toHaveAttribute('title', 'C:\\Projects\\tools');
  await expect(input(page)).toBeFocused();
  expect(await activeRows(page)).toEqual(['Studio again']);
});

test('while searching, the project keeps its place before matches in other projects', async ({
  page,
}) => {
  await start(page);
  await projects(page, ['Deploy studio', 'Studio notes'], 'Deploy tools');
  await page.getByLabel('Search conversations').fill('deploy');
  expect(await activeRows(page)).toEqual(['Deploy studio', 'Deploy tools']);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('Studio notes');
  // A new chat in the project keeps the search.
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(title(page)).toHaveText('New conversation');
  await expect(folder(page)).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(page.getByLabel('Search conversations')).toHaveValue('deploy');
  expect(await activeRows(page)).toEqual(['Deploy tools']);
});

test('sidebar rows move to history on hover without leaving the open chat or its draft', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'Third chat', 'Second chat', 'First chat');
  await input(page).fill('Keep this draft');
  const button = archive(page, 'Second chat');
  await expect(button).toHaveCSS('opacity', '0');
  await row(page, 'Second chat').hover();
  await expect(button).toHaveCSS('opacity', '1');
  // The row keeps its height, with the action centered at its end.
  const [rowBox, itemBox, buttonBox] = await Promise.all([
    row(page, 'Second chat').boundingBox(),
    page.getByRole('button', { name: 'Second chat', exact: true }).boundingBox(),
    button.boundingBox(),
  ]);
  expect(rowBox!.height).toBe(itemBox!.height);
  expect(buttonBox!.y + buttonBox!.height / 2).toBeCloseTo(rowBox!.y + rowBox!.height / 2, 0);
  expect(rowBox!.x + rowBox!.width - (buttonBox!.x + buttonBox!.width)).toBeCloseTo(3, 0);
  await page.screenshot({ path: 'artifacts/move-to-history-hover.png', animations: 'disabled' });
  await button.click();
  expect(await activeRows(page)).toEqual(['First chat', 'Third chat']);
  expect(await historyRows(page)).toEqual(['Second chat']);
  await expect(title(page)).toHaveText('First chat');
  await expect(input(page)).toHaveValue('Keep this draft');
  await expect(activeTab(page)).toHaveAttribute('aria-selected', 'true');
  // History rows have no Move to history of their own.
  await activeTab(page).press('End');
  await expect(page.locator('#conversation-panel-history .conversation-archive')).toHaveCount(0);
  await activeTab(page).click();
  // Keyboard: the action follows its row, and focus moves on to the row now in its place.
  await page.getByRole('button', { name: 'Third chat', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(archive(page, 'Third chat')).toBeFocused();
  await expect(archive(page, 'Third chat')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'First chat', exact: true })).toBeFocused();
  await expect(title(page)).toHaveText('First chat');
  // The open chat gives way to a new one when it was the last Active chat.
  await archive(page, 'First chat').focus();
  await page.keyboard.press('Enter');
  await expect(title(page)).toHaveText('New conversation');
  await expect(page.getByRole('tab', { name: /^Active/ })).toBeFocused();
  expect(await historyRows(page)).toEqual(['First chat', 'Third chat', 'Second chat']);
  // The open chat's draft stays with it in History.
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'First chat', exact: true }).click();
  await expect(input(page)).toHaveValue('Keep this draft');
});

test('a sidebar row of the open chat opens the next chat, and running chats keep their row', async ({
  page,
}) => {
  await start(page, 'capabilities');
  for (const name of ['Running chat', 'Finished chat', 'Open chat']) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await input(page).fill(name);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'running');
    if (name !== 'Running chat')
      await page.evaluate(() => {
        (window as any).emitCapability({ kind: 'text', text: 'Done' });
        (window as any).finishCapabilities('complete');
      });
  }
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  expect(await activeRows(page)).toEqual(['Open chat', 'Finished chat', 'Running chat']);
  await expect(row(page, 'Running chat').locator('.conversation-running')).toHaveCount(1);
  await expect(archive(page, 'Running chat')).toHaveCount(0);
  await row(page, 'Open chat').hover();
  await archive(page, 'Open chat').click();
  await expect(title(page)).toHaveText('Finished chat');
  await expect(row(page, 'Finished chat').locator('.conversation-item')).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await activeRows(page)).toEqual(['Finished chat', 'Running chat']);
  // A chat that finishes running offers the action again.
  await page.evaluate(() => {
    for (const run of Object.values((window as any).capabilityRuns) as any[]) {
      run.emit({ kind: 'text', text: 'Done' });
      run.finish('complete');
    }
  });
  await expect(archive(page, 'Running chat')).toHaveCount(1);
});

test('phones show the action on every Active row and keep the drawer open', async ({ page }) => {
  await start(page);
  await chats(page, 'Second chat', 'First chat');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations' });
  await expect(drawer).toBeVisible();
  for (const name of ['First chat', 'Second chat']) {
    await expect(archive(page, name)).toHaveCSS('opacity', '1');
    const [rowBox, buttonBox] = await Promise.all([
      page.getByRole('button', { name, exact: true }).boundingBox(),
      archive(page, name).boundingBox(),
    ]);
    expect(buttonBox!.width).toBeGreaterThanOrEqual(44);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    expect(buttonBox!.x + buttonBox!.width).toBeCloseTo(rowBox!.x + rowBox!.width, 0);
  }
  await page.screenshot({ path: 'artifacts/move-to-history-phone.png', animations: 'disabled' });
  await archive(page, 'First chat').click();
  await expect(drawer).toBeVisible();
  expect(await activeRows(page)).toEqual(['Second chat']);
  await expect(row(page, 'Second chat').locator('.conversation-item')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'Second chat', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close conversations', exact: true }).click();
  await expect(title(page)).toHaveText('Second chat');
});
