import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

type Fields = Record<string, unknown>;
// Long enough to need an ellipsis in rows and lists.
const task =
  'Find where sessions are created and how they expire, then list every file that reads or writes the session store, with the line of each access.';
const script =
  'npm test -- auth --reporter=verbose --coverage src/auth/session.test.ts src/auth/expiry.test.ts';
const result = 'Sessions are created in `createSession` and expire after **30 minutes**.';
// The reply's sub-agents, all held by one call as the Claude decoder reports them.
const agents = (revision: number, reader: Fields, others: Fields[] = []) => ({
  kind: 'tool',
  tool: {
    id: 'claude:agents',
    name: 'Sub-agents',
    category: 'agent',
    revision,
    status: 'running',
    sources: [],
    agents: [
      { id: 'reader', name: 'Explore the auth flow', status: 'running', task, ...reader },
      ...others,
    ],
  },
});
const call = (id: string, fields: Fields) => ({
  kind: 'tool',
  tool: {
    id,
    name: 'Read',
    category: 'tool',
    operation: 'read',
    revision: 1,
    status: 'complete',
    sources: [],
    agents: [],
    parentId: 'reader',
    ...fields,
  },
});
const test1 = call('c1', {
  name: 'Run command',
  operation: 'command',
  commandRun: true,
  command: script,
  status: 'running',
});
const message = (id: string, text: string, after: number) => ({ id, text, complete: true, after });
const early = [
  message('m1', 'Looking for the session store.', 0),
  message('m2', 'Sessions live in **session.ts**.', 2),
];
const watcher = { id: 'watcher', name: 'Watch the logs', status: 'running', background: true };
const checker = {
  id: 'checker',
  name: 'Verify the expiry',
  status: 'complete',
  parentId: 'reader',
  task: 'Confirm the 30 minute timeout.',
  result: 'The timeout is 30 minutes.',
};

async function start(page: Page, mobile: boolean) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Explore the auth code');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  return (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
}

// Everything a sub-agent said and did, in its panel's order.
const conversation = (panel: ReturnType<Page['getByRole']>) =>
  panel
    .locator('.progress-message, .activity-group > summary .group-label, .live-row .live-line')
    .allTextContents()
    .then((items) => items.map((text) => text.replace(/\s+/g, ' ').trim()));

