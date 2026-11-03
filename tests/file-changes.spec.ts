import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

test('authenticated production Viewer restores final diffs and distinguishes missing history', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-file-changes-web-'));
  const token = 'synthetic-file-changes-fixture-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Viewer file changes',
    archived: true,
    createdAt: now,
    updatedAt: now,
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'Older reply.' }],
      },
      ...[
        ['original', 'middle'],
        ['middle', 'final'],
      ].map(([before, after]) => ({
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        status: 'complete' as const,
        createdAt: now,
        blocks: [{ type: 'markdown' as const, text: 'Updated the source.' }],
        fileChanges: {
          revision: 2,
          limited: false,
          edits: [
            {
              id: 'one',
              files: [
                {
                  path: 'src/example.ts',
                  kind: 'modified' as const,
                  hunks: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ['-' + before, '+' + after],
                    },
                  ],
                },
              ],
            },
          ],
        },
      })),
    ],
  });
  try {
    await seedAndPairPwa(page, url, token, workspace);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('tab', { name: /^History/ }).click();
      await page.getByRole('button', { name: /Viewer file changes/ }).click();
      const last = page.locator('.file-changes').last();
      await expect(last.locator('.changes-toolbar')).not.toBeVisible();
      await page
        .getByRole('button', { name: /Files edited/ })
        .last()
        .click();
      await expect(last.locator('.changes-toolbar')).toBeVisible();
      await last.getByRole('tab', { name: 'All chat changes', exact: true }).click();
      await last.locator('.changed-file > summary').click();
      await expect(last.locator('.diff-code')).toHaveText(['-original', '+final']);
      const old = page.locator('.file-changes').first();
      await page
        .getByRole('button', { name: /Files edited/ })
        .first()
        .click();
      await expect(old.locator('.changes-toolbar')).toBeVisible();
      await expect(
        old.getByText('File changes were not recorded for this response.', { exact: true }),
      ).toBeVisible();
      if (!attempt) await page.reload();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mobile of [false, true])
  test(`reply and cumulative file diffs survive reload ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    for (const [before, after] of [
      ['original', 'intermediate'],
      ['intermediate', '<script>final</script>'],
    ]) {
      await page.getByLabel('Message', { exact: true }).fill('Update the fixture');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
      await page.evaluate(
        ({ before, after }) => {
          (window as any).emitCapability({
            kind: 'filechanges',
            fileChanges: {
              revision: 1,
              limited: false,
              edits: [
                {
                  id: 'edit-1',
                  files: [
                    {
                      path: 'C:\\Projects\\studio\\src\\components\\Example.svelte',
                      kind: 'modified',
                      hunks: [
                        {
                          oldStart: 1,
                          oldLines: 1,
                          newStart: 1,
                          newLines: 1,
                          lines: ['-' + before, '+' + after],
                        },
                      ],
                    },
                    {
                      path: 'C:\\Projects\\studio\\docs\\new.txt',
                      kind: before === 'original' ? 'added' : 'modified',
                      hunks: [
                        {
                          oldStart: before === 'original' ? 0 : 1,
                          oldLines: before === 'original' ? 0 : 1,
                          newStart: 1,
                          newLines: 1,
                          lines:
                            before === 'original'
                              ? ['+new document']
                              : ['-new document', '+final document'],
                        },
                      ],
                    },
                    ...(before === 'original'
                      ? Array.from({ length: 6 }, (_, i) => ({
                          // The last two carry their own file type, for the type icons.
                          path: `C:/Projects/studio/zz-extra-${i + 1}.${['txt', 'txt', 'txt', 'txt', 'css', 'html'][i]}`,
                          kind: 'added',
                          hunks: [
                            {
                              oldStart: 0,
                              oldLines: 0,
                              newStart: 1,
                              newLines: 1,
                              lines: ['+extra file'],
                            },
                          ],
                        }))
                      : []),
                  ],
                },
              ],
            },
          });
          (window as any).emitCapability({ kind: 'text', text: 'The fixture has been updated.' });
          (window as any).finishCapabilities('complete');
        },
        { before, after },
      );
      await expect(page.locator('.message[data-status="running"]')).toHaveCount(0);
    }
    await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
    const summary = page.locator('.file-changes').last();
    // Each row's leading icon names the kind of file it changed.
    const typeIcon = (name: string) =>
      summary.locator('.changed-file').filter({ hasText: name }).locator('summary [data-icon]');
    const footer = page.locator('.reply-footer').last();
    const filesToggle = footer.getByRole('button', { name: /Files edited/ });
    const usageToggle = footer.getByRole('button', { name: 'Reply usage and cost', exact: true });
    await expect(filesToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(usageToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(summary.locator('.changes-toolbar')).not.toBeVisible();
    // Both in one frame: the chat may still be gliding to the end of the reply just sent.
    const [filesTop, usageTop] = await filesToggle.evaluate(
      (files, usage) => [files, usage!].map((button) => button.getBoundingClientRect().y),
      await usageToggle.elementHandle(),
    );
    expect(Math.abs(filesTop - usageTop)).toBeLessThan(2);
    await filesToggle.focus();
    await page.keyboard.press('Enter');
    await expect(filesToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(summary.locator('.changes-toolbar')).toBeVisible();
    await expect(footer.locator('.usage-breakdown')).not.toBeVisible();
    await expect(
      summary.getByText('Recorded edits from this response.', { exact: true }),
    ).toHaveCount(0);
    await expect(summary.getByText(/Only file edits reported by the agent/)).toHaveCount(0);
    await expect(summary.locator('.changed-file')).toHaveCount(2);
    await expect(summary.getByRole('button', { name: /Show all/ })).toHaveCount(0);
    const file = summary
      .locator('.changed-file')
      .filter({ hasText: 'src/components/Example.svelte' });
    await expect(file).toHaveCount(1);
    await expect(file.locator('.file-path')).toHaveText('src/components/Example.svelte');
    await expect(file.locator('summary')).toHaveAttribute(
      'title',
      'C:\\Projects\\studio\\src\\components\\Example.svelte',
    );
    await expect(file.locator('.file-kind')).toHaveText('Edited');
    await expect(typeIcon('src/components/Example.svelte')).toHaveAttribute(
      'data-icon',
      'component',
    );
    await expect(typeIcon('docs/new.txt')).toHaveAttribute('data-icon', 'file');
    expect(
      await file.evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth)),
    ).toBeGreaterThan(0);
    await expect(file).not.toHaveAttribute('open', '');
    await file.locator('summary').click();
    await expect(summary.locator('.changed-file[open] .diff-code')).toHaveText([
      '-intermediate',
      '+<script>final</script>',
    ]);
    await expect(summary.locator('script')).toHaveCount(0);
    await summary.getByRole('tab', { name: 'This response', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(summary.getByRole('tab', { name: 'All chat changes', exact: true })).toBeFocused();
    await expect(summary.locator('.changed-file')).toHaveCount(5);
    await expect(summary.locator('.change-totals')).toContainText('8 files');
    const showAll = summary.getByRole('button', { name: 'Show all 8 files', exact: true });
    await showAll.focus();
    await page.keyboard.press('Enter');
    await expect(summary.locator('.changed-file')).toHaveCount(8);
    await expect(typeIcon('zz-extra-5.css')).toHaveAttribute('data-icon', 'style');
    await expect(typeIcon('zz-extra-6.html')).toHaveAttribute('data-icon', 'markup');
    await expect(typeIcon('zz-extra-1.txt')).toHaveAttribute('data-icon', 'file');
    await summary.getByRole('tab', { name: 'This response', exact: true }).click();
    await expect(summary.locator('.changed-file')).toHaveCount(2);
    await expect(summary.getByRole('button', { name: /Show fewer/ })).toHaveCount(0);
    await summary.getByRole('tab', { name: 'All chat changes', exact: true }).click();
    await expect(summary.locator('.changed-file')).toHaveCount(8);
    await expect(summary.getByText(/Combined recorded edits across this chat/)).toHaveCount(0);
    await usageToggle.click();
    await expect(usageToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(filesToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(summary.locator('.changes-toolbar')).not.toBeVisible();
    await expect(footer.locator('.usage-breakdown')).toBeVisible();
    await filesToggle.click();
    await expect(usageToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(footer.locator('.usage-breakdown')).not.toBeVisible();
    await expect(summary.locator('.changed-file')).toHaveCount(8);
    await filesToggle.focus();
    await page.keyboard.press('Space');
    await expect(filesToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(summary.locator('.changes-toolbar')).not.toBeVisible();
    await page.keyboard.press('Space');
    await expect(summary.locator('.changed-file')).toHaveCount(8);
    await summary.getByRole('button', { name: 'Show fewer files', exact: true }).click();
    await expect(summary.locator('.changed-file')).toHaveCount(5);
    await expect(
      summary.locator('.changed-file').filter({ hasText: 'docs/new.txt' }).locator('.file-kind'),
    ).toHaveText('Added');
    await file.locator('summary').click();
    await expect(summary.locator('.changed-file[open] .diff-code')).toHaveText([
      '-original',
      '+<script>final</script>',
    ]);
    await expect(summary.locator('.change-totals')).toContainText('+1');
    const newFile = summary.locator('.changed-file').filter({ hasText: 'docs/new.txt' });
    await expect(newFile.locator('summary .add, summary .remove')).toHaveCount(0);
    await newFile.locator('summary').click();
    await expect(newFile.locator('.hunk')).toHaveCount(0);
    await expect(newFile.locator('.diff-code')).toHaveText('+final document');
    await expect(file.locator('.hunk')).toHaveCount(1);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
    expect(await summary.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/file-changes-${mobile ? 'mobile' : 'desktop'}.png` });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.filter(
              (m: any) => m.role === 'assistant',
            ).length,
        ),
      )
      .toBe(2);
    await page.reload();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    // Each reply renders its file changes when Files edited first opens.
    const filesToggles = page.getByRole('button', { name: /Files edited/ });
    await expect(filesToggles).toHaveCount(2);
    await expect(page.locator('.file-changes')).toHaveCount(0);
    await filesToggles.first().click();
    await expect(page.locator('.file-changes')).toHaveCount(1);
    const first = page.locator('.file-changes').first();
    await expect(first.locator('.changes-toolbar')).toBeVisible();
    await first.getByRole('tab', { name: 'All chat changes', exact: true }).click();
    await expect(first.locator('.changed-file')).toHaveCount(5);
    await expect(
      first.getByRole('button', { name: 'Show all 8 files', exact: true }),
    ).toBeVisible();
    await first
      .locator('.changed-file')
      .filter({ hasText: 'src/components/Example.svelte' })
      .locator('summary')
      .click();
    await expect(first.locator('.changed-file[open] .diff-code')).toHaveText([
      '-original',
      '+<script>final</script>',
    ]);
  });

