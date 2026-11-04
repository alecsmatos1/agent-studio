import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server';
import { mockAppCalls, mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// How far the open conversation is scrolled above its end.
const fromEnd = (page: Page) =>
  page
    .locator('.chat-scroll')
    .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
const heldRuns = (page: Page) =>
  page.evaluate(() =>
    Object.entries((window as any).capabilityRuns ?? {}).map(([runId, run]: [string, any]) => ({
      runId,
      conversationId: run.conversationId as string,
    })),
  );
const emit = (page: Page, runId: string, message: unknown) =>
  page.evaluate(({ runId, message }) => (window as any).capabilityRuns[runId].emit(message), {
    runId,
    message,
  });
const chat = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });
const paragraphs = (label: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}.`).join('\n\n');

test('opening a running chat shows its end after reading above the end of another', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('First task');
  await send.click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [first] = await heldRuns(page);
  // Text events carry the whole answer so far.
  const answer = paragraphs('First', 120);
  await emit(page, first.runId, { kind: 'text', text: answer });
  await expect(page.getByText('First paragraph 120.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await composer.fill('Second task');
  await send.click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const second = (await heldRuns(page)).find((run) => run.runId !== first.runId)!;
  await emit(page, second.runId, { kind: 'text', text: paragraphs('Second', 60) });
  await expect(page.getByText('Second paragraph 60.', { exact: true })).toBeVisible();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  // Reading above the end of the second chat stops following it.
  await page.locator('.chat-scroll').hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(() => fromEnd(page)).toBeGreaterThan(300);

  // Before the fix the first chat kept this reading position's offset, 2,848px above its end.
  await chat(page, 'First task').click();
  await expect(page.getByText('First paragraph 120.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  // It follows the reply from there.
  await emit(page, first.runId, {
    kind: 'text',
    text: `${answer}\n\n${paragraphs('Later', 30)}`,
  });
  await expect(page.getByText('Later paragraph 30.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  // Choosing the open chat again keeps a reading position above its end.
  await page.locator('.chat-scroll').hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(() => fromEnd(page)).toBeGreaterThan(300);
  const reading = await page.locator('.chat-scroll').evaluate((el) => el.scrollTop);
  await chat(page, 'First task').click();
  await page.waitForTimeout(300);
  expect(
    Math.abs((await page.locator('.chat-scroll').evaluate((el) => el.scrollTop)) - reading),
  ).toBeLessThan(2);
});

test('returning from Settings or Connections keeps the end of a followed chat or the reading position', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Long task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [run] = await heldRuns(page);
  let answer = paragraphs('Answer', 100);
  await emit(page, run.runId, { kind: 'text', text: answer });
  await expect(page.getByText('Answer paragraph 100.', { exact: true })).toBeVisible();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);

  // Before the fix the chat came back at its top.
  for (const name of ['Settings', 'Connections']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(page.locator('.chat-scroll')).toHaveCount(0);
    await button.click();
    await expect(page.getByText('Answer paragraph 100.', { exact: true })).toBeInViewport();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  }
  // Still following: new output keeps the end in view.
  answer += `\n\n${paragraphs('More', 20)}`;
  await emit(page, run.runId, { kind: 'text', text: answer });
  await expect(page.getByText('More paragraph 20.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);

  // A reading position above the end comes back as it was.
  const scroll = page.locator('.chat-scroll');
  const top = () => scroll.evaluate((el) => el.scrollTop);
  await scroll.hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => fromEnd(page)).toBeGreaterThan(600);
  const reading = await top();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(scroll).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Answer paragraph 1.', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs((await top()) - reading)).toBeLessThan(2);
  // Output arriving there leaves the reading position alone.
  answer += `\n\n${paragraphs('Unread', 10)}`;
  await emit(page, run.runId, { kind: 'text', text: answer });
  await expect(page.getByText('Unread paragraph 10.', { exact: true })).toBeAttached();
  await page.waitForTimeout(300);
  expect(Math.abs((await top()) - reading)).toBeLessThan(2);
});

for (const phone of [false, true])
  test(`a button at the lower left returns a reader above the end to the latest messages${phone ? ' on a phone' : ''}`, async ({
    page,
  }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await chooseTestFolder(page);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Long task');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
    const [run] = await heldRuns(page);
    let answer = paragraphs('Answer', 100);
    await emit(page, run.runId, { kind: 'text', text: answer });
    await expect(page.getByText('Answer paragraph 100.', { exact: true })).toBeVisible();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
    // A chat following its end needs no way back to it.
    await expect(jump).toHaveCount(0);

    // Reading above the end offers it at the bottom of the view, in the avatars' column on the
    // left rather than in the middle, marked while the reply still runs.
    const scroll = page.locator('.chat-scroll');
    const top = () => scroll.evaluate((el) => el.scrollTop);
    await scroll.hover();
    await page.mouse.wheel(0, -900);
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(600);
    await expect(jump).toBeVisible();
    await expect(jump).toHaveClass(/live/);
    const button = (await jump.boundingBox())!;
    const avatar = (await page.locator('.message-avatar.model').first().boundingBox())!;
    const view = (await scroll.boundingBox())!;
    const prose = (await page.getByText('Answer paragraph 1.', { exact: true }).boundingBox())!;
    expect(Math.abs(button.x - avatar.x)).toBeLessThan(1);
    expect(Math.abs(view.y + view.height - (button.y + button.height) - 8)).toBeLessThan(1);
    // It stays clear of the reply's text, and a phone gets a full touch target around it.
    expect(button.width).toBe(32);
    expect(button.x + button.width).toBeLessThan(prose.x);
    const hit = (x: number, y: number) =>
      page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.jump-to-end'), [x, y]);
    expect(await hit(button.x + button.width + 4, button.y + button.height / 2)).toBe(phone);
    await page.screenshot({ path: `artifacts/jump-to-latest-${phone ? 'phone' : 'desktop'}.png` });
    // It stays at the bottom of the view while the reader scrolls, and the wheel scrolls the
    // conversation over it too.
    const reached = await top();
    await jump.hover();
    await page.mouse.wheel(0, -300);
    await expect.poll(top).toBeLessThan(reached - 100);
    expect(Math.abs((await jump.boundingBox())!.y - button.y)).toBeLessThan(1);

    // Output arriving below leaves the reading position and the button in place.
    const reading = await top();
    answer += `\n\n${paragraphs('More', 10)}`;
    await emit(page, run.runId, { kind: 'text', text: answer });
    await expect(page.getByText('More paragraph 10.', { exact: true })).toBeAttached();
    await page.waitForTimeout(300);
    expect(Math.abs((await top()) - reading)).toBeLessThan(2);
    await expect(jump).toBeVisible();

    // The button shows the end and follows the reply from there.
    await jump.click();
    await expect(page.getByText('More paragraph 10.', { exact: true })).toBeInViewport();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    await expect(jump).toHaveCount(0);
    answer += `\n\n${paragraphs('Later', 20)}`;
    await emit(page, run.runId, { kind: 'text', text: answer });
    await expect(page.getByText('Later paragraph 20.', { exact: true })).toBeInViewport();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);

    // A small movement stops following without offering the button, until output moves the
    // end further away.
    await scroll.hover();
    await page.mouse.wheel(0, -30);
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(10);
    await page.waitForTimeout(300);
    await expect(jump).toHaveCount(0);
    answer += `\n\n${paragraphs('Unread', 10)}`;
    await emit(page, run.runId, { kind: 'text', text: answer });
    await expect(jump).toBeVisible();

    // Pressed from the keyboard, it leaves focus in the composer.
    await jump.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Unread paragraph 10.', { exact: true })).toBeInViewport();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    await expect(jump).toHaveCount(0);
    await expect(composer).toBeFocused();

    // Once the reply ends, the button no longer marks a running reply.
    await page.evaluate((id) => (window as any).capabilityRuns[id].finish('complete'), run.runId);
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
    await scroll.hover();
    await page.mouse.wheel(0, -900);
    await expect(jump).toBeVisible();
    await expect(jump).not.toHaveClass(/live/);
  });

// A chat whose first reply has ended, long enough to scroll.
async function finishedChat(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Long task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [first] = await heldRuns(page);
  await emit(page, first.runId, { kind: 'text', text: paragraphs('Answer', 60) });
  await page.evaluate((id) => (window as any).capabilityRuns[id].finish('complete'), first.runId);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  const second = async () => {
    await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
    return (await heldRuns(page)).find((run) => run.runId !== first.runId)!;
  };
  return { composer, first, second, scroll: page.locator('.chat-scroll') };
}
// Records the conversation's scroll position and its distance from the end on every frame.
const recordFrames = (page: Page) =>
  page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.chat-scroll')!;
    const w = window as any;
    w.scrollFrames = [];
    const frame = () => {
      w.scrollFrames.push({
        top: scroll.scrollTop,
        below: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      });
      w.scrollFrame = requestAnimationFrame(frame);
    };
    w.scrollFrame = requestAnimationFrame(frame);
  });
const recordedFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    cancelAnimationFrame(w.scrollFrame);
    return w.scrollFrames as { top: number; below: number }[];
  });

test('sending at the end of a chat glides to the new message and follows its reply', async ({
  page,
}) => {
  const { composer, first } = await finishedChat(page);
  await recordFrames(page);
  await composer.fill('Next question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // The reply starts writing while the chat glides, which takes in the text instead of
  // jumping to it.
  const reply = paragraphs('Reply', 12);
  await page.evaluate(
    ({ first, reply }) =>
      new Promise<void>((resolve) => {
        const started = () => {
          const runs = (window as any).capabilityRuns;
          const id = Object.keys(runs).find((id) => id !== first);
          if (!id) return requestAnimationFrame(started);
          runs[id].emit({ kind: 'text', text: reply });
          resolve();
        };
        started();
      }),
    { first: first.runId, reply },
  );
  await expect(page.getByText('Reply paragraph 12.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  await page.waitForTimeout(200);
  const frames = await recordedFrames(page);
  // Before the fix the chat jumped: at most a frame or two showed the new message below.
  expect(frames.filter((frame) => frame.below > 2).length).toBeGreaterThan(5);
  for (let i = 1; i < frames.length; i++)
    expect(frames[i].top).toBeGreaterThanOrEqual(frames[i - 1].top - 1);
  expect(frames.at(-1)!.below).toBeLessThan(2);

  // Following continues once the glide has ended.
  const second = (await heldRuns(page)).find((run) => run.runId !== first.runId)!;
  await emit(page, second.runId, {
    kind: 'text',
    text: `${reply}\n\n${paragraphs('More', 30)}`,
  });
  await expect(page.getByText('More paragraph 30.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
});

test('with reduced motion, sending at the end of a chat shows the new message at once', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { composer } = await finishedChat(page);
  await recordFrames(page);
  await composer.fill('Next question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Next question', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  await page.waitForTimeout(300);
  const frames = await recordedFrames(page);
  expect(frames.filter((frame) => frame.below > 2).length).toBeLessThanOrEqual(3);
});

test('sending while reading above the end of a chat leaves the reading position in place', async ({
  page,
}) => {
  const { composer, second, scroll } = await finishedChat(page);
  const top = () => scroll.evaluate((el) => el.scrollTop);
  await scroll.hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => fromEnd(page)).toBeGreaterThan(600);
  const reading = await top();
  await composer.fill('A question from above');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const sent = page.getByText('A question from above', { exact: true });
  await expect(sent).toBeAttached();
  // Before the fix sending always showed the end.
  await page.waitForTimeout(500);
  expect(Math.abs((await top()) - reading)).toBeLessThan(2);
  await expect(sent).not.toBeInViewport();
  // Its reply arrives below without moving the reader either, and the button leads down to it.
  const run = await second();
  await emit(page, run.runId, { kind: 'text', text: paragraphs('Reply', 20) });
  await expect(page.getByText('Reply paragraph 20.', { exact: true })).toBeAttached();
  await page.waitForTimeout(300);
  expect(Math.abs((await top()) - reading)).toBeLessThan(2);
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  await expect(jump).toHaveClass(/live/);
  await jump.click();
  await expect(page.getByText('Reply paragraph 20.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
});

for (const by of ['wheel', 'elsewhere'] as const)
  test(`${by === 'wheel' ? "the reader's wheel" : 'a scroll from elsewhere, such as find in page,'} ends a glide where it is @webkit`, async ({
    page,
  }) => {
    const { composer, second, scroll } = await finishedChat(page);
    const top = () => scroll.evaluate((el) => el.scrollTop);
    // The pointer rests over the conversation, and Enter sends a message long enough to glide
    // for a while.
    await scroll.hover();
    await composer.fill(paragraphs('Question', 30));
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    const start = await top();
    await composer.press('Enter');
    await page.waitForFunction(
      (start) => document.querySelector('.chat-scroll')!.scrollTop > start + 10,
      start,
      { polling: 'raf' },
    );
    if (by === 'wheel') await page.mouse.wheel(0, -400);
    // No wheel, pointer or key reaches the conversation, as when find in page shows a match.
    else await scroll.evaluate((el) => (el.scrollTop -= 400));
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(300);
    // The glide does not resume, and the reply arrives below without moving the reader.
    await page.waitForTimeout(800);
    const reading = await top();
    await expect.poll(() => fromEnd(page)).toBeGreaterThan(300);
    const run = await second();
    await emit(page, run.runId, { kind: 'text', text: paragraphs('Reply', 20) });
    await expect(page.getByText('Reply paragraph 20.', { exact: true })).toBeAttached();
    await page.waitForTimeout(300);
    expect(Math.abs((await top()) - reading)).toBeLessThan(2);
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  });

test('a position the content moves under a glide keeps the chat following @webkit', async ({
  page,
}) => {
  const { composer, second, scroll } = await finishedChat(page);
  await composer.fill(paragraphs('Question', 30));
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  const start = await scroll.evaluate((el) => el.scrollTop);
  // What a reply ending this soon does, in a frame of the glide close to its end: the
  // conversation is shorter for a moment as its activity folds, which pulls the position up with
  // it, and then taller than it was with the reply's footer.
  const moved = page.evaluate(
    (start) =>
      new Promise<number>((resolve) => {
        const el = document.querySelector<HTMLElement>('.chat-scroll')!;
        const watch = () => {
          const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
          if (el.scrollTop <= start || gap > 120) return requestAnimationFrame(watch);
          const [sent] = [...el.querySelectorAll<HTMLElement>('[data-testid="message"]')].slice(-2);
          const before = el.scrollTop;
          sent.style.overflow = 'hidden';
          sent.style.height = `${sent.getBoundingClientRect().height - gap - 4}px`;
          // Reading the position lays out the shorter conversation, which clamps it.
          resolve(before - el.scrollTop);
          sent.style.overflow = '';
          sent.style.height = '';
          sent.style.marginBottom = '70px';
        };
        watch();
      }),
    start,
  );
  await composer.press('Enter');
  expect(await moved).toBeGreaterThan(2);
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeHidden();
  // Following goes on once the glide has ended.
  const run = await second();
  await emit(page, run.runId, { kind: 'text', text: paragraphs('Reply', 20) });
  await expect(page.getByText('Reply paragraph 20.', { exact: true })).toBeInViewport();
  await expect.poll(() => fromEnd(page)).toBeLessThan(2);
});

test('a chat whose last reply holds a visualization opens at its end once the visual sizes itself', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draw it');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [run] = await heldRuns(page);
  // A visual taller than its initial frame, near the end of the reply.
  const source = '<div style="height: 700px; background: var(--viz-series-1)">Tall visual</div>';
  await emit(page, run.runId, {
    kind: 'visualization',
    visualization: { id: 'tall', title: 'Tall', revision: 1, source },
  });
  await emit(page, run.runId, {
    kind: 'text',
    text: `${paragraphs('Before', 40)}\n\n<!-- visualize:tall -->\n\nAfter the visual.`,
  });
  await page.evaluate((id) => (window as any).capabilityRuns[id].finish('complete'), run.runId);
  const frame = page.locator('iframe[title="Tall visualization"]');
  await expect.poll(() => frame.evaluate((el) => el.getBoundingClientRect().height)).toBe(700);

  // Open another chat, then come back to this one.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chat(page, 'Draw it').click();
  await expect.poll(() => frame.evaluate((el) => el.getBoundingClientRect().height)).toBe(700);
  await page.waitForTimeout(500);
  expect(await fromEnd(page)).toBeLessThan(2);
  await expect(page.getByText('After the visual.', { exact: true })).toBeInViewport();
});

// This computer and another one that runs a reply and publishes it through the relay.
const token = 'synthetic-follow-relay-key-for-browser-checks';
const here = {
  id: '11111111-1111-4111-8111-111111111111',
  computerId: '22222222-2222-4222-8222-222222222222',
  name: 'Desktop',
  platform: 'windows' as const,
};
const there = {
  id: '33333333-3333-4333-8333-333333333333',
  computerId: '44444444-4444-4444-8444-444444444444',
};

function remoteWorkspace() {
  const at = '2026-09-20T09:00:00.000Z';
  const account = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Claude',
    provider: 'claude',
    purpose: 'personal',
  };
  const connection = {
    id: '66666666-6666-4666-8666-666666666666',
    environmentId: there.id,
    accountId: account.id,
    profile: 'existing',
  };
  const settings = {
    provider: 'claude',
    model: 'opus',
    reasoning: 'high',
    instructions: '',
    connectionId: connection.id,
  };
  const message = (n: number, role: 'user' | 'assistant', text: string, status = 'complete') => ({
    id: `77777777-7777-4777-8777-${n.toString(16).padStart(12, '0')}`,
    role,
    blocks: [{ type: 'markdown', text }],
    status,
    createdAt: at,
    ...(role === 'assistant' ? { settings, modelName: 'Opus' } : {}),
  });
  return {
    version: 3,
    fleet: {
      computers: [
        { id: here.computerId, name: here.name },
        { id: there.computerId, name: 'Laptop' },
      ],
      environments: [
        { id: here.id, computerId: here.computerId, name: here.name, platform: here.platform },
        { id: there.id, computerId: there.computerId, name: 'Laptop', platform: 'windows' },
      ],
      accounts: [account],
      connections: [connection],
    },
    preferences: {
      lastProvider: 'claude',
      connectionByProvider: { claude: connection.id },
      modelByProvider: { claude: 'opus' },
      reasoningByProvider: { claude: { opus: 'high' } },
    },
    conversations: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        location: { computerId: there.computerId, environmentId: there.id, path: 'C:\\Projects' },
        settings,
        title: 'Remote reply',
        titleStatus: 'generated',
        createdAt: at,
        updatedAt: at,
        messages: [
          message(1, 'user', 'Earlier question'),
          message(2, 'assistant', paragraphs('Earlier', 60)),
          message(3, 'user', 'Latest question'),
          message(4, 'assistant', 'Starting on it.', 'running'),
        ],
      },
    ],
  };
}

async function pairedDesktop(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-follow-'));
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const request = (environment: string, method: string, path: string, body?: unknown) =>
    fetch(`${origin}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': environment,
        'content-type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  const seeded = await request(there.id, 'PUT', 'v1/state', {
    revision: 0,
    workspace: (({ preferences: _, ...shared }) => shared)(remoteWorkspace()),
  });
  expect(seeded.status).toBe(200);
  await page.exposeFunction('relayBridge', async (method: string, path: string, body?: unknown) => {
    const response = await request(here.id, method, path, body);
    return { status: response.status, body: await response.json() };
  });
  // The chat reaches this computer through the relay only.
  await page.exposeFunction('savedWorkspace', () => ({ ...remoteWorkspace(), conversations: [] }));
  await mockAppCalls(page);
  await page.addInitScript(
    ({ here, origin }) => {
      if (window.top !== window) return;
      const w = window as any;
      w.isTauri = true;
      let sync: unknown = null;
      const status = (id: string) => ({
        id,
        installed: true,
        auth: 'ready',
        version: 'Synthetic CLI',
        detail: 'Verified fixture',
        location: 'Windows',
      });
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 0,
        unregisterCallback() {},
        async invoke(command: string, args: any) {
          args = w.studioCallArguments(command, args);
          switch (command) {
            case 'get_installation':
              return here;
            case 'load_workspace':
              return w.saved ?? w.savedWorkspace();
            case 'save_workspace':
              w.saved = JSON.parse(JSON.stringify(args.workspace));
              return;
            case 'save_workspace_patch': {
              const kept = new Map((w.saved?.conversations ?? []).map((c: any) => [c.id, c]));
              const sent = new Map(args.upsert.map((c: any) => [c.id, c]));
              const conversations = args.order.map((id: string) => sent.get(id) ?? kept.get(id));
              if (conversations.some((c: unknown) => !c))
                throw new Error('The whole workspace is needed to save this change.');
              w.saved = JSON.parse(JSON.stringify({ ...args.index, conversations }));
              return;
            }
            case 'load_sync_state':
              return sync;
            case 'save_sync_state':
              sync = w.studioCheckpoint(sync, args);
              w.synced = true;
              return;
            case 'relay_resume':
              return origin;
            case 'relay_request':
              return w.relayBridge(args.method, args.path, args.body);
            case 'desktop_notification_settings':
              return { enabled: false, sound: false };
            case 'plugin:window|is_maximized':
              return false;
            case 'plugin:event|listen':
              return 0;
            case 'live_account_updates':
            case 'background_work':
              return [];
            case 'discover_wsl':
              return { distributions: [], warning: null };
            case 'inspect_environment_clis':
              return [{ id: 'claude', path: 'C:\\CLIs\\claude.exe' }];
            case 'detect_providers':
              return [status('claude')];
            case 'detect_connection':
            case 'detect_environment_login':
              return status(args.provider);
            case 'list_models': {
              const model = (id: string, name: string) => ({
                id,
                name,
                reasoningLevels: ['low', 'medium', 'high'],
                defaultReasoning: 'medium',
              });
              return {
                claude: [model('', 'CLI default'), model('opus', 'Opus')],
                codex: [model('', 'CLI default')],
                gemini: [model('', 'CLI default')],
              };
            }
          }
        },
      };
    },
    { here, origin },
  );
  const read = async () =>
    (await (await request(there.id, 'GET', 'v1/state')).json()) as {
      revision: number;
      workspace: { conversations: { title: string; messages: any[] }[] };
    };
  return {
    /** The other computer publishes more of its running reply, as while streaming. */
    async publish(text: string) {
      const state = await read();
      const chat = state.workspace.conversations.find((c) => c.title === 'Remote reply')!;
      chat.messages.at(-1)!.blocks[0].text += `\n\n${text}`;
      const response = await request(there.id, 'POST', 'v1/state/patch', {
        revision: state.revision,
        upsert: [chat],
      });
      expect(response.status).toBe(200);
    },
    async close() {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('an open chat follows a reply another computer publishes through the relay', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const laptop = await pairedDesktop(page);
  try {
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => !!(window as any).synced), { timeout: 20_000 })
      .toBe(true);
    await chat(page, 'Remote reply').click();
    await expect(page.getByText('Starting on it.', { exact: true })).toBeVisible();
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    await laptop.publish(paragraphs('Remote', 50));
    await expect(page.getByText('Remote paragraph 50.', { exact: true })).toBeAttached({
      timeout: 15_000,
    });
    await expect.poll(() => fromEnd(page)).toBeLessThan(2);
    await expect(page.getByText('Remote paragraph 50.', { exact: true })).toBeInViewport();
  } finally {
    await laptop.close();
  }
});
