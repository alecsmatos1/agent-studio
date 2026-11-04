import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const stored = (page: Page, key: string) => page.evaluate((key) => localStorage.getItem(key), key);
const button = (page: Page) =>
  page.getByRole('button', { name: 'Shut down when chats finish', exact: true });

test('the power button waits for running chats, counts down once they finish, and Cancel keeps the computer on', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Refactor the parser overnight');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();

  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  await button(page).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page)).toHaveAttribute(
    'title',
    'Shut down when chats finish · Waiting for 1 chat',
  );
  expect(await stored(page, 'test-shutdown-armed')).toBe('true');
  // Nothing counts down while the reply runs.
  await page.waitForTimeout(2_500);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/shutdown-watch-waiting.png' });

  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  const countdown = page.getByRole('alertdialog', { name: /^Shutting down in \d:\d\d$/ });
  await expect(countdown).toBeVisible();
  await expect(countdown).toHaveAccessibleDescription(
    'All chats finished. Unsaved work in other apps will be lost.',
  );
  // A key pressed by chance keeps the computer on.
  await expect(countdown.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({ path: 'artifacts/shutdown-watch-countdown.png' });

  await countdown.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(button(page)).toHaveAttribute('title', 'Shut down when chats finish');
  expect(await stored(page, 'test-shutdown-armed')).toBe('false');
  expect(await stored(page, 'test-shutdowns')).toBeNull();
});

test('a reply that begins during the countdown ends it, and Shut down now turns the computer off', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  // With no chat running, the countdown begins at once.
  await button(page).click();
  const countdown = page.getByRole('alertdialog', { name: /^Shutting down in \d:\d\d$/ });
  await expect(countdown).toBeVisible();

  // A reply another device started here.
  await page.evaluate(() => localStorage.setItem('test-shutdown-running', '["phone-chat"]'));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page)).toHaveAttribute(
    'title',
    'Shut down when chats finish · Waiting for 1 chat',
  );
  await page.evaluate(() => localStorage.setItem('test-shutdown-running', '[]'));
  await expect(countdown).toBeVisible();

  await countdown.getByRole('button', { name: 'Shut down now' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Shutting down…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Shut down now' })).toBeDisabled();
  await expect.poll(() => stored(page, 'test-shutdowns')).toBe('1');
});

test('a watch left on goes on after the window reloads, and a refused shutdown says why', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('test-shutdown-running'))
      localStorage.setItem('test-shutdown-running', '["chat-one","chat-two"]');
  });
  await page.goto('/');
  await button(page).click();
  await expect(button(page)).toHaveAttribute(
    'title',
    'Shut down when chats finish · Waiting for 2 chats',
  );
  await page.reload();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page)).toHaveAttribute(
    'title',
    'Shut down when chats finish · Waiting for 2 chats',
  );

  await page.evaluate(() => {
    localStorage.setItem(
      'test-shutdown-error',
      'Windows did not shut down this computer (error 5).',
    );
    localStorage.setItem('test-shutdown-running', '[]');
  });
  const countdown = page.getByRole('alertdialog', { name: /^Shutting down in \d:\d\d$/ });
  await expect(countdown).toBeVisible();
  await countdown.getByRole('button', { name: 'Shut down now' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Windows did not shut down this computer' }),
  ).toHaveText('Windows did not shut down this computer (error 5).');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await stored(page, 'test-shutdown-armed')).toBe('false');
});

test('a server host has no power button', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => localStorage.setItem('test-server', 'true'));
  await page.goto('/');
  // A server reads its computer before it shows its window.
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
  await expect(button(page)).toHaveCount(0);
});
