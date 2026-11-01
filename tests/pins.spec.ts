import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const title = (page: Page) => page.locator('.page-title');
const pinButton = (page: Page) =>
  page.locator('.chat-toolbar').getByRole('button', { name: 'Pin', exact: true });
const tab = (page: Page, name: 'Active' | 'History') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) });
const panel = (page: Page, name: 'active' | 'history') =>
  page.locator(`#conversation-panel-${name}`);
const pinned = (page: Page, name: 'active' | 'history') =>
  panel(page, name).getByRole('region', { name: 'Pinned' });
const pinnedRows = (page: Page, name: 'active' | 'history') =>
  pinned(page, name).locator('.conversation-item');
// The rows listed under their computer or session and folder.
const folderRows = (page: Page, name: 'active' | 'history') =>
  panel(page, name).locator('.conversation-folder .conversation-item');
const row = (page: Page, name: 'active' | 'history', chat: string) =>
  panel(page, name)
    .locator('.conversation-item')
    .filter({ has: page.getByText(chat, { exact: true }) });
// The sidebar's New conversation, enabled once the workspace loaded, also in a closed drawer.
const loaded = (page: Page) => page.locator('.sidebar-modes button[aria-label="New conversation"]');
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
const pins = async (page: Page) =>
  ((await saved(page)).pins ?? []) as { conversationId: string; at: string }[];
const chatId = async (page: Page, name: string) =>
  (await saved(page)).conversations.find((c: { title: string }) => c.title === name).id as string;

