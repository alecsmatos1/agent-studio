import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// Workflows (docs/WORKFLOWS.md): the sidebar lists them, a workflow shows its graph with its chat
// as a card beside it on demand and its run history as a popup, and a chat of yours can become
// one, on the desktop mock, whose replies wait until a test finishes them and whose workflow store
// lives in local storage.

type Request = {
  runId: string;
  conversationId: string;
  agent: { provider: string; reasoning: string; instructions: string };
  mission?: { runId: string; role: string };
  messages: { role: string; text: string }[];
};
const requests = (page: Page) =>
  page.evaluate(() => ((window as any).runRequests ?? []) as Request[]);
/** Ends a reply the mock holds, with its answer. */
async function reply(page: Page, runId: string, text: string, status = 'complete') {
  await page.evaluate(
    ({ runId, text, status }) => {
      const run = (window as any).capabilityRuns[runId];
      run.emit({ kind: 'text', text });
      run.finish(status);
    },
    { runId, text, status },
  );
}
/** Sends a workflow tool call as the host would, and waits for the page's answer. */
async function call(page: Page, request: Request, tool: string, input: unknown) {
  const id = crypto.randomUUID();
  await page.evaluate((call) => (window as any).emitTauriEvent('studio-workflow-call', call), {
    id,
    runId: request.runId,
    conversationId: request.conversationId,
    connectionId: null,
    tool,
    input,
    mission: request.mission ?? null,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) => ((window as any).workflowAnswers ?? []).find((a: any) => a.id === id),
        id,
      ),
    )
    .toBeTruthy();
  return page.evaluate(
    (id) => ((window as any).workflowAnswers ?? []).find((a: any) => a.id === id),
    id,
  ) as Promise<{ text: string; error: boolean }>;
}
async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
const agentMode = (page: Page) => page.getByRole('tab', { name: 'Agent', exact: true });
const workflowMode = (page: Page) => page.getByRole('tab', { name: /^Workflow/ });
/** The sidebar's list of workflows, in its Workflow mode. */
async function workflowList(page: Page) {
  const tab = workflowMode(page);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  return page.getByRole('list', { name: 'Workflows' });
}
/** A new workflow chat, from the plus of the sidebar's Workflow mode. */
async function newWorkflowChat(page: Page) {
  await workflowList(page);
  await page.getByRole('button', { name: 'New workflow' }).click();
}
/** A new static workflow whose assistant saved these steps, its graph on screen. */
async function savedWorkflow(
  page: Page,
  name: string,
  nodes: (start: any) => unknown[],
  edges: (start: string) => unknown[],
) {
  await newWorkflowChat(page);
  await send(page, `Make ${name}.`);
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [assistant] = await requests(page);
  const workflowId = assistant.agent.instructions.match(/workflow ([0-9a-f-]{36})/)![1];
  const read = JSON.parse((await call(page, assistant, 'workflow_read', { id: workflowId })).text);
  const saved = await call(page, assistant, 'workflow_save', {
    id: workflowId,
    revision: read.revision,
    name,
    nodes: nodes(read.nodes[0]),
    edges: edges(read.nodes[0].key),
  });
  expect(saved.error).toBe(false);
  await reply(page, assistant.runId, 'Done.');
  return { assistant, workflowId };
}

