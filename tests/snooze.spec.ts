import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const title = (page: Page) => page.locator('.page-title');
const snoozeButton = (page: Page) =>
  page.locator('.chat-toolbar').getByRole('button', { name: 'Snooze', exact: true });
const snoozed = (page: Page) => page.getByRole('region', { name: 'Snoozed' });
const card = (page: Page, name: string) => snoozed(page).getByRole('group', { name });
const tab = (page: Page, name: 'Active' | 'History') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) });
const rows = (page: Page, panel: 'active' | 'history') =>
  page.locator(`#conversation-panel-${panel} .conversation-item`);
const row = (page: Page, panel: 'active' | 'history', name: string) =>
  rows(page, panel).filter({ has: page.getByText(name, { exact: true }) });
// The sidebar's New conversation, enabled once the workspace loaded, also in a closed drawer.
const loaded = (page: Page) =>
  page.locator('.sidebar-modes button[aria-label="New conversation"]');
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));

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
  // The app started an hour ago, before anything was snoozed.
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
const snoozes = async (page: Page) =>
  ((await saved(page)).snoozes ?? []) as {
    conversationId: string;
    lastMessageId?: string;
    at: string;
  }[];
const chatId = async (page: Page, name: string) =>
  (await saved(page)).conversations.find((c: { title: string }) => c.title === name).id as string;

test('a snoozed chat waits in History until the app starts again, then atop Active', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'Keep working', 'Plan the release');
  await expect(snoozeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(snoozeButton(page)).toHaveAttribute('title', 'Snooze until the app restarts');
  // Snoozing moves the chat to History as Move to history does, and the next chat opens.
  await snoozeButton(page).click();
  await expect(title(page)).toHaveText('Keep working');
  await expect(input(page)).toBeFocused();
  await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page, 'active')).toHaveText(['Keep working']);
  await expect(row(page, 'history', 'Plan the release')).toHaveAttribute(
    'title',
    'Plan the release · Snoozed',
  );
  await expect(
    row(page, 'history', 'Plan the release').locator('.conversation-snoozed'),
  ).toHaveCount(1);
  const id = await chatId(page, 'Plan the release');
  await expect
    .poll(() => snoozes(page))
    .toEqual([{ conversationId: id, lastMessageId: expect.any(String), at: expect.any(String) }]);
  const conversation = (await saved(page)).conversations.find((c: { id: string }) => c.id === id);
  expect(conversation.archived).toBe(true);
  expect((await snoozes(page))[0].lastMessageId).toBe(conversation.messages.at(-1).id);
  // Nothing waits on top in this session, a reload included.
  await expect(snoozed(page)).toHaveCount(0);
  await page.reload();
  await expect(loaded(page)).toBeEnabled();
  await expect(snoozed(page)).toHaveCount(0);
  // The next start of the app shows it at the top of the Active tab, with its three choices.
  await startApp(page);
  await expect(snoozed(page)).toBeVisible();
  await expect(card(page, 'Plan the release')).toBeVisible();
  // Icon buttons on the title's line, named for assistive technology and on hover.
  const choices = card(page, 'Plan the release').getByRole('button');
  await expect(choices).toHaveText(['', '', '']);
  expect(
    await choices.evaluateAll((buttons) =>
      buttons.map((b) => [b.getAttribute('aria-label'), b.getAttribute('title')]),
    ),
  ).toEqual([
    ['Open', 'Open'],
    ['Snooze again', 'Snooze again'],
    ['Close', 'Close'],
  ]);
  const line = await card(page, 'Plan the release').evaluate((item) =>
    [item.querySelector('.snoozed-title')!, ...item.querySelectorAll('button')].map((part) =>
      Math.round(part.getBoundingClientRect().top + part.getBoundingClientRect().height / 2),
    ),
  );
  expect(Math.max(...line) - Math.min(...line)).toBeLessThanOrEqual(1);
  const panel = page.locator('#conversation-panel-active');
  await expect(panel.locator(':scope > :first-child')).toHaveClass(/snoozed-chats/);
  await expect(panel.locator('.sidebar-empty-state')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/snooze/due.png', animations: 'disabled' });
  // History and Screens do not show it; search keeps it only while it matches.
  await tab(page, 'History').click();
  await expect(snoozed(page)).toBeHidden();
  await tab(page, 'Active').click();
  await expect(snoozed(page)).toBeVisible();
  await page.getByLabel('Search conversations').fill('working');
  await expect(snoozed(page)).toHaveCount(0);
  await expect(panel.locator('.sidebar-empty-state')).toHaveText('No matches');
  await page.getByLabel('Search conversations').fill('release');
  await expect(card(page, 'Plan the release')).toBeVisible();
  await expect(panel.locator('.sidebar-empty-state')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  // Snooze again: gone until the next start, and still snoozed in History.
  await card(page, 'Plan the release').getByRole('button', { name: 'Snooze again' }).click();
  await expect(snoozed(page)).toHaveCount(0);
  await tab(page, 'History').click();
  await expect(row(page, 'history', 'Plan the release')).toHaveAttribute(
    'title',
    'Plan the release · Snoozed',
  );
  await expect
    .poll(async () => Date.parse((await snoozes(page))[0]?.at ?? '0'))
    .toBeGreaterThan(Date.now() - 60_000);
  await page.reload();
  await expect(loaded(page)).toBeEnabled();
  await expect(snoozed(page)).toHaveCount(0);
  await startApp(page);
  await expect(card(page, 'Plan the release')).toBeVisible();
  // Close: the chat stays in History, no longer snoozed, and nothing waits on top.
  await card(page, 'Plan the release').getByRole('button', { name: 'Close' }).click();
  await expect(snoozed(page)).toHaveCount(0);
  await tab(page, 'History').click();
  await expect(row(page, 'history', 'Plan the release')).toHaveAttribute(
    'title',
    'Plan the release',
  );
  await expect(
    row(page, 'history', 'Plan the release').locator('.conversation-snoozed'),
  ).toHaveCount(0);
  await expect.poll(() => snoozes(page)).toEqual([]);
  await startApp(page);
  await expect(snoozed(page)).toHaveCount(0);
});

