import { test, expect, type Page } from '@playwright/test';
import { chooseTestFolder } from './folder-helper';
import { expectVisibleQuotaComparison } from './quota-helper';
import { mockDesktop } from './desktop-helper';
import { chooseReasoning, reasoningLevels } from './reasoning-helper';
import { createHash } from 'node:crypto';

async function imageFixture(page: Page, name = 'diagram.png') {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 220;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f4eee2';
    ctx.fillRect(0, 0, 360, 220);
    ctx.fillStyle = '#267fcb';
    ctx.beginPath();
    ctx.moveTo(180, 30);
    ctx.lineTo(80, 180);
    ctx.lineTo(280, 180);
    ctx.closePath();
    ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

test('a draft edited while its images are kept waits for the next send', async ({ page }) => {
  await mockDesktop(page, 'error');
  // The image store answers only once the test lets it.
  await page.addInitScript(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'store_chat_image' && !w.imagesReleased)
        await new Promise<void>((resolve) => {
          w.releaseImages = () => {
            w.imagesReleased = true;
            resolve();
          };
        });
      return original(command, args);
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Image files').setInputFiles(await imageFixture(page));
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Describe this');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Saving images…')).toBeVisible();
  await input.fill('Describe this diagram');
  await page.evaluate(() => (window as any).releaseImages());
  await expect(page.getByText('Saving images…')).toHaveCount(0);
  // Nothing went out, and the edited draft keeps its image.
  await expect(page.locator('.message')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBeNull();
  await expect(input).toHaveValue('Describe this diagram');
  await expect(page.getByRole('button', { name: 'Remove diagram.png' })).toBeVisible();
  // Sent again, it goes out as edited.
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages[0].text).toBe('Describe this diagram');
  expect(request.messages[0].images).toHaveLength(1);
});

test('an image preview closes on a click on its backdrop, never on its own frame @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'error');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Image files').setInputFiles(await imageFixture(page));
  const thumbnail = page.getByRole('button', { name: 'Preview diagram.png' });
  // Opened from the keyboard, since WebKit never focuses a clicked button.
  await thumbnail.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Image preview' });
  await expect(preview.getByRole('img')).toBeVisible();
  const box = (await preview.boundingBox())!;
  expect(box.x).toBeGreaterThan(8);

  // The padding around the image belongs to the preview, and selecting its name past its edge
  // keeps it open.
  await page.mouse.click(box.x + 6, box.y + box.height / 2);
  const name = (await preview.getByText('diagram.png').boundingBox())!;
  await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x / 2, name.y + name.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(preview).toBeVisible();
  await page.mouse.click(box.x / 2, box.y + box.height / 2);
  await expect(preview).toBeHidden();
  await expect(thumbnail).toBeFocused();
  await expect(page.getByRole('button', { name: 'Remove diagram.png' })).toBeVisible();
});

test('images can be previewed, sent without text, reopened and retried with the original bytes', async ({
  page,
}) => {
  await mockDesktop(page, 'error');
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.getByLabel('Image files').setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Remove diagram.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview diagram.png' }).click();
  await expect(page.getByRole('dialog', { name: 'Image preview' }).getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages[0].text).toBe('');
  // The message names its image by hash; the bytes stay once in this computer's image store.
  const hash = createHash('sha256').update(file.buffer).digest('hex');
  expect(request.messages[0].images[0]).toEqual({
    id: expect.any(String),
    name: 'diagram.png',
    mediaType: 'image/png',
    hash,
    bytes: file.buffer.length,
  });
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('test-images')!));
  expect(kept[hash].data).toBe(file.buffer.toString('base64'));
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace')!);
  expect(saved).toContain(hash);
  expect(saved).not.toContain(file.buffer.toString('base64').slice(0, 40));
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).messages),
  ).toEqual(request.messages);
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(
    page.locator('.message.user').getByRole('img', { name: 'diagram.png' }),
  ).toBeVisible();
});

test('pasting and dropping images preserves drafts and supports removal at compact widths', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.getByLabel('Message', { exact: true }).fill('Please explain this diagram.');
  expect(
    await page.evaluate(() => {
      const text = new DataTransfer();
      text.setData('text/plain', 'Ordinary text');
      return document.querySelector('textarea')!.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: text,
          bubbles: true,
          cancelable: true,
        }),
      );
    }),
  ).toBe(true);
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'pasted.png', {
        type: 'image/png',
      }),
    );
    document
      .querySelector('textarea')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Remove pasted.png' })).toBeVisible();
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'dropped.png', {
        type: 'image/png',
      }),
    );
    document
      .querySelector('.composer')!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Remove dropped.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Please explain this diagram.',
  );
  await expect(page.getByRole('button', { name: 'Remove pasted.png' })).toBeVisible();
  // Thumbnails show no file names; the name stays in the hover title and alt text.
  await expect(page.locator('.composer').getByText('pasted.png')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview pasted.png' })).toHaveAttribute(
    'title',
    'pasted.png',
  );
  await page.setViewportSize({ width: 840, height: 640 });
  await page.screenshot({ path: 'artifacts/images-composer-compact.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Remove pasted.png' }).click();
  await expect(page.getByRole('button', { name: 'Preview pasted.png' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message[data-status="complete"]')).toHaveCount(2);
  // Sent images sit above the message bubble, which holds only the text.
  const sent = page.locator('.message.user');
  const bubble = sent.locator('.user-text');
  const transparent = 'rgba(0, 0, 0, 0)';
  await expect(bubble).toHaveText('Please explain this diagram.');
  await expect(bubble).not.toHaveCSS('background-color', transparent);
  await expect(sent.locator('.message-content')).toHaveCSS('background-color', transparent);
  const sentImage = await sent.getByRole('img', { name: 'dropped.png' }).boundingBox();
  const bubbleBox = await bubble.boundingBox();
  expect(sentImage!.y + sentImage!.height).toBeLessThanOrEqual(bubbleBox!.y);
  await expect(sent.getByText('dropped.png')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('And what shape is it?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages[0].images.map((image: any) => image.name)).toEqual(['dropped.png']);
  expect(request.messages.at(-1).text).toBe('And what shape is it?');
});

test('invalid images stay out of the draft, any number attach, and Gemini attachment input is explicit', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  for (const [file, error] of [
    [{ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }, 'Choose a PNG'],
    [
      { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
      'not a valid image',
    ],
  ] as const) {
    await page.getByLabel('Image files').setInputFiles(file);
    await expect(page.getByRole('alert').filter({ hasText: error })).toBeVisible();
  }
  const file = await imageFixture(page);
  await page
    .getByLabel('Image files')
    .setInputFiles(Array.from({ length: 20 }, (_, n) => ({ ...file, name: `${n}.png` })));
  await expect(page.getByRole('button', { name: /^Remove .*\.png$/ })).toHaveCount(20);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /^Gemini/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Attach images' })).toHaveAttribute(
    'title',
    'Images need Codex or Claude',
  );
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
});

test('the whole chat accepts file drops with a hint and ignores drops outside chat', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  const transfer = await page.evaluateHandle((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'chat-drop.png', {
        type: 'image/png',
      }),
    );
    return transfer;
  }, file.buffer.toString('base64'));
  const welcome = page.locator('.chat-empty');
  await welcome.dispatchEvent('dragenter', { dataTransfer: transfer });
  await welcome.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(page.getByRole('status').filter({ hasText: 'Drop images to attach' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/images-chat-drop-hint.png' });
  await welcome.locator('h1').dispatchEvent('dragenter', { dataTransfer: transfer });
  await welcome.dispatchEvent('dragleave', { dataTransfer: transfer });
  await expect(page.locator('.image-drop-overlay')).toBeVisible();
  await welcome.locator('h1').dispatchEvent('dragleave', { dataTransfer: transfer });
  await expect(page.locator('.image-drop-overlay')).toHaveCount(0);
  await welcome.dispatchEvent('dragenter', { dataTransfer: transfer });
  await welcome.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByRole('button', { name: 'Remove chat-drop.png' })).toBeVisible();
  await expect(page.locator('.composer .image-thumbnail')).toHaveCount(1);
  await expect(page.locator('.image-drop-overlay')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove chat-drop.png' }).click();
  await welcome.dispatchEvent('dragenter', { dataTransfer: transfer });
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-drop-overlay')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /^Gemini/ })
    .first()
    .click();
  await welcome.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(
    page.getByRole('status').filter({ hasText: 'Images need Codex or Claude' }),
  ).toBeVisible();
  await welcome.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('.image-drop-overlay')).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Images need Codex or Claude' }),
  ).toBeVisible();
  await expect(page.locator('.composer .image-thumbnail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  expect(
    await page.evaluate((data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'outside.png', {
          type: 'image/png',
        }),
      );
      return document.body.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    }, file.buffer.toString('base64')),
  ).toBe(false);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.composer .image-thumbnail')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await transfer.dispose();
});