test('a static workflow starts from a chat and shows its graph, its chat beside it', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  // An ordinary chat is a card on the workspace.
  expect(
    await page.locator('.chat-layout').evaluate((e) => getComputedStyle(e).borderTopLeftRadius),
  ).not.toBe('0px');
  // The sidebar starts in Agent mode. Workflow shows the workflows in the chats' place and, with
  // none shown before, a new one to start; Agent goes back to the chats.
  await expect(agentMode(page)).toHaveAttribute('aria-selected', 'true');
  await workflowMode(page).click();
  await expect(workflowMode(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Workflows' })).toContainText('No workflows');
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveCount(0);
  await expect(page.getByLabel('Search workflows')).toHaveAttribute(
    'placeholder',
    'Search workflows',
  );
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toBeVisible();
  await agentMode(page).click();
  await expect(page.getByRole('tab', { name: /^Active/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toHaveCount(0);
  // The arrow keys switch too, keeping the focus on the tabs.
  await agentMode(page).press('ArrowRight');
  await expect(workflowMode(page)).toBeFocused();
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toBeVisible();
  await workflowMode(page).press('Home');
  await expect(agentMode(page)).toBeFocused();
  await expect(page.getByRole('tab', { name: /^Active/ })).toBeVisible();
  await newWorkflowChat(page);
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute(
    'placeholder',
    'Describe the workflow…',
  );
  await expect(page.getByRole('radio', { name: 'Static' })).toHaveAttribute('aria-checked', 'true');
  // Before its first message, the graph it starts with shows beside its chat, which stays open.
  const graph = page.locator('.workflow-main');
  const card = page.locator('.workflow-chat-card');
  await expect(graph.locator('.workflow-card')).toHaveText(/Manual/);
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Close the chat' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Dynamic' }).click();
  await expect(graph.locator('.workflow-card')).toHaveClass(/kind-orchestrator/);
  await page.getByRole('radio', { name: 'Static' }).click();
  await expect(graph.locator('.workflow-card')).toHaveText(/Manual/);
  const canvasTop = async () => (await graph.locator('.workflow-canvas').boundingBox())!.y;
  const drafted = await canvasTop();
  await send(page, 'Write about swords every morning.');
  // The chat becomes the workflow's assistant: Claude at its maximum reasoning, told which
  // workflow it changes.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [assistant] = await requests(page);
  expect(assistant.agent.provider).toBe('claude');
  expect(assistant.agent.reasoning).toBe('max');
  expect(assistant.mission).toBeUndefined();
  const workflowId = assistant.agent.instructions.match(/workflow ([0-9a-f-]{36})/)?.[1];
  expect(workflowId).toBeTruthy();
  expect(assistant.messages.at(-1)?.text).toBe('Write about swords every morning.');
  // The graph takes the chat's place, where the new one was, and the chat shows as a card at its
  // left, with its toolbar.
  await expect(graph.getByLabel('Workflow name')).toBeVisible();
  await expect(graph.locator('.workflow-card')).toHaveCount(1);
  expect(await canvasTop()).toBe(drafted);
  await expect(card.getByRole('combobox', { name: 'Agent' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Close the chat' })).toBeVisible();
  // The assistant saves a workflow, which the graph shows at once, from top to bottom.
  const read = JSON.parse((await call(page, assistant, 'workflow_read', { id: workflowId })).text);
  const saved = await call(page, assistant, 'workflow_save', {
    id: workflowId,
    revision: read.revision,
    name: 'Sword writer',
    nodes: [
      read.nodes[0],
      { key: 'write', type: 'agent', title: 'Write', config: { prompt: 'Write about swords.' } },
      { key: 'finish', type: 'end', title: 'Finish', config: { output: '{{write.output}}' } },
    ],
    edges: [
      { source: read.nodes[0].key, target: 'write' },
      { source: 'write', target: 'finish' },
    ],
  });
  expect(saved.error).toBe(false);
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await expect(graph.getByLabel('Workflow name')).toHaveValue('Sword writer');
  // The chat is named by its workflow.
  await expect(page.locator('.page-title')).toHaveText('Sword writer');
  await expect(graph.locator('.svelte-flow__background')).toBeVisible();
  const top = async (title: string) =>
    (await graph.locator('.workflow-card').filter({ hasText: title }).boundingBox())!.y;
  expect(await top('Write')).toBeLessThan(await top('Finish'));
  const cardBox = (await card.boundingBox())!;
  const graphBox = (await graph.boundingBox())!;
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(graphBox.x + 1);
  // Closed, the chat gives the graph the whole width; the graph's Chat button opens it again.
  await reply(page, assistant.runId, 'It writes about swords each morning.');
  await card.getByRole('button', { name: 'Close the chat' }).click();
  await expect(card).toBeHidden();
  await expect
    .poll(async () => (await graph.boundingBox())!.width)
    .toBeGreaterThan(graphBox.width + cardBox.width - 20);
  const chatButton = graph.getByRole('button', { name: 'Chat', exact: true });
  await expect(chatButton).toHaveAttribute('aria-pressed', 'false');
  await chatButton.click();
  await expect(card).toBeVisible();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  // It is the Workflow mode's: its list has it, marked while it is on screen, and the chat lists
  // of the Agent mode leave it out.
  await expect(workflowMode(page)).toHaveAttribute('aria-selected', 'true');
  const item = page
    .getByRole('list', { name: 'Workflows' })
    .locator('.workflow-item')
    .filter({ hasText: 'Sword writer' });
  await expect(item).toHaveAttribute('aria-current', 'page');
  await agentMode(page).click();
  await expect(graph).toHaveCount(0);
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  // Workflow brings it back as it was, its chat open; a new chat is the Agent mode's again.
  await workflowMode(page).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await expect(card).toBeVisible();
  await page.keyboard.press('Control+n');
  await expect(graph).toHaveCount(0);
  await expect(agentMode(page)).toHaveAttribute('aria-selected', 'true');
  // Opened from the list, it shows its graph, its chat closed until you ask for it.
  await workflowMode(page).click();
  await item.click();
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await expect(card).toBeHidden();
  await chatButton.click();
  await expect(
    page.locator('.message').filter({ hasText: 'It writes about swords' }),
  ).toBeVisible();
});

test('a workflow is edited on its graph, beside its chat card, which resizes', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const { assistant, workflowId } = await savedWorkflow(
    page,
    'Sword writer',
    (start) => [
      start,
      { key: 'write', type: 'agent', title: 'Write', config: { prompt: 'Write about swords.' } },
      { key: 'finish', type: 'end', title: 'Finish', config: { output: '{{write.output}}' } },
    ],
    (start) => [
      { source: start, target: 'write' },
      { source: 'write', target: 'finish' },
    ],
  );
  const graph = page.locator('.workflow-main');
  const card = page.locator('.workflow-chat-card');
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await expect(card).toBeVisible();
  // A connection dragged from a step's output to empty space adds a step there.
  const write = graph.locator('.workflow-card').filter({ hasText: 'Write' });
  const handle = write.locator('.svelte-flow__handle.source').first();
  // The graph glides into view after a change; the handle is where it stays.
  await expect
    .poll(async () => {
      const first = JSON.stringify(await handle.boundingBox());
      await page.waitForTimeout(100);
      return first === JSON.stringify(await handle.boundingBox());
    })
    .toBe(true);
  const from = (await handle.boundingBox())!;
  const canvas = (await graph.locator('.workflow-canvas').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 100, canvas.y + canvas.height - 70, { steps: 8 });
  await page.mouse.move(canvas.x + canvas.width - 80, canvas.y + canvas.height - 60, { steps: 4 });
  await page.mouse.up();
  await page
    .getByRole('menu', { name: 'Add a step here' })
    .getByRole('menuitem', { name: 'Confirm' })
    .click();
  await expect(graph.locator('.workflow-card')).toHaveCount(4);
  await expect(graph.locator('.svelte-flow__edge')).toHaveCount(3);
  await graph.getByLabel('What to confirm').fill('Publish it?');
  // Your edits save by themselves, merged with the agent's.
  await expect
    .poll(async () => {
      const now = JSON.parse(
        (await call(page, assistant, 'workflow_read', { id: workflowId })).text,
      );
      return now.nodes.find((n: any) => n.type === 'confirm')?.config.question;
    })
    .toBe('Publish it?');
  // The inspector never scrolls sideways.
  const inspector = graph.locator('.inspector-body');
  expect(
    await inspector.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  // With the chat closed, the graph has the room for a step's settings beside it.
  await card.getByRole('button', { name: 'Close the chat' }).click();
  await expect(card).toBeHidden();
  // An agent can take the account of the workflow's own chat.
  await graph.locator('.workflow-card').filter({ hasText: 'Write' }).click();
  await graph.getByRole('combobox', { name: 'Account' }).click();
  await page.getByRole('option', { name: 'Same as workflow chat' }).click();
  await expect
    .poll(async () => {
      const now = JSON.parse(
        (await call(page, assistant, 'workflow_read', { id: workflowId })).text,
      );
      return now.nodes.find((n: any) => n.key === 'write')?.config.connectionId;
    })
    .toBe('workflow');
  // The step's settings resize from the gap beside them, by keys and by pointer.
  const inspectorBox = graph.locator('.workflow-inspector');
  const sideGap = page.getByRole('separator', { name: 'Resize side panel' });
  const [canvasBox, sideBox, settingsBox] = await Promise.all([
    graph.locator('.workflow-canvas').boundingBox(),
    sideGap.boundingBox(),
    inspectorBox.boundingBox(),
  ]);
  expect(sideBox!.x).toBeGreaterThanOrEqual(canvasBox!.x + canvasBox!.width - 1);
  expect(sideBox!.x + sideBox!.width).toBeLessThanOrEqual(settingsBox!.x + 1);
  await sideGap.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await inspectorBox.boundingBox())!.width)
    .toBeGreaterThan(settingsBox!.width + 5);
  const side = (await sideGap.boundingBox())!;
  await page.mouse.move(side.x + side.width / 2, side.y + 150);
  await page.mouse.down();
  await page.mouse.move(side.x - 50, side.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await inspectorBox.boundingBox())!.width)
    .toBeGreaterThan(settingsBox!.width + 40);
  // The chat card resizes from the gap between it and the graph, by keys and by pointer.
  await graph.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(card).toBeVisible();
  const edge = page.getByRole('separator', { name: 'Resize chat' });
  const [cardBox, edgeBox, mainBox] = await Promise.all([
    card.boundingBox(),
    edge.boundingBox(),
    graph.boundingBox(),
  ]);
  expect(edgeBox!.x).toBeGreaterThanOrEqual(cardBox!.x + cardBox!.width - 1);
  expect(edgeBox!.x + edgeBox!.width).toBeLessThanOrEqual(mainBox!.x + 1);
  const before = cardBox!.width;
  await edge.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(before + 5);
  const grip = (await edge.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 120);
  await page.mouse.down();
  await page.mouse.move(grip.x + 90, grip.y + 120, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(before + 70);
});

test('a workflow runs in its graph, through an agent and a Confirm step, with its history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await savedWorkflow(
    page,
    'Poster',
    (start) => [
      start,
      { key: 'draft', type: 'agent', title: 'Draft', config: { prompt: 'Draft a post.' } },
      { key: 'ok', type: 'confirm', config: { question: 'Publish it?', approve: 'Publish' } },
      { key: 'yes', type: 'end', config: { output: 'published' } },
      { key: 'no', type: 'end', config: { output: 'kept' } },
    ],
    (start) => [
      { source: start, target: 'draft' },
      { source: 'draft', target: 'ok' },
      { source: 'ok', sourcePort: 'approved', target: 'yes' },
      { source: 'ok', sourcePort: 'rejected', target: 'no' },
    ],
  );
  const graph = page.locator('.workflow-main');
  const card = page.locator('.workflow-chat-card');
  await expect(graph.locator('.workflow-card')).toHaveCount(5);
  // With nothing to choose, Run starts at once, and the run shows in the workflow's place.
  await graph.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(graph.locator('.run-status')).toHaveText('Running');
  await expect(graph.getByRole('button', { name: 'Back to the workflow' })).toBeVisible();
  // Its history waits behind History until something needs it.
  const historyButton = graph.getByRole('button', { name: 'History', exact: true });
  await expect(historyButton).toHaveAttribute('aria-pressed', 'false');
  await expect(graph.getByRole('region', { name: 'History' })).toHaveCount(0);
  // While it runs, it leads the Agent mode's Active list; opened from there, it switches to
  // Workflow, whose tab takes the focus its row had.
  await agentMode(page).click();
  const runRow = page.locator('.workflow-run-item').filter({ hasText: 'Poster' });
  await runRow.focus();
  await page.keyboard.press('Enter');
  await expect(workflowMode(page)).toBeFocused();
  await expect(graph.locator('.run-status')).toHaveText('Running');
  // Its agent's chat opens where the workflow's chat goes, to read, with the way back.
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const draft = (await requests(page))[1];
  await graph.getByRole('button', { name: 'Open the chat of Draft' }).click();
  await expect(page.locator('.page-title')).toHaveText('Poster · Draft');
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  await reply(page, draft.runId, 'A post about swords.');
  await expect(card.locator('.message').filter({ hasText: 'A post about swords.' })).toBeVisible();
  await expect(graph.locator('.run-status')).toHaveText('Running');
  await card.locator('.workflow-owned').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.locator('.page-title')).toHaveText('Poster');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(graph.locator('.run-status')).toHaveText('Running');
  // The run asks for approval with the step's own buttons, opening its history to show it.
  const waiting = graph.getByRole('region', { name: 'Waiting for you' });
  await expect(historyButton).toHaveAttribute('aria-pressed', 'true');
  await waiting.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(graph.locator('.run-status')).toHaveText('Completed');
  await expect(graph.getByRole('region', { name: 'Run', exact: true })).toContainText('published');
  // Its history lists each step as it ran, in order, each opening on what it did.
  const history = graph.getByRole('region', { name: 'History' });
  await expect(history.locator('.entry-title > span')).toHaveText([
    'Manual',
    'Draft',
    'ok',
    'yes',
    'Completed',
  ]);
  await expect(history.locator('.entry').nth(2)).toContainText('Approved');
  await history.locator('.entry-head').nth(3).click();
  await expect(history.locator('.entry').nth(3)).toContainText('published');
  // Choosing a step on the graph shows its entries alone.
  await graph.locator('.workflow-card').filter({ hasText: 'ok' }).click();
  await expect(history.locator('.entry')).toHaveCount(1);
  await history.getByRole('button', { name: 'Show the whole history' }).click();
  await expect(history.locator('.entry')).toHaveCount(5);
  // It closes and opens again from History.
  await graph.getByRole('button', { name: 'Close the history' }).click();
  await expect(history).toHaveCount(0);
  await historyButton.click();
  await expect(history.locator('.entry')).toHaveCount(5);
  // Back, the workflow keeps its runs beside Run, and a run opens in its place again.
  await graph.getByRole('button', { name: 'Back to the workflow' }).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(5);
  await graph.getByRole('combobox', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Completed');
  await page.getByRole('option').click();
  await expect(graph.locator('.run-status')).toHaveText('Completed');
  // The sidebar lists the workflow, no longer running, and it no longer leads the Active list.
  const item = (await workflowList(page)).locator('.workflow-item').filter({ hasText: 'Poster' });
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(item.locator('.conversation-running')).toHaveCount(0);
  await agentMode(page).click();
  await expect(page.getByRole('tab', { name: /^Active/ })).toBeVisible();
  await expect(page.locator('.workflow-run-item')).toHaveCount(0);
});

test('the graph has right-click menus, and step settings colour the values they name @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await savedWorkflow(
    page,
    'News',
    (start) => [
      start,
      {
        key: 'facts',
        type: 'set',
        title: 'Facts',
        config: {
          values: [{ name: 'topic', value: 'About {{trigger.text}} from {{nowhere.output}}' }],
        },
      },
      { key: 'done', type: 'end', title: 'Done', config: { output: '{{facts.output}}' } },
    ],
    (start) => [
      { source: start, target: 'facts' },
      { source: 'facts', target: 'done' },
    ],
  );
  const graph = page.locator('.workflow-main');
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await page.locator('.workflow-chat-card').getByRole('button', { name: 'Close the chat' }).click();
  // A right-click on a step offers its settings, a copy and its removal. The menu takes the
  // keyboard: the arrows move through it, and Escape closes it, leaving the step unselected.
  const facts = graph.locator('.workflow-card').filter({ hasText: 'Facts' });
  await facts.click({ button: 'right' });
  const stepMenu = page.getByRole('menu', { name: 'Step' });
  await expect(stepMenu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(stepMenu.getByRole('menuitem', { name: 'Duplicate' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(stepMenu).toHaveCount(0);
  await expect(graph.locator('.svelte-flow__node.selected')).toHaveCount(0);
  await facts.click({ button: 'right' });
  await stepMenu.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(stepMenu).toHaveCount(0);
  await expect(graph.locator('.svelte-flow__node.selected')).toHaveCount(1);
  // A Set step names each value on a line of its own, with the value below it across the
  // settings, coloured by what it names and marked where it names no step.
  const inspector = graph.locator('.inspector-body');
  const value = inspector.getByLabel('Value of topic');
  await expect(value).toHaveValue('About {{trigger.text}} from {{nowhere.output}}');
  const field = inspector
    .locator('.template-field')
    .filter({ has: page.getByLabel('Value of topic') });
  await expect(field.locator('.value-trigger')).toHaveText('{{trigger.text}}');
  await expect(field.locator('.value-unknown')).toHaveText('{{nowhere.output}}');
  const settingsWidth = (await inspector.boundingBox())!.width;
  expect((await value.boundingBox())!.width).toBeGreaterThan(settingsWidth - 80);
  expect(
    (await inspector.getByLabel('Name', { exact: true }).boundingBox())!.width,
  ).toBeGreaterThan(settingsWidth / 2);
  // Colours follow the text as it is written, and the field grows with it.
  await value.fill('Start\n{{facts.output}}\nand {{input.topic}} for {{item.name}}');
  await expect(field.locator('.value-step')).toHaveText('{{facts.output}}');
  await expect(field.locator('.value-input')).toHaveText('{{input.topic}}');
  await expect(field.locator('.value-loop')).toHaveText('{{item.name}}');
  await expect(field.locator('.value-unknown')).toHaveCount(0);
  expect(await value.evaluate((area) => area.scrollHeight - area.clientHeight)).toBeLessThanOrEqual(
    1,
  );
  const [mirror, area] = await field.evaluate((element) =>
    ['.mirror', 'textarea'].map((selector) => {
      const box = element.querySelector(selector)!.getBoundingClientRect();
      return { top: box.top, height: box.height };
    }),
  );
  expect(Math.abs(mirror.top - area.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(mirror.height - area.height)).toBeLessThanOrEqual(1);
  // The values to insert carry the same colours.
  await expect(inspector.locator('.value-chip.chip-trigger').first()).toBeVisible();
  // A copy keeps the step's settings under a key of its own; removing it leaves the rest.
  await facts.click({ button: 'right' });
  await stepMenu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(4);
  const copy = graph.locator('.workflow-card').filter({ hasText: 'Facts' }).nth(1);
  await copy.click({ button: 'right' });
  await stepMenu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  // The only trigger cannot be removed.
  await graph.locator('.workflow-card').filter({ hasText: 'Manual' }).click({ button: 'right' });
  await expect(stepMenu.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(stepMenu).toHaveCount(0);
  // A right-click on a connection removes it, once the graph stopped gliding to fit its view.
  await expect(graph.locator('.svelte-flow__edge')).toHaveCount(2);
  const connection = graph.locator('.svelte-flow__edge').first();
  await expect
    .poll(async () => {
      const first = JSON.stringify(await connection.boundingBox());
      await page.waitForTimeout(150);
      return first === JSON.stringify(await connection.boundingBox());
    })
    .toBe(true);
  await connection.click({ button: 'right', force: true });
  await page
    .getByRole('menu', { name: 'Connection' })
    .getByRole('menuitem', { name: 'Delete connection' })
    .click();
  await expect(graph.locator('.svelte-flow__edge')).toHaveCount(1);
  // A right-click on empty space adds a step there, or tidies the graph.
  const canvas = (await graph.locator('.workflow-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 50, canvas.y + 60, { button: 'right' });
  const graphMenu = page.getByRole('menu', { name: 'Graph' });
  await expect(graphMenu.getByRole('menuitem', { name: 'Arrange' })).toBeVisible();
  await expect(graphMenu.getByRole('menuitem', { name: 'Fit to view' })).toBeVisible();
  await graphMenu.getByRole('menuitem', { name: 'Message' }).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(4);
  // A press elsewhere closes a menu.
  const beside = (await graph.locator('.workflow-canvas').boundingBox())!;
  await page.mouse.click(beside.x + 30, beside.y + beside.height / 2, { button: 'right' });
  await expect(graphMenu).toBeVisible();
  await graph.locator('.workflow-toolbar').click({ position: { x: 4, y: 4 } });
  await expect(graphMenu).toHaveCount(0);
  // The trigger's choices of what starts it each show their icon.
  await graph.locator('.workflow-card').filter({ hasText: 'Manual' }).click();
  await inspector.getByRole('combobox', { name: 'Trigger' }).click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(7);
  expect(
    await options.evaluateAll((all) => all.every((o) => o.querySelector('.option-icon svg'))),
  ).toBe(true);
  await page.keyboard.press('Escape');
});

test('a dynamic workflow starts from a chat and its orchestrator works in it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await newWorkflowChat(page);
  await page.getByRole('radio', { name: 'Dynamic' }).click();
  await expect(page.getByRole('heading', { name: /the goal\?/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Runs on/ })).toBeVisible();
  // Its graph starts with its orchestrator, beside the chat, saying where it will run and on
  // which account.
  const panel = page.locator('.workflow-main');
  await expect(panel.locator('.workflow-card')).toHaveClass(/kind-orchestrator/);
  await expect(panel.locator('.workflow-card')).toContainText('Desktop · Claude CLI login');
  const canvasTop = async () => (await panel.locator('.workflow-canvas').boundingBox())!.y;
  const drafted = await canvasTop();
  await send(page, 'Make every asset of the game, reviewed.');
  // The chat is its orchestrator: your words are its first message, its role its instructions.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [orchestrator] = await requests(page);
  expect(orchestrator.mission?.role).toBe('orchestrator');
  expect(orchestrator.messages.at(-1)?.text).toBe('Make every asset of the game, reviewed.');
  expect(orchestrator.agent.instructions).toMatch(
    /orchestrator of an Agent Studio dynamic workflow/,
  );
  // Its graph takes the chat's place, where the new one was, the orchestrator's chat a card at its
  // left that keeps its share of the space as the window grows and shrinks.
  await expect(panel.locator('.run-status')).toHaveText('Running');
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  expect(await canvasTop()).toBe(drafted);
  const share = () =>
    page.evaluate(() => {
      const card = document.querySelector('.workflow-chat-card')!;
      return card.getBoundingClientRect().width / card.parentElement!.getBoundingClientRect().width;
    });
  expect(await share()).toBeCloseTo(0.36, 1);
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(share).toBeCloseTo(0.36, 1);
  await page.setViewportSize({ width: 1380, height: 900 });
  // It plans and starts an agent while its turn runs.
  const plan = await call(page, orchestrator, 'dynamic_plan', {
    tasks: [{ id: 'sword', title: 'Sword model' }],
  });
  expect(plan.error).toBe(false);
  const spawned = await call(page, orchestrator, 'dynamic_spawn', {
    title: 'Sword',
    task: 'Model the sword.',
    taskId: 'sword',
  });
  expect(spawned.error).toBe(false);
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const worker = (await requests(page))[1];
  expect(worker.mission).toBeUndefined();
  await expect(panel.locator('.workflow-card').filter({ hasText: 'Sword model' })).toBeVisible();
  // While it runs, the sidebar's list counts its time and it leads the Agent mode's Active list.
  const item = (await workflowList(page))
    .locator('.workflow-item')
    .filter({ hasText: 'Make every asset of the game' });
  await expect(item.locator('.conversation-running')).toBeVisible();
  await expect(workflowMode(page)).toContainText('1');
  await agentMode(page).click();
  await expect(
    page.locator('.workflow-run-item').filter({ hasText: 'Make every asset of the game' }),
  ).toBeVisible();
  await workflowMode(page).click();
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  // The agent's chat asks you something: the run shows it, with no alert of the chat's own.
  await page.evaluate((runId) => {
    const w = window as any;
    w.testQuestion = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'style',
          header: 'Style',
          question: 'Which style?',
          multiSelect: false,
          options: [{ label: 'Flat', description: '' }],
        },
      ],
    };
    w.capabilityRuns[runId].emit({ kind: 'question', question: w.testQuestion });
  }, worker.runId);
  const waiting = panel.getByRole('region', { name: 'Waiting for you' });
  await expect(waiting).toContainText('Sword');
  await waiting.getByRole('radio', { name: 'Flat' }).check();
  await waiting.getByRole('button', { name: 'Send answers' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).answersSent?.length ?? 0)).toBe(1);
  await expect(waiting).toHaveCount(0);
  const notices = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-notices') ?? '[]'),
  );
  expect(notices.filter((n: any) => n.conversationId === worker.conversationId)).toEqual([]);
  // Its chat opens in the orchestrator's place, beside the graph, to read without a composer,
  // with the way back.
  await panel.getByRole('button', { name: 'Open the chat of Sword' }).click();
  await expect(page.locator('.workflow-owned')).toContainText('Make every asset of the game');
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  await page.locator('.workflow-owned').getByRole('button', { name: 'Orchestrator' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  // Another chat's call of an orchestrator's tool is refused.
  const foreign = await call(
    page,
    { ...orchestrator, conversationId: worker.conversationId },
    'dynamic_state',
    {},
  );
  expect(foreign.error).toBe(true);
  await reply(page, orchestrator.runId, 'Started the sword.');
  await reply(page, worker.runId, 'The sword is in assets/sword.glb.');
  // The orchestrator hears the agent's reply in its next turn, shown in its chat as an update.
  await expect.poll(async () => (await requests(page)).length, { timeout: 15_000 }).toBe(3);
  const wake = (await requests(page))[2];
  expect(wake.conversationId).toBe(orchestrator.conversationId);
  expect(wake.messages.at(-1)?.text).toContain('The sword is in assets/sword.glb.');
  await expect(page.locator('.workflow-update')).toHaveCount(1);
  // Its summary leaves out the chat id written for the orchestrator.
  await expect(page.locator('.workflow-update summary')).toHaveText(
    /^\S+ Agent "Sword" finished\.$/,
  );
  const done = await call(page, wake, 'dynamic_complete', { summary: 'The sword is done.' });
  expect(done.error).toBe(false);
  await expect(panel.locator('.run-status')).toHaveText('Completed');
  // Its history shows the agent's reply where it finished.
  const history = panel.getByRole('region', { name: 'History' });
  const finished = history.locator('.entry').filter({ hasText: 'Sword finished' });
  await finished.locator('.entry-head').click();
  await expect(finished).toContainText('The sword is in assets/sword.glb.');
  // The sidebar still lists it, no longer running; its chats stay out of the Active list, which
  // it left once it ended.
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(item.locator('.conversation-running')).toHaveCount(0);
  // Opened from the list, a dynamic workflow shows its orchestrator's chat beside its graph,
  // however it was left; going back to it leaves the chat as it was.
  const card = page.locator('.workflow-chat-card');
  const chatButton = panel.getByRole('button', { name: 'Chat', exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Close the chat' }).click();
  await expect(card).toBeHidden();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+n');
  await expect(panel).toHaveCount(0);
  await workflowMode(page).click();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'false');
  await item.click();
  await expect(card).toBeVisible();
  await expect(chatButton).toHaveAttribute('aria-pressed', 'true');
  await agentMode(page).click();
  await expect(page.getByRole('tab', { name: /^Active/ })).toBeVisible();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  await expect(page.locator('.workflow-run-item')).toHaveCount(0);
});

test('a graph too wide to read whole starts at its orchestrator, beside its chat', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await newWorkflowChat(page);
  await page.getByRole('radio', { name: 'Dynamic' }).click();
  await send(page, 'Make every asset of the game, reviewed.');
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [orchestrator] = await requests(page);
  const panel = page.locator('.workflow-main');
  await expect(page.locator('.workflow-chat-card')).toBeVisible();
  // Twelve tasks side by side below the orchestrator make the graph too wide to read whole.
  const plan = await call(page, orchestrator, 'dynamic_plan', {
    tasks: Array.from({ length: 12 }, (_, i) => ({ id: `asset-${i + 1}`, title: `Asset ${i + 1}` })),
  });
  expect(plan.error).toBe(false);
  await expect(panel.locator('.workflow-card').filter({ hasText: 'Asset 12' })).toHaveCount(1);
  // It shows its first row, the orchestrator, in the view, its last task past the edge.
  const seen = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.workflow-main .workflow-canvas')!;
      const view = canvas.getBoundingClientRect();
      const box = (card: Element) => card.getBoundingClientRect();
      const cards = [...canvas.querySelectorAll('.workflow-card')];
      const top = box(cards.find((c) => c.classList.contains('kind-orchestrator'))!);
      const last = box(cards.find((c) => c.textContent?.includes('Asset 12'))!);
      return {
        orchestrator: top.left >= view.left && top.right <= view.right,
        cut: last.right > view.right,
      };
    });
  await expect.poll(seen).toEqual({ orchestrator: true, cut: true });
  await reply(page, orchestrator.runId, 'Planned.');
});

test('a chat of yours becomes a static or dynamic workflow from its toolbar', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await send(page, 'Every morning, collect the game news and summarise it.');
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [first] = await requests(page);
  await reply(page, first.runId, 'Here are three sources to watch.');
  await page.getByRole('button', { name: 'Make a workflow' }).click();
  await page
    .getByRole('menu', { name: 'Make a workflow' })
    .getByRole('menuitem', { name: 'Static' })
    .click();
  // The same chat asks its agent to build the workflow from what you discussed.
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const assistant = (await requests(page))[1];
  expect(assistant.conversationId).toBe(first.conversationId);
  expect(assistant.messages.at(-1)?.text).toMatch(
    /^Turn what we discussed in this conversation into this Agent Studio workflow/,
  );
  expect(assistant.agent.instructions).toMatch(/workflow [0-9a-f-]{36}/);
  // Its graph shows with the chat beside it, its earlier messages kept.
  const graph = page.locator('.workflow-main');
  await expect(graph.locator('.workflow-card')).toHaveCount(1);
  const card = page.locator('.workflow-chat-card');
  await expect(card.getByRole('button', { name: 'Close the chat' })).toBeVisible();
  await expect(
    card.locator('.message').filter({ hasText: 'Here are three sources to watch.' }),
  ).toBeVisible();
  await expect(card.locator('.workflow-update')).toHaveCount(1);
  // It left the chat lists for the workflows: the sidebar is in Workflow mode, whose list has it.
  await expect(workflowMode(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Workflows' }).locator('.workflow-item')).toHaveCount(
    1,
  );
  await agentMode(page).click();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  await workflowMode(page).click();
  await expect(graph.locator('.workflow-card')).toHaveCount(1);
  await reply(page, assistant.runId, 'It collects the news each morning.');
  // A chat that runs here can become a dynamic workflow too, whose orchestrator it becomes.
  await page.keyboard.press('Control+n');
  await expect(graph).toHaveCount(0);
  await send(page, 'Ship the demo build.');
  await expect.poll(async () => (await requests(page)).length).toBe(3);
  const second = (await requests(page))[2];
  await reply(page, second.runId, 'The demo needs a build and a page.');
  await page.getByRole('button', { name: 'Make a workflow' }).click();
  await page
    .getByRole('menu', { name: 'Make a workflow' })
    .getByRole('menuitem', { name: 'Dynamic' })
    .click();
  await expect.poll(async () => (await requests(page)).length).toBe(4);
  const orchestrator = (await requests(page))[3];
  expect(orchestrator.conversationId).toBe(second.conversationId);
  expect(orchestrator.mission?.role).toBe('orchestrator');
  expect(orchestrator.agent.instructions).toMatch(
    /orchestrator of an Agent Studio dynamic workflow/,
  );
  expect(orchestrator.messages.at(-1)?.text).toMatch(/^This conversation is now an Agent Studio/);
  // The orchestrator keeps the chat, as the card beside its graph.
  await expect(graph.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(
    page.locator('.message').filter({ hasText: 'The demo needs a build and a page.' }),
  ).toBeVisible();
  // The chat is the workflow's now: not one of the chats to move to History, snooze or pin.
  await expect(page.getByRole('button', { name: 'Move to history' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Snooze' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make a workflow' })).toHaveCount(0);
  // The workflows list both; while it runs, it leads the Active list as a workflow, never as a
  // chat.
  await expect(page.getByRole('list', { name: 'Workflows' }).locator('.workflow-item')).toHaveCount(
    2,
  );
  await agentMode(page).click();
  await expect(
    page.locator('.workflow-run-item').filter({ hasText: 'Ship the demo build.' }),
  ).toBeVisible();
  await expect(
    page.locator('#conversation-panel-active .conversation-item:not(.workflow-run-item)'),
  ).toHaveCount(0);
  await reply(page, orchestrator.runId, 'Planning.');
});

test('on a phone the drawer stays open on the mode it switches to @webkit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const sidebar = page.locator('#conversation-sidebar');
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await expect(sidebar).toHaveClass(/mobile-open/);
  // Behind the drawer the chat gives way to a new workflow; the drawer shows the workflows.
  await workflowMode(page).click();
  await expect(sidebar).toHaveClass(/mobile-open/);
  await expect(sidebar.getByRole('list', { name: 'Workflows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toBeVisible();
  await agentMode(page).click();
  await expect(sidebar).toHaveClass(/mobile-open/);
  await expect(sidebar.getByRole('tab', { name: /^Active/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close conversations' }).click();
  await expect(sidebar).not.toHaveClass(/mobile-open/);
});