test('Open shows the chat in History, and a message brings it back to Active', async ({ page }) => {
  await start(page);
  await chats(page, 'Release notes', 'Open draft');
  // Snoozed from its row's menu, the chat leaves Active while the open chat stays.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await input(page).fill('Unsent idea');
  await row(page, 'active', 'Release notes').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for Release notes' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Fork conversation',
    'Snooze',
    'Pin',
    'Delete conversation',
  ]);
  await expect(menu.getByRole('menuitem', { name: 'Snooze' })).toHaveAttribute(
    'title',
    'Until the app restarts',
  );
  await menu.getByRole('menuitem', { name: 'Snooze' }).click();
  await expect(menu).toHaveCount(0);
  await expect(title(page)).toHaveText('New conversation');
  await expect(input(page)).toHaveValue('Unsent idea');
  await expect(rows(page, 'active')).toHaveText(['Open draft']);
  await expect.poll(async () => (await snoozes(page)).length).toBe(1);
  await startApp(page);
  // A new start moves every chat to History; only the snoozed one waits on top.
  await expect(snoozed(page).getByRole('group')).toHaveCount(1);
  await card(page, 'Release notes').getByRole('button', { name: 'Open' }).click();
  await expect(title(page)).toHaveText('Release notes');
  await expect(snoozed(page)).toHaveCount(0);
  await expect(tab(page, 'History')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'history', 'Release notes')).toHaveAttribute('aria-current', 'page');
  await expect(row(page, 'history', 'Release notes')).toHaveAttribute('title', 'Release notes');
  await expect(input(page)).toBeFocused();
  await expect.poll(() => snoozes(page)).toEqual([]);
  // The toolbar offers to snooze a History chat in place, and to cancel it again.
  await snoozeButton(page).click();
  await expect(snoozeButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(snoozeButton(page)).toHaveAttribute('title', 'Cancel snooze');
  await expect(title(page)).toHaveText('Release notes');
  await expect(row(page, 'history', 'Release notes')).toHaveAttribute(
    'title',
    'Release notes · Snoozed',
  );
  await snoozeButton(page).click();
  await expect(snoozeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'history', 'Release notes')).toHaveAttribute('title', 'Release notes');
  // Sending brings the chat back to Active, as for any History chat.
  await send(page, 'Picking this up again');
  await expect(tab(page, 'Active')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'active', 'Release notes')).toHaveAttribute('aria-current', 'page');
});