test('a delayed image read cannot attach to a newer conversation or send before it finishes', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.evaluate(() => {
    const decode = Image.prototype.decode;
    Image.prototype.decode = async function () {
      await decode.call(this);
      await new Promise<void>((resolve) => ((window as any).finishImageRead = resolve));
    };
  });
  await page.getByLabel('Message', { exact: true }).fill('Old draft');
  await page.getByLabel('Image files').setInputFiles(file);
  await expect(page.getByRole('status').filter({ hasText: 'Reading images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishImageRead))
    .toBe('function');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('New draft');
  await page.evaluate(() => (window as any).finishImageRead());
  await expect(page.getByRole('status').filter({ hasText: 'Reading images' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview diagram.png' })).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('New draft');
});

test('desktop keeps per-chat choices without an agent library', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Your agents' })).toHaveCount(0);
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  await chooseReasoning(page, 'High');
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await page.getByLabel('Instructions', { exact: true }).fill('Use short sentences.');
  await page.getByRole('button', { name: 'Save instructions', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Claude');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning', exact: true })).toContainText(
    'High',
  );
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('Gemini automatically exposes its existing CLI login', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await expect(card.getByText('CLI setup', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('Gemini CLI login');
  await expect(card.getByRole('button', { name: 'Open sign-in', exact: true })).toBeVisible();
  await expect(card).not.toContainText('@google/gemini-cli');
});

test('signed-out Gemini warns before submission and preserves the draft through Connections', async ({
  page,
}) => {
  await mockDesktop(page, 'login-flow');
  await page.goto('/');
  await chooseTestFolder(page);
  // Choosing it also opens Connections at its account.
  await pick(page, 'Agent', 'Gemini, Sign-in needed');
  await expect(page.locator('.fleet-account.highlighted')).toContainText('Gemini CLI login');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const message = page.getByLabel('Message', { exact: true });
  await expect(page.locator('.setup-hint')).toContainText('Sign in to Gemini.');
  await message.fill('Keep this Gemini draft until connected');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await message.press('Enter');
  await page.locator('form.composer').dispatchEvent('submit');
  await expect(page.locator('.conversation-item')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('test-sign-in-provider'))).toBeNull();
  expect(
    await page.evaluate(() =>
      (window as any).cliCalls.filter(
        (call: any) => call.command === 'list_models' && call.provider === 'gemini',
      ),
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Open Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await card.getByRole('button', { name: 'Open sign-in', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('test-sign-in-provider'))).toBe('gemini');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(message).toHaveValue('Keep this Gemini draft until connected');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.evaluate(() => {
    localStorage.setItem('test-google-login', 'ready');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(page.locator('.setup-hint')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).cliCalls.some(
          (call: any) => call.command === 'list_models' && call.provider === 'gemini',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  // Archiving opens a new chat; reopen the archived one from History.
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('#conversation-panel-history .conversation-item').click();
  await page.evaluate(() => {
    localStorage.removeItem('test-google-login');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('.setup-hint')).toContainText('Sign in to Gemini.');
  await message.fill('Do not restore while signed out');
  await message.press('Enter');
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].archived,
    ),
  ).toBe(true);
});

test('unknown provider authentication blocks sending until verified', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => localStorage.setItem('test-auth-claude', 'unknown'));
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByLabel('Message', { exact: true }).fill('Wait for this account');
  await expect(page.locator('.setup-hint')).toContainText("couldn't verify your Claude connection");
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/auth-required-browser.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Open Connections', exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/auth-required-mobile.png' });
  await page.evaluate(() => {
    localStorage.setItem('test-auth-claude', 'ready');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('external Google sign-in updates on focus and survives reload without a chat', async ({
  page,
}) => {
  await mockDesktop(page, 'login-flow');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await expect(card).toContainText('Sign-in needed');
  await card.getByRole('button', { name: 'Open sign-in' }).click();
  await expect(card).toContainText('Sign-in needed');
  const notice = page.locator('.notice[role="status"]');
  await expect(notice).toHaveText('Finish signing in through Gemini.');
  await page.evaluate(() => {
    localStorage.setItem('test-google-login', 'ready');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(card).not.toContainText('Sign-in needed');
  // The account reads connected, and no notice replaces the one that asked to sign in.
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(card).not.toContainText('Sign-in needed');
  await page.evaluate(() => localStorage.removeItem('test-google-login'));
  await page.getByRole('button', { name: 'Refresh connections' }).click();
  await expect(card).toContainText('Sign-in needed');
});

test('sign-in completion is polled while the external console remains open', async ({ page }) => {
  await mockDesktop(page, 'login-flow');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await card.getByRole('button', { name: 'Open sign-in' }).click();
  const notice = page.locator('.notice[role="status"]');
  await expect(notice).toHaveText('Finish signing in through Gemini.');
  await page.evaluate(() => localStorage.setItem('test-google-login', 'ready'));
  await expect(card).not.toContainText('Sign-in needed', {
    timeout: 8000,
  });
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('native transport contract renders rich output, preserves history, and strips unsafe HTML', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page
    .getByLabel('Message', { exact: true })
    .fill('First line\nSecond line: quotes " & $(x)');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await expect(page.locator('.prose h2')).toHaveText('A clear answer');
  await expect(page.locator('.prose pre code')).toContainText('<div>Safe code</div>');
  await expect(page.locator('.prose table td')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await expect(page.locator('.prose script, .prose img, .prose [href^="javascript:"]')).toHaveCount(
    0,
  );
  await page.getByLabel('Message', { exact: true }).fill('Follow up');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(request.messages[0].text).toContain('$(x)');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: /First line/ })
    .first()
    .click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
  await page.screenshot({ path: 'artifacts/chat-fixture.png', fullPage: true });
});

test('failures offer retry and stop keeps partial output', async ({ page }) => {
  await mockDesktop(page, 'slow');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByLabel('Message', { exact: true }).fill('Slow response');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.prose')).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('[data-status="cancelled"]')).toContainText('Hello world');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
});

test('login errors never masquerade as a completed answer', async ({ page }) => {
  await mockDesktop(page, 'error');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Gemini');
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-status="error"]')).toContainText('login needs attention');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeDisabled();
  await expect(page.locator('.setup-hint')).toContainText('Sign in to Gemini.');
  await expect(page.locator('[data-testid="message"]')).toHaveCount(2);
});

test('corrupted desktop storage is preserved and editing is blocked', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => localStorage.setItem('test-workspace', '{"version":999}'));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('No saved data has been overwritten');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).toBe('{"version":999}');
});

test('compact chat shell keeps navigation and the editor accessible', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.locator('.chat-layout')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Overview$/ })).toHaveCount(0);
  await expect(page.locator('.new-chat, .sidebar-bottom, .brand small')).toHaveCount(0);
  await expect(page.getByText('Personal workspace', { exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  const connections = page.getByRole('button', { name: 'Connections', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await connections.click();
  await expect(page.locator('.page-title')).toHaveText('Connections');
  await expect(connections).toHaveAttribute('aria-pressed', 'true');
  await expect(settings).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'Your computers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export workspace', exact: true })).toHaveCount(0);
  await settings.click();
  await expect(page.locator('.page-title')).toHaveText('Settings');
  await expect(settings).toHaveAttribute('aria-pressed', 'true');
  await expect(connections).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace data', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your computers', exact: true })).toHaveCount(0);
  await settings.click();
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await connections.click();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await expect(connections).toHaveAttribute('aria-pressed', 'false');
  await expect(settings).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: 'artifacts/compact-shell-browser.png', fullPage: true });
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Save instructions', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close chat instructions' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sidebar divider resizes with pointer and keyboard, remembers width, and keeps the chat usable', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const sidebar = page.locator('.sidebar');
  const divider = page.getByRole('separator', { name: 'Resize sidebar' });
  const width = () =>
    sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  // The whole window shows the resize cursor only while a drag is in progress.
  const cursor = () =>
    page
      .getByLabel('Message', { exact: true })
      .evaluate((element) => getComputedStyle(element).cursor);
  const dragTo = async (targetWidth: number) => {
    const bounds = (await divider.boundingBox())!;
    const before = await width();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 250);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + targetWidth - before, bounds.y + 250, {
      steps: 8,
    });
  };
  await expect.poll(width).toBe(236);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft while resizing');
  await dragTo(350);
  expect(await cursor()).toBe('col-resize');
  await page.mouse.up();
  await expect.poll(width).toBe(350);
  await expect.poll(cursor).not.toBe('col-resize');
  await expect(divider).toHaveAttribute('aria-valuenow', '350');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep this draft while resizing',
  );
  await divider.press('ArrowLeft');
  await expect.poll(width).toBe(340);
  await dragTo(400);
  expect(await cursor()).toBe('col-resize');
  await page.keyboard.press('Escape');
  await expect.poll(cursor).not.toBe('col-resize');
  await page.mouse.up();
  await expect.poll(width).toBe(340);
  await page.reload();
  await expect.poll(width).toBe(340);
  await page.setViewportSize({ width: 880, height: 720 });
  await expect.poll(width).toBe(280);
  expect(
    await page.locator('.main-area').evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/sidebar-resize-compact.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await expect.poll(width).toBe(340);
  await divider.press('Home');
  await expect.poll(width).toBe(180);
  await dragTo(80);
  await page.mouse.up();
  await expect.poll(width).toBe(180);
  await divider.press('End');
  await expect.poll(width).toBe(480);
  await page.screenshot({ path: 'artifacts/sidebar-resize-wide.png', animations: 'disabled' });
  await divider.dblclick();
  await expect.poll(width).toBe(236);
  await page.reload();
  await expect.poll(width).toBe(236);
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(divider).toBeHidden();
  await expect(sidebar).toBeHidden();
  await expect
    .poll(() =>
      page
        .locator('.main-area')
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBe(600);
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect(sidebar).toBeVisible();
  await expect.poll(width).toBe(320);
  await page.getByRole('button', { name: 'Close conversations', exact: true }).click();
  await expect(sidebar).toBeHidden();
});

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function returnAfterUsageCacheExpires(page: Page) {
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 61_000));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test('subscription windows include resets and Fable is shown only for Fable', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-19T12:00:00Z'));
  await mockDesktop(page, 'usage-success');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Sonnet');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-5-hour')).toContainText('12%');
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  const resetDate = await page.evaluate(() => {
    const date = new Date('2026-09-19T13:00:00Z');
    const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (date.toDateString() === new Date().toDateString()) return clock;
    const weekday = date.toLocaleDateString([], { weekday: 'long' });
    return `${weekday}, ${clock}`;
  });
  await expect(page.getByTestId('limit-weekly')).toContainText(`Resets ${resetDate}`);
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  const strip = page.locator('.usage-strip');
  await expect(strip.getByRole('progressbar')).toHaveCount(3);
  await pick(page, 'Model', 'Fable');
  await expect(strip.getByRole('progressbar')).toHaveCount(4);
  const fableChip = strip.getByRole('button', { name: /^Show Fable weekly usage details/ });
  await expect(fableChip.locator('.usage-bar-heading > span').first()).toHaveText('Fable weekly');
  await expect(fableChip.locator('strong')).toHaveText('62% used');
  await expect(
    fableChip.getByRole('progressbar', { name: 'Fable weekly limit used', exact: true }),
  ).toHaveAttribute('aria-valuenow', '62');
  await expect(page.getByTestId('limit-fable-weekly')).toContainText('62%');
  await expect(page.getByTestId('limit-fable-weekly').getByRole('meter')).toHaveAttribute(
    'aria-valuenow',
    '62',
  );
  await page.screenshot({ path: 'artifacts/usage-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/usage-compact.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fableChip).toBeInViewport();
  expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/usage-phone.png' });
  await page.setViewportSize({ width: 880, height: 720 });
  await pick(page, 'Model', 'Sonnet');
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  await expect(strip.getByRole('progressbar')).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('quota pace explains ahead, below, and on-track budgets and withdraws guidance on failure', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-pace');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Fable');
  await page.locator('.context-chip').click();
  const short = page.getByTestId('limit-5-hour').getByTestId('quota-pace');
  const week = page.getByTestId('limit-weekly').getByTestId('quota-pace');
  const fable = page.getByTestId('limit-fable-weekly').getByTestId('quota-pace');
  await expect(short.getByRole('img', { name: 'Ahead of pace' })).toHaveAttribute(
    'title',
    /Ahead of pace/,
  );
  await expect(short.locator('.pace-indicator')).toHaveText('');
  await expect(short.locator('.pace-advice')).toHaveCount(0);
  await expect(page.locator('[title*="less until reset"]')).toHaveCount(0);
  await expect(short).toContainText('Budget: 12%/hour');
  await expect(short.locator('.pace-indicator')).toHaveClass(/tone-watch/);
  await expect(week.getByRole('img', { name: 'Below pace' })).toBeVisible();
  await expect(fable.getByRole('img', { name: 'On track' })).toBeVisible();
  const belowColor = await week
    .locator('.pace-indicator')
    .evaluate((node) => getComputedStyle(node).color);
  const steadyColor = await fable
    .locator('.pace-indicator')
    .evaluate((node) => getComputedStyle(node).color);
  expect(belowColor).not.toBe(steadyColor);
  await expect(page.getByTestId('limit-weekly').locator('.quota-fill')).toHaveCSS(
    'background-color',
    belowColor,
  );
  await expect(page.getByTestId('limit-fable-weekly').locator('.quota-fill')).toHaveCSS(
    'background-color',
    steadyColor,
  );
  for (const [label, current] of [
    ['5-hour', 70],
    ['weekly', 25],
    ['fable-weekly', 50],
  ] as const) {
    const card = page.getByTestId(`limit-${label}`);
    await expect(card).not.toContainText(/Recommended|Guide unavailable/);
    await expect(card.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      `${current}% used, recommended 50%`,
    );
    const bars = await card.locator('.usage-meter').evaluate((el) => {
      const actual = el.querySelector('.quota-fill')!.getBoundingClientRect();
      const recommended = el.querySelector('.recommended-fill')!.getBoundingClientRect();
      return {
        actual: actual.width / el.clientWidth,
        recommended: recommended.width / el.clientWidth,
        aligned: Math.abs(actual.left - recommended.left) < 1,
        sameTrack:
          Math.abs(actual.top - recommended.top) < 1 &&
          Math.abs(actual.bottom - recommended.bottom) < 1,
      };
    });
    expect(bars.actual).toBeCloseTo(current / 100, 2);
    expect(bars.recommended).toBeCloseTo(0.5, 2);
    expect(bars.aligned && bars.sameTrack).toBe(true);
    await expectVisibleQuotaComparison(card.getByRole('meter'), current > 50);
  }
  await expect(page.locator('.usage-strip .recommended-fill')).toHaveCount(3);
  await expect(page.locator('.usage-strip')).not.toContainText(/Recommended|Guide unavailable/);
  await expect(page.locator('.context-chip .recommended-fill')).toHaveCount(0);
  await expect(page.locator('.usage-extra, .usage-totals')).toHaveCount(0);
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/pace-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Fable weekly's heading can wrap at this width; its arrow must stay beside the value.
  await expect(page.locator('.usage-strip .usage-bar-value .pace-indicator')).toHaveCount(3);
  expect(
    await page.locator('.usage-strip .usage-bar-value').evaluateAll((values) =>
      values.every((value) => {
        const text = value.querySelector('strong')!.getBoundingClientRect();
        const arrow = value.querySelector('.pace-indicator')!.getBoundingClientRect();
        const middle = arrow.top + arrow.height / 2;
        return middle > text.top && middle < text.bottom;
      }),
    ),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/pace-compact.png', fullPage: true });
  await page.evaluate(() => localStorage.setItem('test-usage-error', '1'));
  await returnAfterUsageCacheExpires(page);
  await expect(short.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(week.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(fable.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(page.locator('.usage-strip .pace-indicator')).toHaveCount(0);
  await expect(page.locator('.recommended-fill')).toHaveCount(0);
  await expect(page.getByTestId('limit-5-hour')).toContainText('70%');
});

test('context growth indicators survive reload and stay independent of drafts', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-pace');
  await page.addInitScript(() => {
    if (localStorage.getItem('test-workspace')) return;
    const settings = { provider: 'claude', model: 'sonnet', reasoning: '', instructions: '' };
    const messages = [4000, 7000, 10000].flatMap((tokens) => [
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: '',
        blocks: [{ type: 'markdown', text: 'Continue the garden plan.' }],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: '',
        settings,
        blocks: [{ type: 'markdown', text: 'Here is the next step.' }],
        promptTokensEstimate: 100,
        usage: {
          input: tokens,
          contextInput: tokens,
          output: 10,
          contextWindow: 20000,
          model: 'claude-sonnet',
        },
      },
    ]);
    localStorage.setItem(
      'test-workspace',
      JSON.stringify({
        version: 2,
        preferences: {
          lastProvider: 'claude',
          modelByProvider: { claude: 'sonnet' },
          reasoningByProvider: {},
        },
        conversations: [
          {
            id: crypto.randomUUID(),
            settings,
            title: 'Growing context fixture',
            createdAt: '',
            updatedAt: '',
            messages,
          },
        ],
      }),
    );
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  const guidance = page.getByTestId('context-pace');
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Growing quickly/);
  await expect(page.locator('.context-card, .context-chip').getByRole('img')).toHaveCount(0);
  await expect(guidance).toContainText('~2 similar exchanges to 80%');
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(meter).toHaveAttribute('aria-valuenow', '50');
  await page.getByLabel('Message', { exact: true }).fill('a'.repeat(30000));
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Growing quickly/);
  await expect(meter).toHaveAttribute('aria-valuenow', '50');
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace'));
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  await expect(guidance).toContainText('~2 similar exchanges to 80%');
  const reloaded = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  // Only the new start of the app, which replaces the start without chats, and archiving change.
  expect(reloaded.appSessions).toHaveLength(1);
  expect(reloaded.appSessions[0].id).not.toBe(JSON.parse(saved!).appSessions[0].id);
  expect(reloaded).toEqual({
    ...JSON.parse(saved!),
    appSessions: reloaded.appSessions,
    conversations: JSON.parse(saved!).conversations.map((c: object) => ({ ...c, archived: true })),
  });
  await expect(page.getByTestId('forecast-pace')).toHaveCount(0);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const replies = workspace.conversations[0].messages.filter(
      (message: { role: string }) => message.role === 'assistant',
    );
    replies.forEach(
      (message: { usage: { contextInput: number; input: number } }, index: number) => {
        message.usage.contextInput = 1000 + index * 100;
        message.usage.input = message.usage.contextInput;
      },
    );
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Room available/);
  await expect(page.getByTestId('context-growth')).toHaveCount(0);
  await expect(guidance).toHaveCount(0);
  await expect(meter).toHaveAttribute('aria-valuenow', '6');
  await pick(page, 'Model', 'Opus');
  await expect(guidance.locator('.pace-indicator')).toHaveCount(0);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('reported context stays exact while typing and survives reload', async ({ page }) => {
  await mockDesktop(page, 'usage-success');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(meter).toHaveCount(0);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await page.getByLabel('Message', { exact: true }).fill('Garden context check ' + 'a'.repeat(400));
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(meter).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .cachedInput,
    ),
  ).toBe(1500);
  await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
    'title',
    '2,000 input tokens',
  );
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.locator('.context-chip strong')).toHaveText('2K / 20K');
  await expect(page.locator('.context-chip')).not.toContainText('%');
  await expect(page.locator('.context-chip')).toHaveAttribute(
    'title',
    /^2,000 of 20,000 tokens used \(10%\)\. Room available\./,
  );
  await expect(page.locator('.context-chip')).not.toContainText('estimated');
  await expect(page.locator('.context-chip')).not.toContainText('reported');
  await expect(page.locator('.context-card .usage-card-heading')).toHaveText('Chat context');
  await page.getByLabel('Message', { exact: true }).fill('a'.repeat(4000));
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/context-reported-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({ path: 'artifacts/context-reported-compact.png', fullPage: true });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: /Garden context check/ })
    .first()
    .click();
  await page.locator('.context-chip').click();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
    'title',
    '2,000 input tokens',
  );
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Fable', exact: true }).click();
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('a turn total never masquerades as measured context', async ({ page }) => {
  await mockDesktop(page, 'usage-unmeasured');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.locator('.context-chip').click();
  await page.getByLabel('Message', { exact: true }).fill('Unmeasured context check');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(page.getByRole('meter', { name: 'Reported context used', exact: true })).toHaveCount(
    0,
  );
});

