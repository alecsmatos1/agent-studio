import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function conversation(page: Page) {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const original = native.invoke;
    native.invoke = async (command: string, args: any) => {
      if (command === 'undo_files') {
        const w = window as any;
        (w.undoCalls ??= []).push(args);
        if (w.undoConflict)
          throw new Error('example.txt has changed since this response. Undo was not applied.');
        return { files: ['example.txt'], undone: args.commit };
      }
      if (
        (command === 'save_workspace' || command === 'save_workspace_patch') &&
        (window as any).saveFailure
      )
        throw new Error('Disk full');
      return original(command, args);
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  for (const prompt of ['First prompt', 'Second prompt']) {
    await input.fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  }
  await expect(page.locator('.message')).toHaveCount(4);
  return input;
}

test('Rewind here returns its message to the composer at once, and Undo rewind takes it back', async ({
  page,
}) => {
  const input = await conversation(page);
  await input.fill('Keep my draft');
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  // The clicked message is the one to return to, so nothing asks which.
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toHaveValue('Second prompt\n\nKeep my draft');
  await expect(input).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Conversation rewound' })).toContainText(
    'files unchanged',
  );
  await page.screenshot({ path: 'artifacts/rewind/rewound-desktop.png' });
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  // Undo rewind takes the message, as it was returned, back out of the composer.
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('Keep my draft');
  // Rewinding further back replaces a returned message left as it was.
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(input).toHaveValue('Second prompt\n\nKeep my draft');
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(input).toHaveValue('First prompt\n\nKeep my draft');
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('Keep my draft');
  // An edited message stays when the rewind is undone.
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await input.fill('Second prompt, edited');
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('Second prompt, edited');
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
});

test('a rewind is saved with its returned message, can be undone after reload, and replaces discarded native context', async ({
  page,
}) => {
  const input = await conversation(page);
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(input).toHaveValue('Second prompt');
  // The returned message is the conversation's draft, which a reload keeps.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('test-drafts') ?? ''))
    .toContain('Second prompt');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(input).toHaveValue('Second prompt');
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
  await input.fill('');
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(input).toHaveValue('Second prompt');
  await input.fill('Replacement prompt');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.historyRevision).toBe(3);
  expect(request.messages.map((m: any) => m.text)).not.toContain('Second prompt');
  expect(request.messages.at(-1).text).toBe('Replacement prompt');
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toHaveCount(0);
  // The host forks the native session after the reply it kept, which only this send asks for.
  expect(request.rewound).toBe(true);
  expect(request.lastReply.runId).toEqual(expect.any(String));
  await input.fill('A later prompt');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const later = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(later.messages.at(-1).text).toBe('A later prompt');
  expect(later.rewound).toBeUndefined();
  expect(later.lastReply.runId).not.toBe(request.lastReply.runId);
});

test('rewind handles the first message, storage failure, slash commands, and phone layout', async ({
  page,
}) => {
  const input = await conversation(page);
  // A rewind that cannot be saved leaves the chat and the composer as they were.
  await input.fill('Keep my draft');
  await page.evaluate(() => ((window as any).saveFailure = true));
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.locator('.composer-area').getByRole('alert')).toContainText('Disk full');
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('Keep my draft');
  await page.evaluate(() => ((window as any).saveFailure = false));
  await page.setViewportSize({ width: 390, height: 844 });
  // /rewind asks which message, since none was clicked.
  await input.fill('/rewind');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('will be set aside; files unchanged');
  await page.getByRole('combobox', { name: 'Rewind to message' }).click();
  await page.getByRole('option', { name: /1. First prompt/ }).click();
  await expect(page.getByRole('button', { name: 'Rewind', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/rewind/mobile-dialog.png' });
  await page.evaluate(() => ((window as any).saveFailure = true));
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Disk full');
  await expect(page.locator('.message')).toHaveCount(4);
  await expect(input).toHaveValue('');
  await page.evaluate(() => ((window as any).saveFailure = false));
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(input).toHaveValue('First prompt');
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/rewind/rewound-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a rewound message brings its images back to the composer and sends them again', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await page.getByLabel('Image files').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await input.fill('Describe this');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // The Stop button is also absent before a reply starts, so wait for the reply itself.
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const sent = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-last-request')!).messages[0].images,
  );
  expect(sent).toHaveLength(1);
  await page.getByRole('button', { name: 'Rewind here' }).click();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(input).toHaveValue('Describe this');
  // Its bytes were read back from this computer's image store.
  await expect(page.getByRole('button', { name: 'Remove pixel.png' })).toBeVisible();
  await expect(page.getByLabel('Attached images').getByRole('img', { name: 'pixel.png' })).toHaveJSProperty(
    'naturalWidth',
    1,
  );
  expect(await page.evaluate(() => (window as any).chatImageReads)).toEqual([sent[0].hash]);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.map((m: any) => m.text)).toEqual(['Describe this']);
  expect(request.messages[0].images).toEqual([{ ...sent[0], id: expect.any(String) }]);
  expect(request.messages[0].images[0].id).not.toBe(sent[0].id);
  await expect(page.getByRole('button', { name: 'Remove pixel.png' })).toHaveCount(0);
});

test('Undo previews host files, requires confirmation, and keeps changed files and history intact on failure', async ({
  page,
}) => {
  await conversation(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    workspace.conversations[0].messages.at(-1).fileChanges = {
      revision: 1,
      limited: false,
      edits: [
        {
          id: 'edit',
          files: [
            {
              path: 'example.txt',
              kind: 'modified',
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ['-before', '+after'],
                },
              ],
            },
          ],
        },
      ],
    };
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'Undo edits', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('example.txt');
  expect(await page.evaluate(() => (window as any).undoCalls.map((c: any) => c.commit))).toEqual([
    false,
  ]);
  await page.screenshot({ path: 'artifacts/rewind/undo-desktop.png' });
  await page.evaluate(() => ((window as any).undoConflict = true));
  await dialog.getByRole('button', { name: 'Undo edits', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('has changed');
  await expect(page.locator('.message')).toHaveCount(4);
  await page.evaluate(() => ((window as any).undoConflict = false));
  await dialog.getByRole('button', { name: 'Undo edits', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('File edits undone', { exact: true })).toBeVisible();
  const workspace = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(workspace.conversations[0].messages.at(-1).filesUndone).toBe(true);
  expect(workspace.conversations[0].historyRevision).toBe(1);
});

test('a retry after rewinding ends Undo rewind so removed messages cannot return out of order', async ({
  page,
}) => {
  await conversation(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const reply = workspace.conversations[0].messages[1];
    reply.status = 'error';
    reply.error = 'The provider stopped unexpectedly.';
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'Rewind here' }).last().click();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo rewind' })).toHaveCount(0);
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0],
  );
  expect(saved.rewind).toBeUndefined();
  expect(saved.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
});