test('a chat used again is no longer snoozed, and Cancel snooze and Delete end it', async ({
  page,
}) => {
  await start(page);
  await chats(page, 'Delete me', 'Cancel me', 'Continue me');
  // Snoozed, then continued in the same session: sending ends the snooze by itself.
  await snoozeButton(page).click();
  await tab(page, 'History').click();
  await row(page, 'history', 'Continue me').click();
  await expect(snoozeButton(page)).toHaveAttribute('aria-pressed', 'true');
  await send(page, 'One more thing');
  await expect(snoozeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 'active', 'Continue me')).toHaveAttribute('title', 'Continue me');
  // Cancel snooze from the menu of a History row keeps its place and focus.
  await row(page, 'active', 'Cancel me').click();
  await snoozeButton(page).click();
  await tab(page, 'History').click();
  const cancel = row(page, 'history', 'Cancel me');
  await cancel.focus();
  await cancel.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Actions for Cancel me' });
  await menu.getByRole('menuitem', { name: 'Cancel snooze' }).click();
  await expect(menu).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await expect(cancel).toHaveAttribute('title', 'Cancel me');
  // Deleting a snoozed chat takes its snooze along.
  await tab(page, 'Active').click();
  await row(page, 'active', 'Delete me').click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for Delete me' })
    .getByRole('menuitem', { name: 'Snooze' })
    .click();
  const deleted = await chatId(page, 'Delete me');
  await expect
    .poll(async () => (await snoozes(page)).map((s) => s.conversationId))
    .toEqual([deleted]);
  await tab(page, 'History').click();
  await row(page, 'history', 'Delete me').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(row(page, 'history', 'Delete me')).toHaveCount(0);
  await expect.poll(() => snoozes(page)).toEqual([]);
  // After the next start, nothing that was used, cancelled or deleted waits on top.
  await startApp(page);
  await expect(snoozed(page)).toHaveCount(0);
  await tab(page, 'History').click();
  await expect(rows(page, 'history').locator('.conversation-snoozed')).toHaveCount(0);
});

test('several due chats keep keyboard focus in the list as each is handled', async ({ page }) => {
  await start(page);
  await chats(page, 'First snoozed', 'Second snoozed', 'Third snoozed');
  // Each snooze opens the chat listed below, so they are snoozed a moment apart.
  for (const next of ['Second snoozed', 'First snoozed', 'New conversation']) {
    await snoozeButton(page).click();
    await expect(title(page)).toHaveText(next);
  }
  await expect.poll(async () => (await snoozes(page)).length).toBe(3);
  await startApp(page);
  // The most recently snoozed first.
  await expect(snoozed(page).getByRole('group')).toHaveText([
    /First snoozed/,
    /Second snoozed/,
    /Third snoozed/,
  ]);
  const close = card(page, 'First snoozed').getByRole('button', { name: 'Close' });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Second snoozed').getByRole('button', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(card(page, 'Third snoozed').getByRole('button', { name: 'Open' })).toBeFocused();
  await card(page, 'Third snoozed').getByRole('button', { name: 'Close' }).focus();
  await page.keyboard.press('Enter');
  await expect(snoozed(page)).toHaveCount(0);
  await expect(tab(page, 'Active')).toBeFocused();
  // Second was snoozed again and waits for the next start.
  await startApp(page);
  await expect(snoozed(page).getByRole('group')).toHaveText([/Second snoozed/]);
});

test('the snoozed list fits the phone drawer with touch-sized choices @webkit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await startApp(page, Date.now() - 3_600_000);
  await send(page, 'Phone snooze with a title long enough to need shortening in the drawer');
  await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect.poll(async () => (await snoozes(page)).length).toBe(1);
  await startApp(page);
  await page.getByRole('button', { name: 'Open conversations' }).click();
  const item = snoozed(page).getByRole('group');
  await expect(item).toBeVisible();
  for (const button of await item.getByRole('button').all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/snooze/phone.png', animations: 'disabled' });
  await item.getByRole('button', { name: 'Open' }).click();
  await expect(title(page)).toHaveText(/^Phone snooze/);
  await expect(snoozed(page)).toHaveCount(0);
});