test('a pending reply keeps the previous reading and a completed reply without context clears it', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  await page.getByLabel('Message', { exact: true }).fill('First request');
  await page.getByRole('button', { name: 'Send message' }).click();
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Second request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByTestId('reported-context')).toContainText('Updating…');
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('missing and failed quota readings never show fabricated zero usage', async ({ page }) => {
  await mockDesktop(page, 'usage-missing');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-5-hour')).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: '5-hour limit used' })).toHaveCount(0);
  await expect(page.locator('.usage-strip .usage-chip')).toHaveCount(2);
  await expect(page.locator('#usage-details .credit-usage')).toContainText(
    'Not reported',
  );
  await expect(page.getByTestId('limit-weekly')).toContainText('26%');
  await page.evaluate(() => localStorage.setItem('test-usage-error', '1'));
  await returnAfterUsageCacheExpires(page);
  await expect(page.locator('.usage-error')).toContainText('Usage refresh failed');
  await expect(page.getByTestId('limit-weekly')).toContainText('26%');
  await expect(page.getByTestId('limit-weekly')).toContainText('Last reported');
  await expect(page.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute(
    'aria-valuenow',
    '26',
  );
  await expect(page.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute(
    'aria-valuetext',
    /last reported/,
  );
});

test('a late usage result cannot replace the selected providers reading', async ({ page }) => {
  await mockDesktop(page, 'usage-race');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  await page.evaluate(() => (window as any).resolveUsage());
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Claude');
});

test('composer shows three usage bars below the input and keeps tool access in the Agent hover', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const strip = page.locator('.composer-area .usage-strip');
  await expect(strip.getByRole('progressbar')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Refresh usage', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Usage and context', exact: true })).toHaveCount(0);
  await expect(strip.getByRole('button')).toHaveCount(3);
  await expect(page.locator('.composer-caption')).toHaveCount(0);
  expect(
    await strip.evaluate(
      (el) =>
        el.getBoundingClientRect().top >=
        document.querySelector('.composer')!.getBoundingClientRect().bottom,
    ),
  ).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveAttribute(
    'title',
    /Full access/,
  );
  for (const provider of ['Claude', 'Gemini', 'Codex']) {
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: provider, exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveAttribute(
      'title',
      /Full access.*without approval prompts/,
    );
    await expect(strip.getByRole('progressbar')).toHaveCount(3);
    await expect(strip.getByRole('button', { name: 'Show credits details' })).toHaveCount(0);
  }
  await expect(strip.getByRole('progressbar', { name: 'Context used' })).not.toHaveAttribute(
    'aria-valuenow',
  );
  await expect(strip.getByRole('progressbar', { name: '5-hour limit used' })).toHaveAttribute(
    'aria-valuenow',
    '12',
  );
  await page.screenshot({ path: 'artifacts/composer-usage-bars-browser.png' });
  await page.locator('.context-chip').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.usage-details')).toBeVisible();
  const headerCenters = await page.locator('.usage-details-heading > *').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    }),
  );
  expect(Math.max(...headerCenters) - Math.min(...headerCenters)).toBeLessThan(1);
  expect(
    await page
      .locator('.usage-details')
      .evaluate(
        (el) =>
          el.getBoundingClientRect().bottom <=
          document.querySelector('.usage-strip')!.getBoundingClientRect().top,
      ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.usage-details')).toHaveCount(0);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/composer-usage-bars-narrow-browser.png' });
  await page.locator('.context-chip').click();
  await page.screenshot({ path: 'artifacts/composer-usage-expanded-narrow-browser.png' });
  await page.getByRole('button', { name: 'Close usage details', exact: true }).click();
  await expect(page.locator('.usage-details')).toHaveCount(0);
});

test('models and reasoning are remembered independently and each chat retains its settings', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Sonnet');
  await chooseReasoning(page, 'High');
  await pick(page, 'Model', 'Opus');
  await chooseReasoning(page, 'Max');
  await pick(page, 'Model', 'Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Model', 'GPT-6 Astra');
  await chooseReasoning(page, 'Low');
  await page.getByLabel('Message', { exact: true }).fill('First configured chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', reasoning: 'low' });
  const firstRequest = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request')!),
  );
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    firstRequest.location.path,
  );
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await chooseReasoning(page, 'High');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await page.getByLabel('Message', { exact: true }).fill('Continue with a different model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.agent).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    connectionId: firstRequest.agent.connectionId,
  });
  expect(request.location).toEqual(firstRequest.location);
  expect(request.messages).toHaveLength(3);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeEnabled();
  await pick(page, 'Agent', 'Claude');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await pick(page, 'Model', 'Opus');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('Max');
  await page.getByLabel('Message', { exact: true }).fill('Second configured chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Opus');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('Max');
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'First configured chat', exact: true }).click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6 Sol',
  );
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
      (c: any) => c.title === 'First configured chat',
    ),
  );
  expect(saved.messages[1].settings).toMatchObject({
    provider: 'codex',
    model: 'gpt-6-astra',
    reasoning: 'low',
  });
  expect(saved.messages[3].settings).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
  });
});