for (const mobile of [false, true])
  test(`a running sub-agent's conversation opens beside the chat from its reply's footer ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    const shot = (name: string) =>
      page.screenshot({
        path: `artifacts/subagent-panel/${name}-${mobile ? 'mobile' : 'desktop'}.png`,
      });
    const emit = await start(page, mobile);
    await emit({ kind: 'progress', id: 'p1', revision: 1, text: 'I will delegate the search.' });
    await emit(agents(1, { messages: early.slice(0, 1) }));
    await emit(call('r1', { path: '/fixture/src/session.ts' }));
    await emit(call('r2', { path: '/fixture/src/auth.ts' }));
    await emit(test1);
    await emit(agents(2, { messages: early }, [watcher]));

    // The chat keeps its own work; the sub-agent's calls belong to its conversation.
    const live = page.locator('.live-row[data-category="agent"]');
    await expect(live.locator(':scope > summary')).toContainText('Working with');
    await expect(live.locator('.live-child')).toContainText('npm test -- auth');
    await expect(page.locator('.chat-scroll')).not.toContainText('session.ts');

    // Running sub-agents sit beside the reply's elapsed time, background ones included, and
    // none of them is counted as background work.
    const toggle = page.locator('.reply-footer .progress-toggle', { hasText: 'Sub-agents' });
    await expect(toggle).toHaveText(/Sub-agents\s*2/);
    await expect(toggle).toHaveAttribute('title', '2 sub-agents running');
    await expect(page.locator('.reply-footer', { hasText: 'Background work' })).toHaveCount(0);
    await toggle.click();
    const list = page.getByRole('region', { name: 'Sub-agents' });
    const items = list.getByRole('button');
    await expect(items).toHaveText([
      /Explore the auth flow\s*Running\s*npm test -- auth --reporter=verbose.*\s*3 calls/,
      /Watch the logs\s*In background\s*0 calls/,
    ]);
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot('footer');

    await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
    await items.first().click();
    const panel = page.getByRole('dialog', { name: 'Explore the auth flow' });
    await expect(panel).toBeVisible();
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await expect(panel.locator('header')).toContainText(/Running\s*Sub-agent\s*3 calls/);
    await expect(panel.getByRole('region', { name: 'Task' })).toContainText(task);
    await expect
      .poll(() => conversation(panel))
      .toEqual([
        'Looking for the session store.',
        'Read 2 files',
        'Sessions live in session.ts.',
        `Running ${script}`,
      ]);
    // Its latest call reads like a running call of the chat and opens like one.
    await panel.locator('.live-row > summary').click();
    await expect(panel.locator('.live-row .tool-body')).toContainText('npm test -- auth');
    await expect(panel.locator('.live-row .tool-body')).not.toContainText('By sub-agent');
    await shot('panel-live');

    // It follows the sub-agent: its result closes the conversation once it has finished.
    await emit(call('c1', { ...test1.tool, revision: 2, status: 'complete' }));
    await emit(
      agents(
        3,
        {
          status: 'complete',
          result,
          messages: [...early, message('m3', result, 3)],
        },
        [watcher, checker],
      ),
    );
    await expect(panel.locator('header')).toContainText(/Completed\s*Sub-agent\s*3 calls/);
    const answer = panel.getByRole('region', { name: 'Result' });
    await expect(answer).toContainText('Sessions are created in createSession');
    await expect(answer.locator('strong')).toHaveText('30 minutes');
    // The closing message is the result and appears once.
    await expect(panel.getByText('expire after', { exact: false })).toHaveCount(1);
    await expect
      .poll(() => conversation(panel))
      .toEqual([
        'Looking for the session store.',
        'Read 2 files',
        'Sessions live in session.ts.',
        'Ran 1 command and worked with 1 sub-agent',
      ]);
    await expect(toggle).toHaveText(/Sub-agents\s*1/);
    await expect(items).toHaveText([/Watch the logs/]);
    await shot('panel-done');

    // A sub-agent it started opens in the same panel.
    await panel.locator('.activity-group > summary', { hasText: 'worked with 1 sub-agent' }).click();
    await panel.getByRole('button', { name: /Verify the expiry/ }).click();
    const nested = page.getByRole('dialog', { name: 'Verify the expiry' });
    await expect(nested.locator('header')).toContainText('Delegated by Explore the auth flow');
    await expect(nested.getByRole('region', { name: 'Result' })).toHaveText(
      'The timeout is 30 minutes.',
    );
    await expect(nested).toContainText('Confirm the 30 minute timeout.');

    if (mobile) {
      // Phones show it as a drawer over the chat.
      const box = await nested.boundingBox();
      expect(box!.width).toBeGreaterThan(380);
      await nested.getByRole('button', { name: 'Close sub-agent' }).click();
    } else {
      // Wide windows keep the chat usable beside it; Escape closes it.
      const chat = await page.locator('.chat-layout').boundingBox();
      const side = await nested.boundingBox();
      expect(chat!.x + chat!.width).toBeLessThanOrEqual(side!.x + 1);
      await expect(page.getByRole('separator', { name: 'Resize sub-agent panel' })).toBeVisible();
      await nested.getByRole('button', { name: 'Close sub-agent' }).focus();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await emit(agents(4, { status: 'complete', result, messages: early }, [
      { ...watcher, status: 'complete' },
      checker,
    ]));
    await emit({ kind: 'text', text: 'Sessions expire after 30 minutes.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await expect(toggle).toHaveCount(0);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  });

test('a sub-agent that carried on past failed calls reads as done, with its failures counted', async ({
  page,
}) => {
  const emit = await start(page, false);
  await emit(agents(1, {}));
  await emit(call('r1', { path: '/fixture/src/session.ts' }));
  for (const [id, command] of [
    ['bad1', 'tail -3 a.log b.log'],
    ['bad2', 'sleep 60; tail a.log'],
  ])
    await emit(
      call(id, { name: 'Run command', operation: 'command', commandRun: true, command, status: 'error' }),
    );
  await emit(agents(2, { status: 'complete', result }));
  // The record a reply ended with past the 200 calls replies kept before 2026-09-29.
  await emit({
    kind: 'tool',
    tool: {
      id: 'activity-limit',
      name: 'Activity limit reached',
      category: 'tool',
      revision: 1,
      status: 'unknown',
      detail: 'Additional operations are not shown after 200 entries.',
      sources: [],
      agents: [],
    },
  });
  await emit({ kind: 'text', text: 'Sessions expire after 30 minutes.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await page.getByLabel('Work history', { exact: true }).click();
  const group = page.locator('.activity-group').first();
  await expect(group.locator(':scope > summary')).toHaveText(
    /^\s*Worked with 1 sub-agent\s*2 calls failed\s*$/,
  );
  // Its calls' failures are red beside the label, without an icon; the sub-agent itself is not.
  await expect(group.locator(':scope > summary .tool-status.failed')).toHaveText('2 calls failed');
  await expect(group.locator(':scope > summary .tool-status svg')).toHaveCount(0);
  await expect(group.locator(':scope > summary .failed-part')).toHaveCount(0);
  await group.locator(':scope > summary').click();
  await expect(group.locator('.subagent-row')).toHaveText([/Explore the auth flow.*Completed/]);
  await expect(page.locator('.timeline-note').last()).toHaveText(
    'Calls after the first 200 were not recorded: earlier versions kept only 200 per reply.',
  );
  await expect(page.getByText('Later calls not shown')).toHaveCount(0);
  await expect(page.getByText('Outcome unconfirmed')).toHaveCount(0);
});

test('a sub-agent keeps every message it wrote, however many and long', async ({ page }) => {
  const emit = await start(page, false);
  // Replies saved before 2026-09-29 kept 16 messages of up to 16,000 UTF-16 units in all.
  const long = 'All of it. '.repeat(900);
  const written = Array.from({ length: 40 }, (_, i) =>
    message(`m${i}`, i === 39 ? `Step 40: ${long}` : `Step ${i + 1} done.`, 0),
  );
  await emit(agents(1, { status: 'complete', messages: written, result: 'Every step is done.' }));
  await emit({ kind: 'text', text: 'Done.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await page.getByLabel('Work history', { exact: true }).click();
  const group = page.locator('.activity-group').first();
  await group.locator(':scope > summary').click();
  await group.locator('.subagent-row').first().click();
  const panel = page.getByRole('dialog', { name: 'Explore the auth flow' });
  await expect(panel.locator('.progress-message')).toHaveCount(40);
  await expect(panel.locator('.progress-message').last()).toContainText(long.trim());
  await expect(panel.getByText('not recorded')).toHaveCount(0);
});

test('sub-agents in Work history open their saved conversation', async ({ page }) => {
  const emit = await start(page, false);
  await emit(agents(1, { messages: early.slice(0, 1) }));
  await emit(call('r1', { path: '/fixture/src/session.ts' }));
  await emit(call('r2', { path: '/fixture/src/auth.ts' }));
  await emit(
    agents(2, { status: 'error', result: 'Could not read **config.ts**.', messages: early }, [
      { id: 'writer', name: 'Draft the notes', status: 'complete', task: 'Summarize the flow.' },
    ]),
  );
  await emit({ kind: 'text', text: 'One sub-agent failed.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
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

  // Work history lists each sub-agent as a row of its own group, with its task and outcome.
  await page.getByLabel('Work history', { exact: true }).click();
  const group = page.locator('.activity-group').first();
  await expect(group.locator(':scope > summary')).toHaveText(/^\s*2 sub-agents failed\s*$/);
  await expect(group.locator(':scope > summary .failed-part')).toHaveText('2 sub-agents');
  await group.locator(':scope > summary').click();
  const rows = group.locator('.subagent-row');
  await expect(rows).toHaveText([
    /Explore the auth flow\s*Find where sessions are created.*Failed/,
    /Draft the notes\s*Summarize the flow\./,
  ]);
  await expect(group.locator('.tool-card')).toHaveCount(0);
  expect(
    await page
      .locator('.chat-scroll .tool-activity')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await rows.first().click();
  const panel = page.getByRole('dialog', { name: 'Explore the auth flow' });
  await expect(panel.locator('header')).toContainText(/Failed\s*Sub-agent\s*2 calls/);
  await expect(rows.first()).toHaveAttribute('aria-current', 'true');
  // A finished conversation is expanded, its messages among its calls as they came.
  await expect
    .poll(() => conversation(panel))
    .toEqual(['Looking for the session store.', 'Read 2 files', 'Sessions live in session.ts.']);
  await panel.locator('.activity-group > summary').click();
  await expect(panel.locator('.tool-card')).toHaveText([/session\.ts/, /auth\.ts/]);
  await expect(panel.getByRole('region', { name: 'Result' })).toHaveText('Could not read config.ts.');
  await page.screenshot({ path: 'artifacts/subagent-panel/history-desktop.png' });

  // Another row shows its own conversation in the same panel.
  await rows.nth(1).click();
  const writer = page.getByRole('dialog', { name: 'Draft the notes' });
  await expect(writer).toContainText('Summarize the flow.');
  await expect(writer).toContainText('No result was reported for this sub-agent.');
  await expect(rows.first()).not.toHaveAttribute('aria-current', 'true');

  // Only one panel sits beside the chat, and it stays with its conversation.
  await page.getByRole('button', { name: 'New conversation', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(writer).toContainText('Summarize the flow.');
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
