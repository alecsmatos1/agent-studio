import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const title = (page: Page) => page.locator('.page-title');
const panel = (page: Page, name: 'active' | 'history' = 'active') =>
  page.locator(`#conversation-panel-${name}`);
// The rows listed under their folder, and the folder headings, in the order shown.
const folderRows = (page: Page, name: 'active' | 'history' = 'active') =>
  panel(page, name).locator('.conversation-folder .conversation-item');
const folders = (page: Page) => panel(page).locator('.folder-group-toggle > span');
const pinnedRows = (page: Page) =>
  panel(page).getByRole('region', { name: 'Pinned' }).locator('.conversation-item');
const row = (page: Page, chat: string) =>
  panel(page)
    .locator('.conversation-item')
    .filter({ has: page.getByText(chat, { exact: true }) });
const folder = (page: Page, name: string) =>
  panel(page)
    .locator('.folder-group-toggle')
    .filter({ has: page.getByText(name, { exact: true }) });
const loaded = (page: Page) => page.locator('.sidebar-modes button[aria-label="New conversation"]');
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
const places = async (page: Page, list: 'chats' | 'pinned' | 'folders' | 'computers') =>
  ((await saved(page)).sidebarOrder?.[list] ?? []) as { id: string; rank: string; at: string }[];

async function startApp(page: Page, startedAt = Date.now()) {
  await page.evaluate(
    (session) => localStorage.setItem('test-app-session', JSON.stringify(session)),
    { id: crypto.randomUUID(), startedAt },
  );
  await page.reload();
  await expect(loaded(page)).toBeEnabled();
}
async function start(page: Page, mode?: string) {
  await mockDesktop(page, mode);
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
async function standaloneChat(page: Page, name: string) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Standalone', exact: true }).click();
  await send(page, name);
}
// Presses `from` with the mouse and drags it until it sits above or below `to`, releasing it
// there; `pause` runs while it is still held.
async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  where: 'above' | 'below',
  pause?: () => Promise<void>,
) {
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  const x = start.x + Math.min(40, start.width / 2);
  await page.mouse.move(x, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, where === 'above' ? end.y + 2 : end.y + end.height - 2, { steps: 12 });
  await pause?.();
  await page.mouse.up();
}

test('chats and folders move by dragging and keep their places @webkit', async ({ page }) => {
  await start(page);
  await chats(page, 'First chat', 'Second chat', 'Third chat');
  await expect(folderRows(page)).toHaveText(['Third chat', 'Second chat', 'First chat']);
  // Dragged to the top, the last chat lands there without opening.
  await drag(page, row(page, 'First chat'), row(page, 'Third chat'), 'above', async () => {
    await expect(row(page, 'First chat').locator('xpath=..')).toHaveClass(/order-lifted/);
    await page.screenshot({ path: 'artifacts/reorder/dragging.png', animations: 'disabled' });
  });
  await expect(folderRows(page)).toHaveText(['First chat', 'Third chat', 'Second chat']);
  await expect(title(page)).toHaveText('Third chat');
  await expect(page.locator('.order-lifted, .order-moving')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/sidebar-reordering/);
  await expect.poll(async () => (await places(page, 'chats')).length).toBe(3);
  // A chat that replies again keeps its place, and a new one comes first in its folder.
  await row(page, 'Second chat').click();
  await send(page, 'Still here');
  await expect(folderRows(page)).toHaveText(['First chat', 'Third chat', 'Second chat']);
  await chats(page, 'Fourth chat');
  await expect(folderRows(page)).toHaveText([
    'Fourth chat',
    'First chat',
    'Third chat',
    'Second chat',
  ]);
  // Dragged down past two chats, a chat lands below them.
  await drag(page, row(page, 'First chat'), row(page, 'Second chat'), 'below');
  await expect(folderRows(page)).toHaveText([
    'Fourth chat',
    'Third chat',
    'Second chat',
    'First chat',
  ]);
  // A press that does not move still opens the chat.
  await row(page, 'Third chat').click();
  await expect(title(page)).toHaveText('Third chat');
  // A folder moves with its chats, and the drag leaves it open.
  await standaloneChat(page, 'Loose chat');
  await expect(folders(page)).toHaveText(['Standalone', 'studio']);
  await drag(page, folder(page, 'studio'), folder(page, 'Standalone'), 'above');
  await expect(folders(page)).toHaveText(['studio', 'Standalone']);
  await expect(folder(page, 'studio')).toHaveAttribute('aria-expanded', 'true');
  await expect(folderRows(page)).toHaveText([
    'Fourth chat',
    'Third chat',
    'Second chat',
    'First chat',
    'Loose chat',
  ]);
  await expect.poll(async () => (await places(page, 'folders')).length).toBe(2);
  // Escape puts a dragged chat back, and the release that follows opens nothing.
  await drag(page, row(page, 'Fourth chat'), row(page, 'First chat'), 'below', () =>
    page.keyboard.press('Escape'),
  );
  await expect(folderRows(page).first()).toHaveText('Fourth chat');
  await expect(title(page)).toHaveText('Loose chat');
  // Every place stays after the app starts again, with the chats in History.
  await startApp(page);
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(folderRows(page, 'history')).toHaveText([
    'Fourth chat',
    'Third chat',
    'Second chat',
    'First chat',
    'Loose chat',
  ]);
  await expect(
    panel(page, 'history').locator('.folder-group-toggle > span:not(.folder-computer)'),
  ).toHaveText(['studio', 'Standalone']);
});