test('unsupported reasoning levels are absent and only location and agent stay locked during a reply', async ({
  page,
}) => {
  await mockDesktop(page, 'slow');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Gemini');
  await pick(page, 'Model', 'Gemini 3.1 Pro');
  await page.getByRole('combobox', { name: 'Reasoning' }).click();
  await expect(reasoningLevels(page)).toHaveText(['Default', 'Low', 'High']);
  await page.keyboard.press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('A slow reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  for (const name of ['Model', 'Reasoning'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
});

test('model and reasoning changes during streaming apply only to the next reply and survive reload', async ({
  page,
}) => {
  await mockDesktop(page, 'settings-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Model', 'GPT-6 Astra');
  await chooseReasoning(page, 'Low');
  await page.getByLabel('Message', { exact: true }).fill('Keep each reply model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(page.locator('.message-heading strong')).toHaveText(['You', 'GPT-6 Astra']);
  await expect(page.locator('.message-execution')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chat instructions', exact: true })).toBeDisabled();
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await chooseReasoning(page, 'High');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    'Next message: GPT-5.6 Sol · High reasoning',
  );
  await expect(page.locator('.message-heading strong')).toHaveText(['You', 'GPT-6 Astra']);
  await expect(page.locator('.reply-switch')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ model: 'gpt-6-astra', reasoning: 'low' });
  await page.screenshot({ path: 'artifacts/next-reply-pending-browser.png' });
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Use the new model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.reply-switch')).toHaveText(
    'Switched to GPT-5.6 Sol · High reasoning',
  );
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  await expect(page.getByTestId('message').last().locator('.prose')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ model: 'gpt-5.6-sol', reasoning: 'high' });
  await chooseReasoning(page, 'Low');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    'Next message: GPT-5.6 Sol · Low reasoning',
  );
  await expect(page.locator('.reply-switch')).toHaveText(
    'Switched to GPT-5.6 Sol · High reasoning',
  );
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Use the new reasoning');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.reply-switch')).toHaveText([
    'Switched to GPT-5.6 Sol · High reasoning',
    'Switched to Low reasoning',
  ]);
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Keep each reply model', exact: true }).click();
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
    'You',
    'GPT-5.6 Sol',
  ]);
  await expect(page.locator('.reply-switch')).toHaveText([
    'Switched to GPT-5.6 Sol · High reasoning',
    'Switched to Low reasoning',
  ]);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.filter(
      (m: any) => m.role === 'assistant',
    ),
  );
  expect(saved.map((m: any) => [m.settings.model, m.settings.reasoning])).toEqual([
    ['gpt-6-astra', 'low'],
    ['gpt-5.6-sol', 'high'],
    ['gpt-5.6-sol', 'low'],
  ]);
  await page.screenshot({ path: 'artifacts/model-switches-browser.png' });
});

test('a background title is generated once, persists, and preserves chat choices', async ({
  page,
}) => {
  await mockDesktop(page, 'title-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Model', 'GPT-6 Astra');
  await chooseReasoning(page, 'High');
  await page
    .getByLabel('Message', { exact: true })
    .fill('Help me plan a small garden on my balcony');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(before.conversations[0].titleStatus).toBe('pending');
  await page.evaluate(() => (window as any).resolveTitle());
  await expect(
    page.getByRole('button', { name: 'Planning a balcony garden', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Which herbs should I grow?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Planning a balcony garden', exact: true }).click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(after.preferences).toEqual(before.preferences);
  expect(after.conversations[0].settings).toEqual(before.conversations[0].settings);
  expect(after.conversations[0]).toMatchObject({
    titleStatus: 'generated',
    titleSource: { provider: 'codex', model: 'gpt-5.6-luna' },
  });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-title-requests')!)),
  ).toHaveLength(1);
});

test('title failure keeps the first-message title without affecting replies or retrying', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByLabel('Message', { exact: true }).fill('Planning a small garden');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Planning a small garden', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Planning a small garden', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].titleStatus).toBe('fallback');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-title-requests')!)),
  ).toHaveLength(1);
});

test('the first chat in a folder has a model choose its icon, which every chat there keeps', async ({
  page,
}) => {
  await mockDesktop(page, 'folder-icons');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByLabel('Message', { exact: true }).fill('Fix the voxel shader in my game');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const folder = page.locator('.folder-group-toggle', { hasText: 'studio' });
  await expect(folder.locator('svg.lucide-gamepad-2')).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Folder', exact: true }).locator('svg.lucide-gamepad-2'),
  ).toBeVisible();
  const requests = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('test-folder-icon-requests') ?? '[]'));
  // The model reads the folder by its name and a parent, and the first message.
  expect(await requests()).toEqual([
    expect.objectContaining({
      provider: 'claude',
      folder: 'Projects/studio',
      firstMessage: 'Fix the voxel shader in my game',
    }),
  ]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.folderIcons).toEqual([
    {
      environmentId: saved.conversations[0].location.environmentId,
      path: 'C:\\Projects\\studio',
      icon: 'gamepad-2',
      source: { provider: 'claude', model: 'haiku' },
      chosenAt: expect.any(String),
    },
  ]);
  // Later chats in the folder keep its icon without asking again, after a restart too.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  // The Folder picker's list shows it too.
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  const choice = (name: string) => page.getByRole('option', { name, exact: true });
  await expect(choice('studio').locator('svg.lucide-gamepad-2')).toBeVisible();
  await expect(choice('Standalone').locator('svg.lucide-message-circle')).toBeVisible();
  await expect(choice('Browse folders…').locator('svg.lucide-folder-search')).toBeVisible();
  await page.screenshot({ path: 'artifacts/folder-icons-picker-browser.png' });
  await page.keyboard.press('Escape');
  await expect(choice('studio')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Now tune the lighting');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(
    page
      .locator('#conversation-panel-history .folder-group-toggle', { hasText: 'studio' })
      .locator('svg.lucide-gamepad-2'),
  ).toBeVisible();
  expect(await requests()).toHaveLength(1);
  await page.screenshot({ path: 'artifacts/folder-icons-browser.png' });
});

test('a late title follows its original chat and cannot restore a deleted conversation', async ({
  page,
}) => {
  await mockDesktop(page, 'title-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByLabel('Message', { exact: true }).fill('A balcony garden question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.evaluate(() => (window as any).resolveTitle());
  await expect(
    page.getByRole('button', { name: 'Planning a balcony garden', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('A second garden question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.locator('.conversation-item[aria-current="page"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await page.evaluate(() => (window as any).resolveTitle());
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations.length),
    )
    .toBe(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].title).toBe('Planning a balcony garden');
  expect(await page.evaluate(() => localStorage.getItem('test-cancelled-title'))).toBeTruthy();
});

test('sidebar deletion targets a History chat without opening it or clearing the current draft', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Older sidebar conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.getByRole('button', { name: 'Move to history' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await message.fill('Current sidebar conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  await message.fill('Preserve this unsent draft');
  await page.getByRole('tab', { name: /^History/ }).click();
  const row = page.getByRole('button', { name: 'Older sidebar conversation', exact: true });
  const menu = page.getByRole('menu', {
    name: 'Actions for Older sidebar conversation',
    exact: true,
  });
  await row.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(page.locator('.page-title')).toHaveText('Current sidebar conversation');
  await expect(message).toHaveValue('Preserve this unsent draft');
  await expect(
    page.locator('.chat-toolbar').getByRole('button', { name: 'Delete conversation' }),
  ).toHaveCount(0);
  await page.screenshot({
    path: 'artifacts/sidebar-context-menu-browser.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
  await row.click({ button: 'right' });
  await message.click();
  await expect(menu).toHaveCount(0);
  await row.focus();
  await row.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: 'Fork conversation' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Snooze' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Delete conversation' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Older sidebar conversation');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
  ).toEqual(before);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations' }).click();
  const bounds = (await row.boundingBox())!;
  const pointer = {
    pointerId: 1,
    pointerType: 'touch',
    clientX: bounds.x + 20,
    clientY: bounds.y + bounds.height / 2,
    bubbles: true,
  };
  await row.dispatchEvent('pointerdown', pointer);
  await expect(menu).toBeVisible();
  await row.dispatchEvent('pointerup', pointer);
  await row.dispatchEvent('click');
  await expect(page.locator('.page-title')).toHaveText('Current sidebar conversation');
  const menuBounds = (await menu.boundingBox())!;
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'artifacts/sidebar-context-menu-mobile.png',
    animations: 'disabled',
  });
  await menu.getByRole('menuitem', { name: 'Delete conversation' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row).toBeFocused();
  await row.press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Delete conversation' }).click();
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
    )
    .toEqual(before.filter((c: any) => c.title !== 'Older sidebar conversation'));
  await page.getByRole('button', { name: 'Close conversations' }).click();
  await expect(message).toHaveValue('Preserve this unsent draft');
  await expect(page.locator('.page-title')).toHaveText('Current sidebar conversation');
});

test('sidebar deletion stops a running Active chat and ignores late events', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Running sidebar conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'running');
  await page.locator('.conversation-item[aria-current="page"]').click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: 'Delete conversation', exact: true });
  await item.click();
  await expect(page.getByRole('alertdialog')).toContainText('Its running reply will be stopped');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).cancelCalls ?? [])).toEqual([]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep the other draft');
  await page.locator('.conversation-item').click({ button: 'right' });
  await item.click();
  await page.evaluate(() => ((window as any).holdCancel = true));
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.locator('.conversation-item')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).cancelCalls)).toEqual([
    { runId: request.runId, waitForCompletion: true },
  ]);
  await page.evaluate(() => (window as any).releaseCancel());
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.conversation-item')).toHaveCount(0);
  await page.evaluate(() => (window as any).emitCapability({ kind: 'text', text: 'Late output' }));
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the other draft');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
    )
    .toEqual([]);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('failed cancellation preserves the Active conversation and deletion can be retried', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Delete this current Active chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.locator('.conversation-item').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation' }).click();
  await page.evaluate(() => ((window as any).failCancel = true));
  const confirm = page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation' });
  await confirm.click();
  await expect(page.getByRole('alertdialog')).toContainText('could not stop the response');
  await expect(page.locator('.conversation-item')).toHaveCount(1);
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'running');
  await page.evaluate(() => ((window as any).failCancel = false));
  await confirm.click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.locator('.conversation-item')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.conversation-item')).toHaveCount(0);
});

test('opening the app archives saved chats and sending from History restores the same conversation', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const message = page.getByLabel('Message', { exact: true });
  const activeTab = page.getByRole('tab', { name: /^Active/ });
  const historyTab = page.getByRole('tab', { name: /^History/ });
  for (const title of ['Resume this conversation', 'Keep this older conversation']) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await message.fill(title);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  }
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const source = workspace.conversations[0];
    workspace.conversations.push({
      ...source,
      id: crypto.randomUUID(),
      title: 'General conversation without a folder',
      archived: false,
      location: { ...source.location, path: '' },
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  const original = before.find((c: any) => c.title === 'Resume this conversation');
  await page.reload();
  await expect(activeTab).toHaveText('Active0');
  await expect(historyTab).toHaveText('History3');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
    )
    .toEqual(before.map((c: object) => ({ ...c, archived: true })));
  await historyTab.click();
  await page.getByRole('button', { name: original.title, exact: true }).click();
  await expect(message).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Restore to continue' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore conversation', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Move to history', exact: true })).toHaveCount(0);
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await message.fill('   ');
  await message.press('Enter');
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab).toHaveText('Active0');
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await message.fill('Continue with this new prompt');
  const archivedDraft = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(archivedDraft.every((c: any) => c.archived)).toBe(true);
  expect(archivedDraft.find((c: any) => c.id === original.id).messages).toEqual(original.messages);
  await page.screenshot({ path: 'artifacts/history-ready-to-send.png', animations: 'disabled' });
  await message.press('Enter');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab).toHaveText('Active1');
  await expect(historyTab).toHaveText('History2');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const after = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(after).toHaveLength(before.length);
  const resumed = after.find((c: any) => c.id === original.id);
  expect(resumed.archived).toBe(false);
  expect(resumed.location).toEqual(original.location);
  expect(resumed.messages.slice(0, original.messages.length)).toEqual(original.messages);
  expect(resumed.messages).toHaveLength(original.messages.length + 2);
  expect(resumed.settings.model).toBe('gpt-5.6-sol');
  expect(after.filter((c: any) => c.id !== original.id).every((c: any) => c.archived)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Refresh model list', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Copy conversation', exact: true })).toHaveCount(0);
  await expect(activeTab).toHaveText('Active1');
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({
    path: 'artifacts/history-auto-restored-compact.png',
    animations: 'disabled',
  });
  await page.reload();
  await expect(activeTab).toHaveText('Active0');
  await expect(historyTab).toHaveText('History3');
});