test('edits of the agent memory open in their own card beside Files edited', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const memory = 'C:\\Users\\Ana\\.claude\\projects\\C--Projects-studio\\memory\\';
  const added = (path: string, line: string) => ({
    path,
    kind: 'added',
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+' + line] }],
  });
  for (const files of [
    [
      added('C:\\Projects\\studio\\src\\app.ts', 'export {};'),
      added('C:\\Projects\\studio\\README.md', '# Studio'),
      // Claude Code loads CLAUDE.md as memory; Codex's AGENTS.md stays with the files.
      added('C:\\Projects\\studio\\CLAUDE.md', '# Studio rules'),
      added('C:\\Projects\\studio\\AGENTS.md', '# Agent rules'),
      added(memory + 'MEMORY.md', '- [Tests](feedback_tests.md)'),
      added(memory + 'feedback_tests.md', 'Run the tests in the foreground.'),
    ],
    [added('C:\\Projects\\studio\\docs\\notes.md', 'Notes')],
  ]) {
    await page.getByLabel('Message', { exact: true }).fill('Update the fixture');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    await page.evaluate((files) => {
      (window as any).emitCapability({
        kind: 'filechanges',
        fileChanges: { revision: 1, limited: false, edits: [{ id: 'edit-1', files }] },
      });
      (window as any).emitCapability({ kind: 'text', text: 'Done.' });
      (window as any).finishCapabilities('complete');
    }, files);
    await expect(page.locator('.message[data-status="running"]')).toHaveCount(0);
  }
  const footers = page.locator('.reply-footer');
  const [first, last] = [footers.first(), footers.last()];
  // A reply that left the memory alone has no Memories toggle.
  const lastFiles = last.getByRole('button', { name: /Files edited/ });
  await expect(lastFiles.locator('.count')).toHaveText('1');
  await expect(last.getByRole('button', { name: /Memories/ })).toHaveCount(0);
  const filesToggle = first.getByRole('button', { name: /Files edited/ });
  const memoryToggle = first.getByRole('button', { name: /Memories/ });
  await expect(filesToggle.locator('.count')).toHaveText('3');
  await expect(memoryToggle.locator('.count')).toHaveText('3');
  await expect(memoryToggle).toHaveAttribute('aria-expanded', 'false');
  // Both in one frame: the chat may still be gliding to the end of the reply just sent.
  const [filesBounds, memoryBounds] = await filesToggle.evaluate(
    (files, memory) =>
      [files, memory!].map((button) => {
        const { x, y } = button.getBoundingClientRect();
        return { x, y };
      }),
    await memoryToggle.elementHandle(),
  );
  expect(Math.abs(filesBounds.y - memoryBounds.y)).toBeLessThan(2);
  expect(memoryBounds.x).toBeGreaterThan(filesBounds.x);

  await filesToggle.click();
  const files = first.locator('.file-changes').first();
  await expect(files.locator('.file-path')).toHaveText(['AGENTS.md', 'README.md', 'src/app.ts']);
  await memoryToggle.click();
  await expect(filesToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(memoryToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(files.locator('.changes-toolbar')).not.toBeVisible();
  const card = page.getByRole('region', { name: /Memories/ });
  await expect(card.getByRole('tablist', { name: 'Memory change scope' })).toBeVisible();
  // A memory folder's files show within it, CLAUDE.md within the project like Files edited.
  const memoryPaths = ['CLAUDE.md', 'feedback_tests.md', 'MEMORY.md'];
  await expect(card.locator('.file-path')).toHaveText(memoryPaths);
  await expect(card.locator('.change-totals')).toContainText('3 files');
  await expect(card.getByTitle('C:\\Projects\\studio\\CLAUDE.md', { exact: true })).toContainText(
    'Added',
  );
  const index = card
    .locator('.changed-file')
    .filter({ has: page.getByTitle(memory + 'MEMORY.md', { exact: true }) });
  await expect(index.locator('summary')).toHaveAttribute('title', memory + 'MEMORY.md');
  await expect(index.locator('.file-kind')).toHaveText('Added');
  await index.locator('summary').click();
  await expect(index.locator('.diff-code')).toHaveText('+- [Tests](feedback_tests.md)');
  await card.getByRole('tab', { name: 'All chat changes', exact: true }).click();
  await expect(card.locator('.file-path')).toHaveText(memoryPaths);
  await filesToggle.click();
  await expect(memoryToggle).toHaveAttribute('aria-expanded', 'false');
  await files.getByRole('tab', { name: 'All chat changes', exact: true }).click();
  await expect(files.locator('.file-path')).toHaveText([
    'AGENTS.md',
    'docs/notes.md',
    'README.md',
    'src/app.ts',
  ]);
  // Each card keeps its own scope across panel switches.
  await memoryToggle.click();
  await expect(card.getByRole('tab', { name: 'All chat changes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // A file opened in a scope stays open there.
  await card.getByRole('tab', { name: 'This response', exact: true }).click();
  await expect(index.locator('.diff-code')).toHaveText('+- [Tests](feedback_tests.md)');
  await index.locator('summary').click();
  await card.getByTitle(memory + 'feedback_tests.md', { exact: true }).click();
  await expect(card.locator('.changed-file[open] .diff-code')).toHaveText(
    '+Run the tests in the foreground.',
  );
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/memory-changes-desktop.png' });
  await memoryToggle.click();
  await expect(card).toHaveCount(0);
  await filesToggle.click();
  await expect(files.getByRole('tab', { name: 'All chat changes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