test('the keyboard moves chats and folders with Alt and an arrow', async ({ page }) => {
  await start(page);
  await chats(page, 'First chat', 'Second chat', 'Third chat');
  await row(page, 'Third chat').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(folderRows(page)).toHaveText(['Second chat', 'Third chat', 'First chat']);
  // Focus follows the chat to its place.
  await expect(row(page, 'Third chat')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(folderRows(page)).toHaveText(['Second chat', 'First chat', 'Third chat']);
  await expect(row(page, 'Third chat')).toBeFocused();
  // At the end of its list it stays.
  await page.keyboard.press('Alt+ArrowDown');
  await expect(folderRows(page)).toHaveText(['Second chat', 'First chat', 'Third chat']);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(folderRows(page)).toHaveText(['Second chat', 'Third chat', 'First chat']);
  await expect(row(page, 'Third chat')).toHaveAttribute(
    'aria-keyshortcuts',
    'Alt+ArrowUp Alt+ArrowDown',
  );
  // A folder heading moves its folder.
  await standaloneChat(page, 'Loose chat');
  await expect(folders(page)).toHaveText(['Standalone', 'studio']);
  await folder(page, 'Standalone').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(folders(page)).toHaveText(['studio', 'Standalone']);
  await expect(folder(page, 'Standalone')).toBeFocused();
  await expect(folder(page, 'Standalone')).toHaveAttribute('aria-expanded', 'true');
  // Nothing moves while searching, which shows only part of each list.
  await page.getByLabel('Search conversations').fill('chat');
  await row(page, 'First chat').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await drag(page, row(page, 'First chat'), row(page, 'Second chat'), 'above');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(folderRows(page)).toHaveText([
    'Second chat',
    'Third chat',
    'First chat',
    'Loose chat',
  ]);
});

test('pinned chats keep the order they are given, and a chat pinned anew leads them', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'First chat', 'Second chat', 'Third chat');
  for (const chat of ['First chat', 'Second chat', 'Third chat']) {
    await row(page, chat).click({ button: 'right' });
    await page
      .getByRole('menu', { name: `Actions for ${chat}` })
      .getByRole('menuitem', { name: 'Pin' })
      .click();
  }
  await expect(pinnedRows(page)).toHaveText(['Third chat', 'Second chat', 'First chat']);
  await drag(page, row(page, 'Third chat'), row(page, 'First chat'), 'below');
  await expect(pinnedRows(page)).toHaveText(['Second chat', 'First chat', 'Third chat']);
  await expect.poll(async () => (await places(page, 'pinned')).length).toBe(3);
  // Unpinned and pinned again, a chat leads the pinned chats once more.
  for (const item of ['Unpin', 'Pin']) {
    await row(page, 'Third chat').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Actions for Third chat' })
      .getByRole('menuitem', { name: item })
      .click();
  }
  await expect(pinnedRows(page)).toHaveText(['Third chat', 'Second chat', 'First chat']);
  // A deleted chat leaves no place behind.
  await row(page, 'First chat').click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for First chat' })
    .getByRole('menuitem', { name: 'Delete conversation' })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(pinnedRows(page)).toHaveText(['Third chat', 'Second chat']);
  const first = (await places(page, 'pinned')).map((p) => p.id);
  const ids = (await saved(page)).conversations.map((c: { id: string }) => c.id);
  expect(first.every((id) => ids.includes(id))).toBe(true);
});