test('computer and Standalone plus buttons open scoped drafts from collapsed groups', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep this project conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const source = workspace.conversations[0];
    workspace.conversations.push({
      ...source,
      id: crypto.randomUUID(),
      title: 'Old general conversation',
      archived: true,
      location: { ...source.location, path: '' },
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveText('History2');
  const original = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  const active = page.locator('#conversation-panel-active');
  const history = page.locator('#conversation-panel-history');
  const historyTab = page.getByRole('tab', { name: /^History/ });
  await historyTab.click();
  await history.getByRole('button', { name: 'Old general conversation', exact: true }).click();
  // History lists app sessions, which collapse but start no conversation of their own.
  await history.locator('.session-group-toggle').click();
  await expect(
    history.getByRole('button', { name: 'Old general conversation', exact: true }),
  ).toHaveCount(0);
  await expect(history.locator('.computer-group-toggle, .computer-new-chat')).toHaveCount(0);
  await history.locator('.session-group-toggle').click();
  await history.getByRole('button', { name: 'Standalone', exact: true }).click();
  await history
    .getByRole('button', { name: 'New standalone conversation on Desktop', exact: true })
    .press('Enter');
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  await expect(picker('Computer')).toHaveText('Desktop');
  await expect(picker('Folder')).toHaveText('Standalone');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.getByTestId('message')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await page.getByLabel('Message', { exact: true }).fill('Keep this Standalone draft');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await active.locator('.computer-group-toggle').click();
  await active.getByRole('button', { name: 'New conversation on Desktop', exact: true }).click();
  await expect(picker('Folder')).toHaveText('Standalone');
  await expect(picker('Agent')).toBeEnabled();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  // Each action starts its own scratch chat; the first waits in Active Standalone with its text.
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(
    active.getByRole('button', { name: 'Unsent draft: Keep this Standalone draft', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Model context' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).contextCalls.at(-1).location)).toBeNull();
  await page.getByRole('button', { name: 'Close model context' }).click();
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('A new general conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.location).toBeUndefined();
  expect(request.agent.provider).toBe('claude');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].location).toEqual({ ...original[0].location, path: '' });
  expect(
    saved.fleet.connections.find((c: any) => c.id === request.agent.connectionId).environmentId,
  ).toBe(original[0].location.environmentId);
  expect(saved.conversations.slice(1)).toEqual(original);
  expect(saved.conversations[0].archived).not.toBe(true);
  await expect(active.locator('.folder-new-chat')).toHaveCount(1);
  const computerLeft = (await active.locator('.computer-group-row').boundingBox())!.x;
  for (const folder of await active.locator('.folder-group-row').all())
    expect((await folder.boundingBox())!.x).toBe(computerLeft + 16);
  await page.screenshot({ path: 'artifacts/sidebar-plus-wide.png', animations: 'disabled' });
  await page.setViewportSize({ width: 880, height: 720 });
  await expect(
    active.getByRole('button', { name: 'New conversation on Desktop', exact: true }),
  ).toBeVisible();
  await expect(
    active.getByRole('button', { name: 'New standalone conversation on Desktop', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/sidebar-plus-compact.png', animations: 'disabled' });
});

test('computer then folder scopes CLI choices and groups active and history without losing messages', async ({
  page,
}) => {
  await mockDesktop(page, 'locations');
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeEnabled();
  await page.getByLabel('Message', { exact: true }).fill('Windows folder conversation');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0],
  );
  expect(before.location.path).toBe('C:\\Projects\\studio');
  await expect(page.locator('.topbar')).toHaveText(before.title);
  await expect(
    page.locator('.execution-toolbar, .location-path, .breadcrumb, .topbar-right'),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    before.location.path,
  );
  await expect(page.locator('.chat-toolbar')).not.toContainText(before.location.path);
  const active = page.locator('#conversation-panel-active');
  const history = page.locator('#conversation-panel-history');
  const activeTab = page.getByRole('tab', { name: /^Active/ });
  const historyTab = page.getByRole('tab', { name: /^History/ });
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(history).toBeHidden();
  // The tabs go Active, History and Screens, and the arrows wrap around them; the Agent and
  // Workflow modes are tabs of their own above them.
  const screensTab = page.getByRole('tab', { name: /^Screens/ });
  await expect(page.getByRole('tab', { name: /^Workflows/ })).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Mode' }).getByRole('tab')).toHaveText([
    /^Agent/,
    /^Workflow/,
  ]);
  await activeTab.press('End');
  await expect(screensTab).toBeFocused();
  await expect(page.locator('#conversation-panel-screens')).toBeVisible();
  await screensTab.press('ArrowLeft');
  await expect(historyTab).toBeFocused();
  await expect(history).toBeVisible();
  await expect(history).toContainText('No conversations in History');
  await historyTab.press('ArrowLeft');
  await expect(activeTab).toBeFocused();
  await activeTab.press('ArrowLeft');
  await expect(screensTab).toBeFocused();
  await screensTab.press('ArrowRight');
  await expect(activeTab).toBeFocused();
  await expect(active).toBeVisible();
  await expect(active.locator('.conversation-item')).toHaveAttribute('aria-current', 'page');
  await expect(active.locator('.conversation-computer')).toContainText('Desktop');
  await expect(active.locator('.folder-group-toggle')).toHaveText('studio');
  await active.locator('.folder-group-toggle').click();
  await expect(active.locator('.conversation-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  // With no other Active chat left, a new chat opens and the sidebar stays on Active.
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(active.locator('.conversation-item')).toHaveCount(0);
  await historyTab.click();
  await expect(history).toBeVisible();
  await expect(history.locator('.conversation-item')).toHaveCount(1);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.reload();
  await historyTab.click();
  await history.locator('.conversation-item').click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restore conversation', exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('Message', { exact: true }).fill('Continue this folder conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(active).toBeVisible();
  await expect(active.locator('.conversation-item')).toHaveCount(1);
  expect(
    await page.evaluate(
      (count) =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.slice(
          0,
          count,
        ),
      before.messages.length,
    ),
  ).toEqual(before.messages);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Folder environment', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await page.getByRole('button', { name: 'Edit path', exact: true }).click();
  await expect(page.getByLabel('Folder path', { exact: true })).toHaveValue('/home/test/studio');
  await page.getByLabel('Folder path', { exact: true }).fill('/missing');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Folder does not exist');
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Gemini', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).press('Escape');
  await expect(
    page.getByRole('combobox', { name: 'Account and environment', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await expect(page.getByRole('listbox')).not.toContainText('/home/test/studio');
  await expect(
    page.getByRole('option', { name: 'studio', exact: true }).filter({ hasText: 'WSL · Ubuntu' }),
  ).toHaveAttribute('title', '/home/test/studio');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('Linux folder conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.location.environmentId).toBe('33333333-3333-4333-8333-333333333333');
  expect(request.agent.provider).toBe('codex');
  await expect(active.locator('.conversation-computer')).toHaveCount(2);
  await expect(active.locator('.conversation-folder')).toHaveCount(2);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await page.screenshot({ path: 'artifacts/folder-groups-browser.png', animations: 'disabled' });
  const controlRows = () =>
    page
      .locator('.chat-configuration [role="combobox"]')
      .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().top));
  expect(new Set(await controlRows()).size).toBe(1);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(new Set(await controlRows()).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/folder-groups-compact.png', animations: 'disabled' });
  await page.getByLabel('Search conversations').fill('C:\\Projects');
  await expect(activeTab).toHaveText('Active1');
  await expect(historyTab).toHaveText('History0');
  await expect(history).toContainText('No matches');
  await activeTab.click();
  await expect(active.locator('.conversation-item')).toHaveCount(1);
  await expect(history.locator('.conversation-item')).toHaveCount(0);
  const originalConversations = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  await active
    .getByRole('button', { name: 'New conversation in studio on Desktop', exact: true })
    .press('Enter');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    'C:\\Projects\\studio',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await historyTab.click();
  await history.locator('.folder-group-toggle').click();
  await history
    .getByRole('button', { name: 'New conversation in studio on WSL · Ubuntu', exact: true })
    .click();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await expect(page.getByTestId('message')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
  ).toEqual(originalConversations);
  await page
    .getByLabel('Message', { exact: true })
    .fill('A new conversation from the archived Linux folder');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const folderRequest = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request')!),
  );
  expect(folderRequest.location).toEqual(request.location);
  expect(folderRequest.agent.provider).toBe('codex');
  const after = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(
    after.filter((c: { id: string }) =>
      originalConversations.some((original: { id: string }) => original.id === c.id),
    ),
  ).toEqual(originalConversations);
  expect(after[0].archived).not.toBe(true);
});

test('reselecting the computer preserves the draft and folders reuse ready CLI and model choices', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await chooseReasoning(page, 'High');
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft and its settings');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  const calls = await page.evaluate(() => (window as any).cliCalls);
  await page.evaluate(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await picker('Computer').click();
  await page.getByRole('option', { name: 'Desktop', exact: true }).click();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(picker('Model').locator('.selected-name')).toHaveText('GPT-6 Astra');
  await expect(picker('Reasoning')).toHaveText('High');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep this draft and its settings',
  );
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await picker('Folder').click();
  await page.getByRole('option', { name: 'studio', exact: true }).click();
  expect(await page.evaluate(() => (window as any).cliCalls)).toEqual(calls);
  await picker('Folder').click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path', exact: true }).click();
  await page.getByLabel('Folder path', { exact: true }).fill('C:\\Projects\\second');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\second');
  await expect(picker('Agent')).toBeEnabled();
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-5.6 Sol', exact: true }).click();
  await expect(picker('Reasoning')).toHaveText('Low');
  expect(
    await page.evaluate(() =>
      (window as any).cliCalls.filter((c: any) => c.command !== 'list_folders'),
    ),
  ).toEqual(calls.filter((c: any) => c.command !== 'list_folders'));
});

test('cold CLI checks and model requests do not block folder selection or overwrite user choices', async ({
  page,
}) => {
  await mockDesktop(page);
  // Discovery now starts at launch, so hold requests before the first navigation.
  await page.addInitScript(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli
          ?.filter((r: any) => r.command === 'detect_connection')
          .map((r: any) => r.provider)
          .sort(),
      ),
    )
    .toEqual(['claude', 'codex', 'gemini']);
  await expect(picker('Model')).toBeEnabled();
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await picker('Model').click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  await chooseReasoning(page, 'High');
  await page.getByLabel('Message', { exact: true }).fill('Wait for availability before sending');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).pendingCli.filter((r: any) => r.command === 'list_models'),
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli.filter(
      (r: any) => r.command === 'detect_connection',
    ))
      request.resolve();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli?.some(
          (r: any) => r.command === 'list_models' && r.provider === 'claude',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli) request.resolve();
  });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(picker('Agent')).toHaveText('Claude');
  await expect(picker('Model')).toHaveText('Sonnet');
  await expect(picker('Reasoning')).toHaveText('High');
  await picker('Model').click();
  await expect(page.getByRole('option', { name: 'GPT-6 Astra', exact: true })).toHaveCount(0);
  await picker('Model').press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('a pending environment uses its own model catalog and late checks cannot change a newer folder', async ({
  page,
}) => {
  await mockDesktop(page, 'locations');
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await page.evaluate(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await picker('Folder').click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(picker('Folder environment')).toHaveText('WSL · Ubuntu');
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker('Folder')).toHaveAttribute('title', '/home/test/studio');
  await picker('Model').click();
  // The saved model remains available, but another connection's catalog is never reused.
  await expect(page.getByRole('option', { name: 'gpt-6-astra', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'GPT-5.6 Sol', exact: true })).toHaveCount(0);
  await picker('Model').press('Escape');
  // Ubuntu's Codex is the Desktop account that joined it at startup, and loads its own catalog.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli
          ?.filter((r: any) => r.command === 'list_models')
          .map((r: any) => r.provider)
          .sort(),
      ),
    )
    .toEqual(['codex']);
  // Ubuntu has no Claude CLI, so no Claude account is offered there.
  await picker('Agent').click();
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await picker('Agent').press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('Keep my explicit choice');
  await pick(page, 'Computer', 'Desktop');
  await picker('Folder').click();
  await page
    .getByRole('option', { name: 'studio', exact: true })
    .filter({ hasText: 'Windows' })
    .click();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(picker('Model').locator('.selected-name')).toHaveText('GPT-6 Astra');
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli) request.resolve();
  });
  await expect(picker('Model')).toBeEnabled();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(picker('Agent')).toHaveText('Codex');
  await expect(picker('Model').locator('.selected-name')).toHaveText('GPT-6 Astra');
});