// Starts the app again as a new process that began at `startedAt`.
async function startApp(page: Page, startedAt = Date.now()) {
  await page.evaluate(
    (session) => localStorage.setItem('test-app-session', JSON.stringify(session)),
    { id: crypto.randomUUID(), startedAt },
  );
  await page.reload();
  await expect(loaded(page)).toBeEnabled();
}
async function start(page: Page) {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await startApp(page, Date.now() - 3_600_000);
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

test('a pinned chat leads the tab it is in, Active or History', async ({ page }) => {
  await start(page);
  await chats(page, 'First chat', 'Second chat', 'Third chat');
  await expect(pinned(page, 'active')).toHaveCount(0);
  // Pinned from its row's menu, a chat leaves its folder for the top of the Active tab.
  await row(page, 'active', 'First chat').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for First chat' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Fork conversation',
    'Snooze',
    'Pin',
    'Delete conversation',
  ]);
  await menu.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(menu).toHaveCount(0);
  await expect(title(page)).toHaveText('Third chat');
  await expect(pinnedRows(page, 'active')).toHaveText(['First chat']);
  await expect(folderRows(page, 'active')).toHaveText(['Third chat', 'Second chat']);
  await expect(panel(page, 'active').locator(':scope > :first-child')).toHaveClass(/pinned-chats/);
  // Its row keeps its folder's icon in the gutter and counts in the Active tab as before.
  await expect(pinnedRows(page, 'active').locator(':scope > svg:first-child')).toHaveCount(1);
  await expect(tab(page, 'Active')).toContainText('3');
  const first = await chatId(page, 'First chat');
  await expect.poll(() => pins(page)).toEqual([{ conversationId: first, at: expect.any(String) }]);
  // The toolbar pins the open chat, which leads the pinned chats as the latest pinned.
  await row(page, 'active', 'Second chat').click();
  await expect(pinButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pinButton(page)).toHaveAttribute('title', 'Pin');
  await pinButton(page).click();
  await expect(pinButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(pinButton(page)).toHaveAttribute('title', 'Unpin');
  await expect(pinnedRows(page, 'active')).toHaveText(['Second chat', 'First chat']);
  await expect(row(page, 'active', 'Second chat')).toHaveAttribute('aria-current', 'page');
  await expect(folderRows(page, 'active')).toHaveText(['Third chat']);
  await page.screenshot({ path: 'artifacts/pins/active.png', animations: 'disabled' });
  // Search keeps the pinned chats it matches.
  await page.getByLabel('Search conversations').fill('first');
  await expect(pinnedRows(page, 'active')).toHaveText(['First chat']);
  await expect(folderRows(page, 'active')).toHaveCount(0);
  await page.getByLabel('Search conversations').fill('third');
  await expect(pinned(page, 'active')).toHaveCount(0);
  await expect(folderRows(page, 'active')).toHaveText(['Third chat']);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  // Moved to History, a pinned chat stays pinned there, and the next chat of its folder opens:
  // its folder's pinned chats first.
  await page
    .locator('.chat-toolbar')
    .getByRole('button', { name: 'Move to history', exact: true })
    .click();
  await expect(title(page)).toHaveText('First chat');
  await expect(pinnedRows(page, 'active')).toHaveText(['First chat']);
  await tab(page, 'History').click();
  await expect(pinnedRows(page, 'history')).toHaveText(['Second chat']);
  await expect(folderRows(page, 'history')).toHaveCount(0);
  await expect(panel(page, 'history').locator('.sidebar-empty-state')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/pins/history.png', animations: 'disabled' });
  // Unpinned, it returns to its place in History.
  await row(page, 'history', 'Second chat').click({ button: 'right' });
  const historyMenu = page.getByRole('menu', { name: 'Actions for Second chat' });
  await historyMenu.getByRole('menuitem', { name: 'Unpin' }).click();
  await expect(pinned(page, 'history')).toHaveCount(0);
  await expect(folderRows(page, 'history')).toHaveText(['Second chat']);
  await expect.poll(() => pins(page)).toEqual([{ conversationId: first, at: expect.any(String) }]);
  // The next start of the app moves every chat to History, pinned ones to its pinned chats.
  await startApp(page);
  await tab(page, 'Active').click();
  await expect(pinned(page, 'active')).toHaveCount(0);
  await expect(panel(page, 'active').locator('.sidebar-empty-state')).toHaveText(
    'No active conversations',
  );
  await tab(page, 'History').click();
  await expect(pinnedRows(page, 'history')).toHaveText(['First chat']);
  // Second chat moved to History last, so it is the more recent.
  await expect(folderRows(page, 'history')).toHaveText(['Second chat', 'Third chat']);
  // Sending brings it back to Active, still pinned.
  await row(page, 'history', 'First chat').click();
  await expect(pinButton(page)).toHaveAttribute('aria-pressed', 'true');
  await send(page, 'Back to work');
  await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
  await expect(pinnedRows(page, 'active')).toHaveText(['First chat']);
  await expect(row(page, 'active', 'First chat')).toHaveAttribute('aria-current', 'page');
});

test('keyboard focus follows a row pinned or unpinned from its menu, and Delete drops the pin', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'Delete me', 'Keep me');
  const keep = row(page, 'active', 'Keep me');
  await keep.focus();
  await keep.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Actions for Keep me' });
  await expect(menu.getByRole('menuitem', { name: 'Fork conversation' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(pinnedRows(page, 'active')).toHaveText(['Keep me']);
  await expect(pinnedRows(page, 'active')).toBeFocused();
  // Unpinned the same way, the row returns to its folder with focus.
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Unpin' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pinned(page, 'active')).toHaveCount(0);
  await expect(folderRows(page, 'active').first()).toHaveText('Keep me');
  await expect(folderRows(page, 'active').first()).toBeFocused();
  // Deleting a pinned chat takes its pin along.
  await row(page, 'active', 'Delete me').click();
  await pinButton(page).click();
  const deleted = await chatId(page, 'Delete me');
  await expect.poll(async () => (await pins(page)).map((p) => p.conversationId)).toEqual([deleted]);
  await row(page, 'active', 'Delete me').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(row(page, 'active', 'Delete me')).toHaveCount(0);
  await expect(pinned(page, 'active')).toHaveCount(0);
  await expect.poll(() => pins(page)).toEqual([]);
});

test('pinned chats fit the phone drawer @webkit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await startApp(page, Date.now() - 3_600_000);
  await send(page, 'Phone pin with a title long enough to need shortening in the drawer');
  await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect.poll(async () => (await pins(page)).length).toBe(1);
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect(pinnedRows(page, 'active')).toHaveText([/^Phone pin/]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/pins/phone.png', animations: 'disabled' });
});