test('on a touch screen, menus move chats and folders one place', async ({ page }) => {
  await start(page);
  await chats(page, 'First chat', 'Second chat');
  await standaloneChat(page, 'Loose chat');
  // Narrowed to a phone, the drawer lists them; touches open menus instead of dragging.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations' }).click();
  const hold = async (target: Locator) => {
    const bounds = (await target.boundingBox())!;
    const pointer = {
      pointerId: 1,
      pointerType: 'touch',
      clientX: bounds.x + 20,
      clientY: bounds.y + bounds.height / 2,
      bubbles: true,
    };
    await target.dispatchEvent('pointerdown', pointer);
    return async () => {
      await target.dispatchEvent('pointerup', pointer);
      await target.dispatchEvent('click');
    };
  };
  // A chat's menu adds Move up and Move down where it can move.
  let release = await hold(row(page, 'Second chat'));
  const menu = page.getByRole('menu', { name: 'Actions for Second chat' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Fork conversation',
    'Snooze',
    'Pin',
    'Move down',
    'Delete conversation',
  ]);
  await release();
  await menu.getByRole('menuitem', { name: 'Move down' }).click();
  await expect(menu).toHaveCount(0);
  await expect(folderRows(page)).toHaveText(['Loose chat', 'First chat', 'Second chat']);
  await page.screenshot({ path: 'artifacts/reorder/phone.png', animations: 'disabled' });
  // A folder's heading, held, opens a menu that moves the folder and leaves it open.
  release = await hold(folder(page, 'Standalone'));
  const folderMenu = page.getByRole('menu', { name: 'Actions for Standalone' });
  await expect(folderMenu.getByRole('menuitem')).toHaveText(['Move down']);
  await release();
  await expect(folder(page, 'Standalone')).toHaveAttribute('aria-expanded', 'true');
  await folderMenu.getByRole('menuitem', { name: 'Move down' }).click();
  await expect(folders(page)).toHaveText(['studio', 'Standalone']);
  // A chat alone in its folder has nowhere to go.
  release = await hold(row(page, 'Loose chat'));
  await expect(
    page.getByRole('menu', { name: 'Actions for Loose chat' }).getByRole('menuitem'),
  ).toHaveText(['Fork conversation', 'Snooze', 'Pin', 'Delete conversation']);
  await release();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('computers move by their headings', async ({ page }) => {
  await mockDesktop(page, 'computer-routing');
  await page.goto('/');
  await expect(loaded(page)).toBeEnabled();
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await send(page, 'Desktop chat');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await picker('Computer').click();
  await page.getByRole('option', { name: 'WSL · Ubuntu', exact: true }).click();
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await send(page, 'Ubuntu chat');
  const computers = panel(page).locator('.computer-group-toggle > span');
  await expect(computers).toHaveText(['WSL · Ubuntu', 'Desktop']);
  const heading = (name: string) =>
    panel(page)
      .locator('.computer-group-toggle')
      .filter({ has: page.getByText(name, { exact: true }) });
  await drag(page, heading('Desktop'), heading('WSL · Ubuntu'), 'above');
  await expect(computers).toHaveText(['Desktop', 'WSL · Ubuntu']);
  await expect(heading('Desktop')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await places(page, 'computers')).length).toBe(2);
  // A reply on the other computer leaves the order as placed.
  await row(page, 'Ubuntu chat').click();
  await send(page, 'Again');
  await expect(computers).toHaveText(['Desktop', 'WSL · Ubuntu']);
  await heading('Desktop').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(computers).toHaveText(['WSL · Ubuntu', 'Desktop']);
  await expect(heading('Desktop')).toBeFocused();
});