test('a WSL folder chosen on Desktop runs inside its distribution, and older Desktop chats keep their CLI', async ({
  page,
}) => {
  await mockDesktop(page, 'computer-routing');
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await pick(page, 'Folder environment', 'WSL · Ubuntu');
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // As the Claude app does, the distribution runs a chat in its own folder with its own CLI.
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await page.getByLabel('Message', { exact: true }).fill('Run inside the WSL project');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.agent.provider).toBe('codex');
  expect(request.location).toMatchObject({
    environmentId: '33333333-3333-4333-8333-333333333333',
    path: '/home/test/studio',
  });
  expect(request.location.executionEnvironmentId).toBeUndefined();
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  const provider = (accountId: string) =>
    saved.fleet.accounts.find((a: any) => a.id === accountId)?.provider;
  expect(
    saved.fleet.connections.find((c: any) => c.id === saved.conversations[0].settings.connectionId)
      .environmentId,
  ).toBe('33333333-3333-4333-8333-333333333333');
  // A chat an earlier release ran from Desktop in that folder keeps Desktop and its Windows CLI.
  const windowsCodex = saved.fleet.connections.find(
    (c: any) =>
      c.environmentId === '11111111-1111-4111-8111-111111111111' && provider(c.accountId) === 'codex',
  );
  await page.evaluate((connectionId) => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const chat = workspace.conversations[0];
    chat.location.executionEnvironmentId = '11111111-1111-4111-8111-111111111111';
    chat.settings.connectionId = connectionId;
    for (const message of chat.messages)
      if (message.settings) message.settings.connectionId = connectionId;
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  }, windowsCodex.id);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Run inside the WSL project', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await page.getByLabel('Message', { exact: true }).fill('Keep going from Desktop');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const older = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(older.location).toMatchObject({
    environmentId: '33333333-3333-4333-8333-333333333333',
    executionEnvironmentId: '11111111-1111-4111-8111-111111111111',
    path: '/home/test/studio',
  });
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].settings.connectionId).toBe(windowsCodex.id);
  // A new chat started from that older chat's folder runs inside the distribution.
  await page
    .getByRole('button', { name: 'New conversation in studio on Desktop', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByLabel('Message', { exact: true }).fill('A new chat in the same folder');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const fresh = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(fresh.location).toMatchObject({
    environmentId: '33333333-3333-4333-8333-333333333333',
    path: '/home/test/studio',
  });
  expect(fresh.location.executionEnvironmentId).toBeUndefined();
});

test('a WSL computer without installed CLIs has an empty Agent dropdown', async ({ page }) => {
  await mockDesktop(page, 'wsl-empty');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await pick(page, 'Computer', 'WSL · Ubuntu');
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(agent).toHaveText('No agents');
  await chooseTestFolder(page);
  await expect(page.locator('.setup-hint')).toContainText('Claude needs to be set up.');
  await expect(agent).toHaveText('No agents');
  await agent.click();
  await expect(page.locator('.picker-popover:popover-open')).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(1);
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(agent).not.toHaveAttribute('aria-activedescendant');
  await page.screenshot({ path: 'artifacts/empty-agent-browser.png' });
  await agent.press('ArrowDown');
  await agent.press('Enter');
  await expect(agent).toHaveText('No agents');
  await agent.press('Escape');
  await expect(agent).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await pick(page, 'Computer', 'Desktop');
  await chooseTestFolder(page);
  await expect(agent).toHaveText('Claude');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('WSL uses only its Linux CLI and keeps Desktop accounts out of the agent picker', async ({
  page,
}) => {
  await mockDesktop(page, 'computer-routing');
  await page.goto('/');
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await chooseTestFolder(page);
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('Use the Linux agent');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  const chat = saved.conversations[0];
  expect(
    saved.fleet.connections.find((c: any) => c.id === chat.settings.connectionId).environmentId,
  ).toBe('33333333-3333-4333-8333-333333333333');
  expect(chat.location.executionEnvironmentId).toBeUndefined();
  await page.getByLabel('Search conversations').fill('WSL · Ubuntu');
  await expect(page.locator('.conversation-item')).toHaveCount(1);
  // A saved chat keeps its fixed agent when that computer later loses the CLI.
  await page.evaluate(() => localStorage.setItem('test-wsl-missing', 'true'));
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: 'Use the Linux agent', exact: true }).click();
  await expect(page.locator('.setup-hint')).toContainText('Codex needs to be set up.');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page
    .getByRole('article', { name: 'Desktop computer', exact: true })
    .getByRole('article', { name: 'Claude connections', exact: true })
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Claude');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Standalone',
  );
});

