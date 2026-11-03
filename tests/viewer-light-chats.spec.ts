import { signInPwa, viewerCache } from './pwa-helper';
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';
import type { Conversation, Message } from '../src/lib/domain';

// The Viewer holds chats without the work their replies recorded, which the relay keeps, and
// reads a chat whole to show it (src/lib/light-chats.ts, docs/MOBILE.md).
const command = 'npm run build -- --mode viewer-check';
const changed = 'src/viewer-check.ts';

function workspace() {
  const shared = emptyShared();
  const [computer, environment, account, connection] = Array.from({ length: 4 }, () =>
    crypto.randomUUID(),
  );
  shared.fleet.computers.push({ id: computer, name: 'Light chats computer' });
  shared.fleet.environments.push({
    id: environment,
    computerId: computer,
    name: 'Light chats environment',
    platform: 'linux',
  });
  shared.fleet.accounts.push({
    id: account,
    name: 'Light chats account',
    provider: 'codex',
    purpose: 'personal',
  });
  shared.fleet.connections.push({
    id: connection,
    environmentId: environment,
    accountId: account,
    profile: 'existing',
  });
  const settings = {
    connectionId: connection,
    provider: 'codex' as const,
    model: '',
    reasoning: '' as const,
    instructions: '',
  };
  const chat = (title: string, reply: Record<string, unknown>): Conversation => ({
    id: crypto.randomUUID(),
    title,
    settings,
    location: { computerId: computer, environmentId: environment, path: '/home/light' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        status: 'complete' as const,
        createdAt: new Date().toISOString(),
        blocks: [{ type: 'markdown' as const, text: `${title}, please.` }],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        runId: crypto.randomUUID(),
        settings,
        ...reply,
      } as Message,
    ],
  });
  shared.conversations.push(
    chat('Fix the build', {
      status: 'complete',
      blocks: [
        {
          type: 'reasoning',
          id: 'r1',
          revision: 1,
          text: 'Checking the build output first.',
          truncated: false,
        },
        {
          type: 'activity',
          text: `Ran ${command}`,
          tool: {
            id: 'call-1',
            revision: 2,
            category: 'tool',
            name: 'Bash',
            status: 'complete',
            command,
            facts: [],
            sources: [],
            agents: [],
          },
        },
        { type: 'markdown', text: 'The build passes again.' },
      ],
      fileChanges: {
        revision: 1,
        limited: false,
        edits: [
          {
            id: 'edit-1',
            files: [
              {
                path: changed,
                kind: 'modified',
                hunks: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ['-export const broken = true;', '+export const broken = false;'],
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
    chat('Still running elsewhere', {
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Working on it' }],
    }),
  );
  return shared;
}

test('the Viewer keeps chats light, shows the open chat whole and never erases recorded work', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-light-chats-'));
  const token = 'synthetic-viewer-light-chats-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const state = async (body?: unknown) => {
    const response = await fetch(`${url}/v1/state`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()).workspace as ReturnType<typeof workspace>;
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const seeded = workspace();
    await state({ revision: 0, workspace: seeded });
    const [build, running] = seeded.conversations;
    await page.goto(url);
    await signInPwa(page, token);
    // Nothing the replies recorded is kept in this browser, while their text is.
    await expect
      .poll(async () => JSON.stringify(await viewerCache(page)))
      .toContain('The build passes again.');
    const cache = JSON.stringify(await viewerCache(page));
    expect(cache).not.toContain(command);
    expect(cache).not.toContain(changed);
    expect(cache).not.toContain('Checking the build output first.');

    // Opening the chat reads it whole: its Work history and Files edited are there.
    await page.getByRole('tab', { name: /^Active/ }).click();
    await page.getByRole('button', { name: 'Fix the build', exact: true }).click();
    await expect(page.getByText('The build passes again.', { exact: true })).toBeVisible();
    await page.locator('summary[aria-label="Work history"]').click();
    await expect(page.getByText('Ran 1 command', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Files edited/ }).click();
    await expect(page.getByText(changed).first()).toBeVisible();
    expect(JSON.stringify(await viewerCache(page))).not.toContain(command);

    // A fork copies the recorded work, which reaches the relay with it.
    await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
    await expect(page.locator('.page-title')).toHaveText('Fix the build (fork)');
    await expect
      .poll(async () => (await state()).conversations.find((c) => c.title.endsWith('(fork)')))
      .toBeTruthy();
    const fork = (await state()).conversations.find((c) => c.title.endsWith('(fork)'))!;
    expect(JSON.stringify(fork)).toContain(command);
    expect(JSON.stringify(fork)).toContain(changed);

    // An edit here goes out light, and the relay keeps the work it left out.
    await page.getByRole('tab', { name: /^Active/ }).click();
    await page.getByRole('button', { name: 'Fix the build', exact: true }).click();
    await page.getByRole('button', { name: 'Move to history', exact: true }).click();
    await expect
      .poll(async () => (await state()).conversations.find((c) => c.id === build.id)?.archived)
      .toBe(true);
    const moved = (await state()).conversations.find((c) => c.id === build.id)!;
    expect(moved.messages).toEqual(build.messages);

    // A reload of the Viewer stops nothing: the reply another computer runs stays running.
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.waitForTimeout(6_000);
    const after = await state();
    expect(after.conversations.find((c) => c.id === running.id)).toEqual(running);
    expect(after.conversations.filter((c) => c.title.includes('conflict copy'))).toHaveLength(0);

    // The reply ends on its computer while the chat is open here: its work shows as it arrives.
    await page.getByRole('tab', { name: /^Active/ }).click();
    await page.getByRole('button', { name: 'Still running elsewhere', exact: true }).click();
    await expect(page.locator('summary[aria-label="Work history"]')).toHaveCount(0);
    const { revision } = await (
      await fetch(`${url}/v1/state/revision`, {
        headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
      })
    ).json();
    expect(revision).toEqual(expect.any(Number));
    const finished = structuredClone(after);
    const ended = finished.conversations.find((c) => c.id === running.id)!;
    ended.messages[1].status = 'complete';
    // A new exchange arrives with it, whose reply recorded work too.
    ended.messages.push(
      { ...build.messages[0], id: crypto.randomUUID() },
      {
        ...build.messages[1],
        id: crypto.randomUUID(),
        blocks: [build.messages[1].blocks[1], { type: 'markdown', text: 'Done elsewhere.' }],
      },
    );
    await state({ revision, workspace: finished });
    await expect(page.getByText('Done elsewhere.', { exact: true })).toBeVisible();
    await expect(page.locator('summary[aria-label="Work history"]')).toHaveCount(1);
    await page.locator('summary[aria-label="Work history"]').click();
    await expect(page.getByText('Ran 1 command', { exact: true })).toBeVisible();

    // An export holds every chat whole.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export workspace', exact: true }).click();
    const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
    const copy = exported.conversations.find((c: { id: string }) => c.id === build.id);
    expect(copy.messages).toEqual(build.messages);
    expect(exported.conversations).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the Viewer opens a chat again where the reader left it, once it has read it whole @webkit', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-light-places-'));
  const token = 'synthetic-viewer-light-places-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const seeded = workspace();
    // A reply with many calls and a long answer, read inside its Work history.
    const reply = seeded.conversations[0].messages[1];
    reply.blocks = [
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'activity' as const,
        text: `Ran ${command} ${i}`,
        tool: {
          id: `call-${i}`,
          revision: 1,
          category: 'tool' as const,
          name: 'Bash',
          status: 'complete' as const,
          command: `${command} ${i}`,
          facts: [],
          sources: [],
          agents: [],
        },
      })),
      {
        type: 'markdown' as const,
        text: Array.from({ length: 40 }, (_, i) => `Answer paragraph ${i + 1}.`).join('\n\n'),
      },
    ];
    const seed = await fetch(`${url}/v1/state`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 0, workspace: seeded }),
    });
    expect(seed.status).toBe(200);
    await page.goto(url);
    await signInPwa(page, token);
    await page.getByRole('tab', { name: /^Active/ }).click();
    const open = (title: string) => page.getByRole('button', { name: title, exact: true }).click();
    const below = () =>
      page
        .locator('.chat-scroll')
        .evaluate((scroll) =>
          Math.round(
            scroll.querySelectorAll('.tool-card')[8].getBoundingClientRect().top -
              scroll.getBoundingClientRect().top,
          ),
        );
    await open('Fix the build');
    await page.locator('summary[aria-label="Work history"]').click();
    await page.locator('.activity-group > summary').first().click();
    await expect(page.locator('.tool-card')).toHaveCount(12);
    await page.locator('.chat-scroll').evaluate((scroll) => {
      const call = scroll.querySelectorAll('.tool-card')[8];
      scroll.scrollTop +=
        call.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 60;
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const call = await below();
    expect(Math.abs(call - 60)).toBeLessThanOrEqual(1);

    // Left, the chat goes light; shown again, it is read whole and opens as it was left.
    await open('Still running elsewhere');
    await expect(page.locator('summary[aria-label="Work history"]')).toHaveCount(0);
    await open('Fix the build');
    await expect(page.locator('.activity-summary')).toHaveAttribute('open', '');
    await expect(page.locator('.activity-group').first()).toHaveAttribute('open', '');
    await expect.poll(async () => Math.abs((await below()) - call)).toBeLessThanOrEqual(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