test('switching computer clears the folder and an offline host never falls back to local CLIs', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    workspace.fleet.computers.push({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Travel laptop',
    });
    workspace.fleet.environments.push({
      id: '55555555-5555-4555-8555-555555555555',
      computerId: '44444444-4444-4444-8444-444444444444',
      name: 'Linux',
      platform: 'linux',
    });
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: 'Travel Codex',
      provider: 'codex',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: '55555555-5555-4555-8555-555555555555',
      profile: 'existing',
    });
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Offline project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      location: {
        computerId: '44444444-4444-4444-8444-444444444444',
        environmentId: '55555555-5555-4555-8555-555555555555',
        path: '/home/test/studio',
      },
      settings: { provider: 'codex', connectionId, model: '', reasoning: '', instructions: '' },
      messages: [],
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Offline project', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this offline draft in history');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
          (c: any) => c.title === 'Offline project',
        ).archived,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: 'Travel laptop', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Standalone',
  );
  await page.getByLabel('Message', { exact: true }).fill('Do not run locally');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('relay');
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeDisabled();
  await page.getByRole('dialog').press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: 'Desktop', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'studio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: 'New conversation in studio on Travel laptop', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'Travel laptop',
  );
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft on the offline laptop');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('skills, web searches, and child agents keep progress, results, and saved history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect this fixture');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  const tool = (id: string, category: string, name: string, extra = {}) => ({
    kind: 'tool',
    tool: { id, category, name, revision: 1, status: 'running', sources: [], agents: [], ...extra },
  });
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit(tool('skill', 'skill', 'Skill: capability-check'));
  await emit(tool('web1', 'search', 'Web search', { query: 'IANA example domains' }));
  await emit(tool('web2', 'search', 'Web search', { query: 'IANA example domains' }));
  await emit(
    tool('agents', 'agent', 'Sub-agents', {
      agents: [
        { id: 'child1', name: 'Fixture reader', task: 'Read the marker', status: 'running' },
        { id: 'child2', name: 'Source checker', task: 'Check the source', status: 'running' },
      ],
    }),
  );
  await emit(tool('read', 'tool', 'Read', { parentId: 'child1' }));
  // Running calls have rows of their own, which open like calls; a sub-agent's row opens its
  // conversation beside the chat.
  await page.locator('[data-category="agent"] > summary').click();
  await expect(page.locator('[data-category="search"]')).toHaveCount(2);
  await page.getByRole('button', { name: /Fixture reader/ }).click();
  const reader = page.getByRole('dialog', { name: 'Fixture reader' });
  await expect(reader).toContainText('Read the marker');
  await expect(reader.locator('.live-row')).toContainText('Read');
  await page.screenshot({ path: 'artifacts/capabilities-running-browser.png' });
  await emit(
    tool('skill', 'skill', 'Skill: capability-check', { revision: 2, status: 'complete' }),
  );
  await emit(
    tool('web1', 'search', 'Web search', {
      revision: 3,
      status: 'complete',
      query: 'IANA example domains',
      sources: [
        { title: 'IANA example domains', url: 'https://www.iana.org/domains/example' },
        { title: 'Unsafe', url: 'javascript:alert(1)' },
      ],
    }),
  );
  await emit(tool('web1', 'search', 'Web search', { revision: 2 }));
  await emit(
    tool('web2', 'search', 'Web search', {
      revision: 2,
      status: 'error',
      query: 'IANA example domains',
      detail: 'Search unavailable',
    }),
  );
  await emit(
    tool('agents', 'agent', 'Sub-agents', {
      revision: 2,
      status: 'error',
      agents: [
        {
          id: 'child1',
          name: 'Fixture reader',
          status: 'complete',
          result: 'Marker verified <script>window.pwned=true</script>',
        },
        { id: 'child2', name: 'Source checker', status: 'error', result: 'Source unavailable' },
      ],
    }),
  );
  await emit(tool('read', 'tool', 'Read', { parentId: 'child1', revision: 2, status: 'complete' }));
  await emit({ kind: 'text', text: 'The fixture was checked.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.chat-scroll .activity-group > summary').click();
  const searches = page.locator('[data-category="search"]');
  await expect(searches.first()).toContainText('Completed');
  await searches.first().locator(':scope > summary').click();
  await expect(searches.first().getByRole('link', { name: 'IANA example domains' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
  // Sub-agents are rows of their group; the result closes each one's conversation.
  await page.locator('.subagent-row', { hasText: 'Fixture reader' }).click();
  await expect(reader.getByRole('region', { name: 'Result' })).toHaveText('Marker verified');
  await expect(reader.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await page.screenshot({ path: 'artifacts/capabilities-complete-browser.png' });
  await reader.getByRole('button', { name: 'Close sub-agent' }).click();
  await page.setViewportSize({ width: 880, height: 720 });
  expect(
    await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/capabilities-narrow-browser.png' });
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
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').click();
  await expect(page.locator('[data-category="search"]')).toHaveCount(2);
  await expect(page.locator('.subagent-row', { hasText: 'Source checker' })).toContainText(
    'Failed',
  );
});

test('tool targets stream inline and finish as expandable work history below the model title', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check the source files');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit({
    kind: 'progress',
    id: 'before',
    revision: 1,
    text: 'I will inspect the source files.',
  });
  const tools = [
    {
      id: 'read',
      name: 'Read',
      operation: 'read',
      path: '/fixture/src/app.ts',
      facts: [
        { label: 'Start line', value: '12' },
        { label: 'Lines read', value: '8' },
      ],
    },
    {
      id: 'glob',
      name: 'Find files',
      operation: 'glob',
      query: '**/*.svelte',
      path: '/fixture/src',
      facts: [
        { label: 'Files found', value: '2' },
        { label: 'Matching files', value: '/fixture/src/App.svelte\n/fixture/src/Menu.svelte' },
      ],
    },
    {
      id: 'find',
      name: 'Find tools',
      operation: 'toolSearch',
      query: 'select:WebSearch',
      facts: [{ label: 'Tools found', value: 'WebSearch' }],
    },
    {
      id: 'run',
      name: 'Run command',
      operation: 'command',
      commandRun: true,
      detail: 'Run the fixture tests',
      facts: [{ label: 'Exit code', value: '0' }],
    },
    { id: 'legacy', name: 'Legacy tool' },
  ];
  for (const [i, tool] of tools.entries()) {
    await emit({
      kind: 'tool',
      tool: { category: 'tool', revision: 1, status: 'running', sources: [], agents: [], ...tool },
    });
    if (i === 0)
      await emit({
        kind: 'progress',
        id: 'middle',
        revision: 1,
        text: 'The file is readable. I will find the components next.',
      });
  }
  await expect(page.locator('.activity-summary')).toHaveCount(0);
  await expect(page.getByText('Lines read', { exact: true })).not.toBeVisible();
  // Running calls show their targets inline, each in a row of its own that opens for details.
  const rows = page.locator('.live-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator(':scope > summary')).toContainText('Reading');
  await expect(rows.first().locator(':scope > summary')).toContainText('src/app.ts');
  await rows.first().locator(':scope > summary').click();
  await expect(page.locator('.live-activity')).toContainText('/fixture/src/app.ts');
  await expect(page.getByText('Lines read', { exact: true })).toBeVisible();
  expect(
    await page
      .locator('.activity-timeline')
      .evaluate((el) => [...el.children].map((e) => e.textContent)),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining('I will inspect'),
      expect.stringContaining('The file is readable'),
    ]),
  );
  const ordered = await page
    .locator('.activity-timeline')
    .evaluate((el) =>
      [...el.children]
        .filter((e) => !e.classList.contains('timeline-note'))
        .map((e) => e.textContent ?? ''),
    );
  expect(ordered[0]).toContain('I will inspect');
  expect(ordered[1]).toContain('/fixture/src/app.ts');
  expect(ordered[2]).toContain('The file is readable');
  const historySequence = () =>
    page
      .locator(
        '.activity-timeline > .progress-message, .activity-timeline .activity-group .tool-title',
      )
      .evaluateAll((elements) =>
        elements.map((el) => (el.querySelector('.tool-title') ?? el).textContent?.trim()),
      );
  // Groups render their calls when expanded, so compare with every group open.
  const openGroups = async () => {
    const closed = page.locator('.activity-group:not([open]) > summary');
    while (await closed.count()) await closed.first().click();
  };
  await page.screenshot({ path: 'artifacts/activity-inline-browser.png' });
  for (const tool of tools)
    await emit({
      kind: 'tool',
      tool: { category: 'tool', revision: 2, status: 'complete', sources: [], agents: [], ...tool },
    });
  await emit({
    kind: 'progress',
    id: 'final',
    revision: 1,
    text: 'The source files passed verification.',
  });
  // Finished calls fold into their groups once the agent moves on; the opened row waits for
  // the reader to close it.
  await expect(rows).toHaveCount(1);
  await rows.first().locator(':scope > summary').click();
  await expect(rows).toHaveCount(0);
  await openGroups();
  const liveSequence = await historySequence();
  // The last progress comment becomes the answer, which history shows below it.
  expect(liveSequence.pop()).toBe('The source files passed verification.');
  await emit({ kind: 'text', text: 'The source files passed verification.' });
  await emit({ kind: 'usage', input: 2400, output: 50, cachedInput: 1900, costUsd: 0.012345 });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  const usageSummary = page.getByLabel('Reply usage and cost', { exact: true });
  await expect(usageSummary.locator('.usage-summary > span')).toHaveCount(2);
  await expect(usageSummary).not.toContainText(/input|output|tokens|cost|\$/i);
  await expect(usageSummary).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.reply-usage')).toHaveCSS('font-size', '11px');
  await page.screenshot({ path: 'artifacts/work-history-placement.png' });
  await expect(
    page.locator(
      '.message[data-status="complete"] .message-heading + .tool-activity > .activity-summary',
    ),
  ).toHaveCount(1);
  expect(
    await page
      .locator('.reply-usage')
      .evaluate(
        (el) =>
          !!(
            el.compareDocumentPosition(document.querySelector('.activity-summary')!) &
            Node.DOCUMENT_POSITION_PRECEDING
          ),
      ),
  ).toBe(true);
  await usageSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Cached input tokens', { exact: true })).toBeVisible();
  await expect(page.getByText('Estimated cost (USD)', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.012345', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/reply-usage-expanded-browser.png' });
  await usageSummary.click();
  const summary = page.getByLabel('Work history', { exact: true });
  await expect(summary).toHaveText('Work history');
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await expect(
    page.getByText('The source files passed verification.', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText('I will inspect the source files.', { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({ path: 'artifacts/activity-summary-browser.png' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('I will inspect the source files.', { exact: true })).toBeVisible();
  await openGroups();
  expect(await historySequence()).toEqual(liveSequence);
  await expect(page.getByLabel('Filter activity')).toHaveCount(0);
  await expect(page.locator('.tool-card')).toHaveCount(5);
  await page
    .locator('.tool-card')
    .filter({ hasText: 'Run the fixture tests' })
    .locator(':scope > summary')
    .click();
  await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
  await page
    .locator('.tool-card')
    .filter({ hasText: 'Legacy tool' })
    .locator(':scope > summary')
    .click();
  await expect(page.getByText('No details recorded.', { exact: true })).toBeVisible();
  await page
    .locator('.tool-card')
    .filter({ hasText: 'select:WebSearch' })
    .locator(':scope > summary')
    .click();
  await expect(page.getByText('Tools found', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 880, height: 720 });
  expect(
    await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/activity-details-narrow-browser.png' });
  await usageSummary.click();
  expect(
    await page.locator('.reply-usage').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/reply-usage-narrow-browser.png' });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await expect(summary).toHaveText('Work history');
  await expect(usageSummary.locator('.usage-summary > span')).toHaveCount(2);
  await expect(usageSummary).not.toContainText(/input|output|tokens|cost|\$/i);
  await expect(usageSummary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  await openGroups();
  expect(await historySequence()).toEqual(liveSequence);
  await expect(
    page.getByText('The file is readable. I will find the components next.', { exact: true }),
  ).toBeVisible();
  await usageSummary.click();
  await expect(page.getByText('$0.012345', { exact: true })).toBeVisible();
});

test('total AI time accumulates saved replies in this conversation and survives reload', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Cumulative time fixture');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Time fixture.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!).conversations[0]?.messages.at(-1)
        ?.status === 'complete',
  );
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const conversation = workspace.conversations[0];
    const original = conversation.messages.at(-1);
    const message = (text: string, status: string, durationMs?: number) => ({
      ...original,
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      blocks: [{ type: 'markdown', text }],
      status,
      durationMs,
    });
    conversation.messages = [
      message('First timed reply', 'complete', 1250),
      { ...message('User waiting time', 'complete', 999999), role: 'user' },
      message('Stopped timed reply', 'cancelled', 61250),
      message('Legacy untimed reply', 'error'),
      message('Recorded zero reply', 'complete', 0),
    ];
    workspace.conversations.push({
      ...conversation,
      id: crypto.randomUUID(),
      title: 'Other time fixture',
      messages: [message('Other conversation reply', 'complete', 999999)],
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Cumulative time fixture', exact: true }).click();
  const totals = page.locator('.usage-toggle');
  const elapsed = (index: number) => totals.nth(index).locator('.usage-summary > span').first();
  await expect(elapsed(0)).toHaveText('1.3s');
  await expect(totals.nth(0)).toContainText('1.3s total');
  await expect(elapsed(1)).toHaveText('1m 1s');
  await expect(totals.nth(1)).toContainText('1m 3s total');
  await expect(totals.nth(2)).toContainText('≥ 1m 3s total');
  await expect(totals.nth(2)).toContainText('Time not recorded');
  await expect(totals.nth(3)).toContainText('≥ 1m 3s total');
  await totals.last().click();
  await expect(page.getByText('Total AI time', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.reply-usage').last()).toContainText('Timing is missing for 1 reply');
  await page.setViewportSize({ width: 880, height: 900 });
  expect(
    await page
      .locator('.reply-usage')
      .last()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/reply-time-total-narrow-browser.png' });

  await page.evaluate(() => {
    (window as any).emitCapability = null;
  });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Next timed reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await expect(totals).toHaveCount(4);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Next timed reply complete.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(totals).toHaveCount(5);
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!)
        .conversations.find((c: any) => c.title === 'Cumulative time fixture')
        .messages.at(-1)?.status === 'complete',
  );
  const durations = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!)
        .conversations.find((c: any) => c.title === 'Cumulative time fixture')
        .messages.at(-1).durationMs,
  );
  const seconds = Math.round((62500 + durations) / 1000);
  const expected = `≥ ${Math.floor(seconds / 60)}m ${seconds % 60}s total`;
  await expect(totals.last()).toContainText(expected);
  await expect(totals.first()).toContainText('1.3s total');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Cumulative time fixture', exact: true }).click();
  await expect(totals.last()).toContainText(expected);
});

test('reply cost distinguishes unreported, zero, and tiny values', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  for (const [costUsd, expected] of [
    [undefined, 'Not reported'],
    [0, '$0.00'],
    [0.0000001, '<$0.000001'],
  ] as const) {
    await page.evaluate(() => {
      (window as any).emitCapability = null;
    });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check reply cost');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.message[data-status="running"]')).toHaveCount(1);
    await page.waitForFunction(() => !!(window as any).emitCapability);
    await page.evaluate((costUsd) => {
      (window as any).emitCapability({ kind: 'text', text: 'Cost fixture complete.' });
      (window as any).emitCapability({ kind: 'usage', input: 0, output: 0, costUsd });
      (window as any).finishCapabilities('complete');
    }, costUsd);
    const reply = page.getByTestId('message').last();
    await expect(reply).toHaveAttribute('data-status', 'complete');
    await expect(
      reply.getByLabel('Reply usage and cost').locator('.usage-summary > span'),
    ).toHaveCount(2);
    await expect(reply.getByLabel('Reply usage and cost')).not.toContainText(
      /input|output|tokens|cost|\$/i,
    );
    await reply.getByLabel('Reply usage and cost').click();
    await expect(reply.getByText('Estimated cost (USD)', { exact: true })).toBeVisible();
    await expect(
      reply
        .locator('.usage-breakdown dl > div')
        .filter({ hasText: 'Estimated cost (USD)' })
        .locator('dd'),
    ).toHaveText(expected);
  }
});

test('skill selection adds to the draft and stopped tools never appear to keep running', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await page.getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByRole('button', { name: 'Use skill test-skill' })).toBeDisabled();
  await page.evaluate(() => ((window as any).enableSkill = true));
  await page.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(page.getByRole('button', { name: 'Use skill test-skill' })).toBeEnabled();
  await page.getByRole('button', { name: 'Use skill test-skill' }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toContainText('');
  await expect(composer).toHaveValue(/Use the skill "test-skill".*\n\nKeep my draft/);
  await expect(composer).toBeFocused();
  await expect(page.locator('.tool-activity')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 's',
        revision: 1,
        category: 'search',
        name: 'Web search',
        status: 'running',
        sources: [],
        agents: [],
      },
    }),
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('.tool-activity')).toContainText('Stopped');
  await expect(page.locator('.tool-activity')).not.toContainText('Running');
});

test('model context shows scoped sources, filters, refresh failures, and preserves the chat draft', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Use project conventions <script>literal</script>');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await expect(dialog.getByText('CLAUDE.md', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Reported', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Discovered', { exact: true })).toBeVisible();
  const request = await page.evaluate(() => (window as any).contextCalls.at(-1));
  expect(request.location.path).toBe('C:\\Projects\\studio');
  expect(request.connectionId).toBeTruthy();
  expect(request).not.toHaveProperty('instructions');
  await dialog.getByText('Conversation instructions', { exact: false }).click();
  await expect(dialog.locator('pre')).toHaveText(
    'Use project conventions <script>literal</script>',
  );
  await expect(dialog.locator('script')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/context-instructions-browser.png' });
  await dialog.getByRole('button', { name: /^Skills/ }).click();
  await expect(dialog.getByText('test-skill', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Disabled', { exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Filter context sources' }).fill('no-match');
  await expect(dialog).toContainText('No sources match this filter.');
  await dialog.getByRole('button', { name: /^Memories/ }).click();
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: /^MCPs/ }).click();
  await expect(dialog.getByText('docs-mcp', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Copy path/ })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/context-mcps-browser.png' });
  await dialog.getByRole('textbox', { name: 'Filter context sources' }).fill('disabled');
  await expect(dialog.getByText('docs-mcp', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('disabled-mcp', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [/^Instructions/, /^Skills/, /^Memories/, /^MCPs/]) {
    await expect(dialog.getByRole('button', { name })).toBeVisible();
  }
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/context-mcps-mobile.png' });
  await dialog.getByRole('button', { name: /^Memories/ }).click();
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({ path: 'artifacts/context-memories-narrow-browser.png' });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.evaluate(() => ((window as any).failContext = true));
  await dialog.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Context is unavailable');
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('Showing last saved result');
  await page.evaluate(() => ((window as any).failContext = false));
  await dialog.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Model context', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep this draft',
  );
});

test('a late context query cannot replace a newly selected model inspection', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.evaluate(() => ((window as any).holdContext = true));
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Inspecting the selected CLI profile');
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseContext)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Opus', exact: true }).click();
  await page.evaluate(() => ((window as any).holdContext = false));
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Opus');
  await expect(page.getByRole('dialog').getByText('CLAUDE.md', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).releaseContext());
  await expect(page.getByRole('dialog')).toContainText('Opus');
  expect(await page.evaluate(() => (window as any).contextCalls.at(-1).model)).toBe('opus');
});

test('reopening model context shows cached data while one shared refresh completes', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const open = page.getByRole('button', { name: 'Model context', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await open.click();
  await expect(dialog).toContainText('Revision 0.');
  await expect(dialog.getByRole('button', { name: 'Refresh model context' })).toBeEnabled();
  const checked = await dialog.locator('footer > span').textContent();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (window as any).holdContext = true;
    (window as any).contextRevision = 1;
  });
  await open.click();
  await expect(dialog).toContainText('Revision 0.');
  await expect(dialog).toContainText('Updating…');
  await expect(dialog).not.toContainText('Inspecting the selected CLI profile');
  await expect(dialog.locator('footer > span')).toContainText(checked!);
  await expect.poll(() => page.evaluate(() => (window as any).contextCalls.length)).toBe(2);
  await page.screenshot({ path: 'artifacts/context-cached-refresh-browser.png' });
  await dialog.getByRole('button', { name: /^Skills/ }).click();
  await expect(dialog.getByText('test-skill', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await open.click();
  await expect(dialog).toContainText('Updating…');
  await expect(dialog).toContainText('Revision 0.');
  expect(await page.evaluate(() => (window as any).contextCalls.length)).toBe(2);
  await page.evaluate(() => {
    (window as any).holdContext = false;
    (window as any).releaseContext();
  });
  await expect(dialog).toContainText('Revision 1.');
  await expect(dialog).not.toContainText('Updating…');
  await page.keyboard.press('Escape');
  await page.evaluate(() => ((window as any).holdContext = true));
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await open.click();
  await expect(dialog).toContainText('Inspecting the selected CLI profile');
  await expect(dialog).not.toContainText('Revision 1.');
  await expect.poll(() => page.evaluate(() => (window as any).contextCalls.length)).toBe(3);
  await page.evaluate(() => (window as any).releaseContext());
  await expect(dialog).toContainText('Revision 1.');
});

test('an existing chat can switch to another account of the same agent between replies', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await page.getByLabel('Message', { exact: true }).fill('First account reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(first.accountSwitch).toBeUndefined();
  for (const name of ['Computer', 'Folder'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveAttribute('title', /Another account applies.*Full access/);
  await page.getByLabel('Message', { exact: true }).fill('Draft kept across the switch');
  await agent.click();
  await expect(page.getByRole('option')).toHaveText([
    /Claude · Claude CLI login/,
    /Claude · Second Claude/,
  ]);
  await page.getByRole('option', { name: 'Claude · Second Claude', exact: true }).click();
  await expect(agent).toContainText('Second Claude');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    /Next message: Second Claude account/,
  );
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Draft kept across the switch',
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const second = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request')!),
  );
  expect(second.accountSwitch).toBe(true);
  expect(second.agent.provider).toBe('claude');
  expect(second.agent.connectionId).not.toBe(first.agent.connectionId);
  expect(second.location).toEqual(first.location);
  expect(second.messages).toHaveLength(3);
  await expect(page.locator('.reply-switch')).toHaveText(['Switched to Second Claude account']);
  await expect(page.locator('.next-reply-settings')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'First account reply', exact: true }).click();
  await expect(page.locator('.reply-switch')).toHaveText(['Switched to Second Claude account']);
  await expect(agent).toContainText('Second Claude');
  for (const name of ['Computer', 'Folder'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    /Next message: Claude CLI login account/,
  );
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
      (c: any) => c.title === 'First account reply',
    ),
  );
  expect(saved.messages[1].settings.connectionId).toBe(first.agent.connectionId);
  expect(saved.messages[3].settings.connectionId).toBe(second.agent.connectionId);
  expect(saved.settings.connectionId).toBe(first.agent.connectionId);
});

test('an account chosen while a reply runs takes the next message, queued meanwhile', async ({
  page,
}) => {
  await mockDesktop(page, 'settings-deferred');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const secondId = await page.evaluate(() => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === 'Second Claude');
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  });
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await pick(page, 'Model', 'Sonnet');
  await chooseReasoning(page, 'Low');
  await page.getByLabel('Message', { exact: true }).fill('Started on the first account');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  // Like the model and reasoning, the account may change for the next message.
  for (const name of ['Computer', 'Folder'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveAttribute('title', /Another account applies/);
  await pick(page, 'Agent', 'Claude · Second Claude');
  await expect(agent).toContainText('Second Claude');
  const next = page.locator('.next-reply-settings');
  await expect(next).toHaveText('Next message: Second Claude account');
  await pick(page, 'Model', 'Opus');
  await chooseReasoning(page, 'High');
  await expect(next).toHaveText('Next message: Second Claude account · Opus · High reasoning');
  // Back on the running reply's account, only the model and reasoning change.
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  await expect(next).toHaveText('Next message: Opus · High reasoning');
  await pick(page, 'Agent', 'Claude · Second Claude');
  await expect(next).toHaveText('Next message: Second Claude account · Opus · High reasoning');
  await page.screenshot({ path: 'artifacts/account-switch-while-running.png' });
  // The running reply keeps the account it started with.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const chat = JSON.parse(localStorage.getItem('test-workspace')!).conversations[0];
        return [chat.messages[1].settings.connectionId, chat.settings.connectionId];
      }),
    )
    .toEqual([first.agent.connectionId, secondId]);
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'running');
  // A message written meanwhile waits for the reply, then goes to the account chosen.
  await page.getByLabel('Message', { exact: true }).fill('Queued for the second account');
  await page.getByRole('button', { name: 'Queue message' }).click();
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('Queued for the second account')).toBeVisible();
  await page.evaluate(() => (window as any).finishReply());
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  const second = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(second.agent).toMatchObject({
    provider: 'claude',
    connectionId: secondId,
    model: 'opus',
    reasoning: 'high',
  });
  expect(second.accountSwitch).toBe(true);
  expect(second.messages).toHaveLength(3);
  expect(second.messages[2]).toMatchObject({ role: 'user', text: 'Queued for the second account' });
  await expect(queue).toHaveCount(0);
  await expect(page.locator('.reply-switch')).toHaveText([
    'Switched to Second Claude account · Opus · High reasoning',
  ]);
  await expect(next).toHaveCount(0);
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.map(
          (m: { settings?: { connectionId?: string } }) => m.settings?.connectionId ?? null,
        ),
      ),
    )
    .toEqual([null, first.agent.connectionId, null, secondId]);
});

test('a removed terminal login is not added again while another account of its agent stays connected', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    localStorage.setItem('test-account-claude', 'person@example.com');
    localStorage.setItem('test-account-isolated-claude', 'person@example.com');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Claude' }) });
  await expect(card).toContainText('Claude CLI login');
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('vinporb');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('vinporb');
  await card
    .locator('.fleet-account')
    .filter({ has: page.getByRole('heading', { name: 'Claude CLI login', exact: true }) })
    .getByRole('button', { name: 'Manage account' })
    .click();
  const management = page.getByRole('dialog', { name: 'Manage account', exact: true });
  await management.getByRole('button', { name: 'Disconnect account' }).click();
  await management.getByRole('button', { name: 'Remove connection' }).click();
  await expect(management).toHaveCount(0);
  await expect(card).not.toContainText('Claude CLI login');
  // The terminal login reports the same account as the separate profile: nothing is re-added.
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(card).toContainText('vinporb');
  await expect(card).not.toContainText('Claude CLI login');
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(card).toContainText('vinporb');
  await expect(card).not.toContainText('Claude CLI login');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  // A single remaining Claude connection is offered as the plain agent choice.
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /Claude · / })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const claudeLabels = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem('test-workspace')!)
        .fleet.accounts.filter((a: any) => a.provider === 'claude')
        .map((a: any) => a.name),
    );
  expect(await claudeLabels()).toEqual(['Claude CLI login', 'vinporb']);
  // Nor whatever the terminal reports later: signed out, as an expired login is, while vinporb
  // stays signed in, or signed into another account.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Refresh connections', exact: true });
  for (const terminal of [{ auth: 'login' }, { account: 'other@example.com' }]) {
    await page.evaluate((terminal) => {
      const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
      const vinporb = fleet.accounts.find((a: any) => a.name === 'vinporb');
      const profile = fleet.connections.find((c: any) => c.accountId === vinporb.id);
      localStorage.setItem(`test-auth-connection-${profile.id}`, 'ready');
      if (terminal.auth) localStorage.setItem('test-auth-claude', terminal.auth);
      else localStorage.removeItem('test-auth-claude');
      if (terminal.account) localStorage.setItem('test-account-claude', terminal.account);
      else localStorage.removeItem('test-account-claude');
      // Held account checks keep the refresh below running until it is seen.
      (window as any).holdCli = ['detect_connection'];
    }, terminal);
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => {
      const state = window as any;
      state.holdCli = [];
      for (const request of (state.pendingCli ?? []).splice(0)) request.resolve();
    });
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await expect(card).toContainText('vinporb');
    await expect(card).not.toContainText('Claude CLI login');
  }
  expect(await claudeLabels()).toEqual(['Claude CLI login', 'vinporb']);
});

test('a terminal login can become a separate profile for the same account without being re-added', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Codex' }) });
  await card
    .locator('.fleet-account')
    .filter({ has: page.getByRole('heading', { name: 'Codex CLI login', exact: true }) })
    .getByRole('button', { name: 'Manage account' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Manage account', exact: true });
  await expect(dialog).toContainText('Existing CLI login');
  const source = dialog.getByRole('combobox', { name: 'Shared context source' });
  await expect(source).toHaveText('This computer’s CLI context');
  await source.click();
  await page.getByRole('option', { name: 'This account only', exact: true }).click();
  await expect(dialog).toContainText('creates a separate profile');
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-sign-in-provider'))).toBe('codex');
  const connection = () =>
    page.evaluate(() => {
      const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
      const account = fleet.accounts.find(
        (a: any) => a.provider === 'codex' && a.name === 'Codex CLI login',
      );
      return {
        labels: fleet.accounts.filter((a: any) => a.provider === 'codex').map((a: any) => a.name),
        connections: fleet.connections.filter((c: any) => c.accountId === account.id),
      };
    });
  const converted = await connection();
  expect(converted.connections).toHaveLength(1);
  expect(converted.connections[0]).toMatchObject({
    profile: 'isolated',
    sharedContext: 'none',
    fromTerminalLogin: true,
  });
  // A refresh must not register the terminal login again as another label.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(card.locator('.fleet-account')).toHaveCount(1);
  const after = await connection();
  expect(after.labels.filter((name: string) => name === 'Codex CLI login')).toHaveLength(1);
  expect(after.connections).toHaveLength(1);
  await card.getByRole('button', { name: 'Manage account' }).click();
  await expect(dialog).toContainText('Separate CLI profile');
  await expect(dialog.getByRole('combobox', { name: 'Shared context source' })).toHaveText(
    'This account only',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
