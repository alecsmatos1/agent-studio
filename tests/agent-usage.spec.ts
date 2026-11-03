import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { expectVisibleQuotaComparison } from './quota-helper';

// The fixture's `usage-pace` readings are halfway through their windows: 5-hour 70% used is
// ahead of the even-use guide and Weekly 25% below it. A test can give an account percentages
// of its own, leave limits out of its readings (`omit`), and hold a provider's readings until it
// releases them.
async function prepare(page: Page) {
  await mockDesktop(page, 'usage-pace');
  await page.addInitScript(() => {
    const state = window as any,
      native = state.__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (command: string, args: any) => {
      if (command === 'read_usage' && state.holdUsage?.includes(args.provider))
        await new Promise((resolve) => (state.heldUsage ??= []).push(resolve));
      const result = await invoke(command, args);
      const own = JSON.parse(
        localStorage.getItem(`test-usage-percent-${args.connectionId}`) ?? 'null',
      );
      if (command === 'read_usage' && own) {
        result.windows = result.windows.filter(
          (window: { label: string }) => !own.omit?.includes(window.label),
        );
        for (const window of result.windows)
          if (window.label in own) window.usedPercent = own[window.label];
      }
      return result;
    };
  });
}

const connectionNamed = (page: Page, name: string) =>
  page.evaluate((name) => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === name);
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  }, name);

// Adds a separate Claude profile in Connections, stays there, and returns its connection id.
async function addAccount(page: Page, name: string) {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return page.evaluate((name) => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === name);
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  }, name);
}

const connectionOf = (page: Page, provider: string) =>
  page.evaluate((provider) => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { provider: string }) => a.provider === provider);
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  }, provider);

test('the Agent picker shows each account’s 5-hour and weekly usage as bars', async ({ page }) => {
  await prepare(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        `test-usage-percent-${id}`,
        JSON.stringify({ '5-hour': 96, Weekly: 64 }),
      ),
    second,
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await page.evaluate(() => localStorage.removeItem('test-usage-requests'));

  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  const login = page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true });
  const other = page.getByRole('option', { name: 'Claude · Second Claude', exact: true });
  const codex = page.getByRole('option', { name: 'Codex', exact: true });
  // Each account's own reading, drawn and described as the bars below the composer.
  await expect(other.locator('.quota-bar')).toHaveText(['5-hour96% used', 'Weekly64% used']);
  await expect(login.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
  await expect(codex.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
  await expect(login).toHaveAccessibleDescription(
    '5-hour 70% used Ahead of pace Weekly 25% used Below pace',
  );
  await expect(other.locator('.quota-bar.usage-warning')).toHaveCount(2);
  await expect(login.locator('.quota-bar.usage-warning')).toHaveCount(1);
  await expect(login.locator('.quota-bar').first()).toHaveAttribute(
    'title',
    /^Resets .+\. Ahead of pace\.$/,
  );
  await expectVisibleQuotaComparison(login.locator('.usage-meter').first(), true);
  await expectVisibleQuotaComparison(login.locator('.usage-meter').last(), false);
  await expect(other.locator('.quota-fill').first()).toHaveAttribute('style', /width: 96%/);

  // Opening the picker read every account it lists, not only its Claude ones.
  const requests: { provider: string; connectionId: string }[] = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-usage-requests') ?? '[]'),
  );
  const codexId = await connectionOf(page, 'codex');
  expect(requests.map((r) => r.connectionId)).toEqual(
    expect.arrayContaining([second, codexId, await connectionOf(page, 'gemini')]),
  );

  // A wide list keeps the bars in columns beside the names.
  const list = page.getByRole('listbox');
  expect((await list.boundingBox())!.width).toBeGreaterThan(500);
  const name = (await login.locator('.option-name').boundingBox())!;
  const bars = (await login.locator('.quota-bars').boundingBox())!;
  expect(bars.x).toBeGreaterThan(name.x + name.width);
  const weekly = await page
    .locator('.option-aside .quota-bar.weekly')
    .evaluateAll((groups) => groups.map((group) => Math.round(group.getBoundingClientRect().x)));
  expect(weekly.length).toBeGreaterThanOrEqual(3);
  expect(new Set(weekly).size).toBe(1);
  await page.screenshot({ path: 'artifacts/agent-usage-picker.png' });

  // Choosing an account through its bars selects it.
  await other.locator('.quota-bars').click();
  await expect(agent).toHaveText(/Claude · Second Claude/);
});

test('picker usage waits for its first reading and leaves out accounts to sign in to', async ({
  page,
}) => {
  await prepare(page);
  await page.addInitScript(() => ((window as any).holdUsage = ['codex']));
  await page.goto('/');
  await chooseTestFolder(page);
  const codexId = await connectionOf(page, 'codex');
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  const codex = page.getByRole('option', { name: 'Codex', exact: true });
  // Until it is read, an account's limits wait in their places, whatever its provider.
  await expect(codex.locator('.quota-bar')).toHaveText(['5-hourChecking…', 'WeeklyChecking…']);
  await expect(codex.locator('.quota-bar.weekly')).toHaveCount(1);
  await expect(codex.locator('.usage-meter.unmeasured')).toHaveCount(2);
  await page.evaluate(() => {
    const state = window as any;
    state.holdUsage = [];
    for (const release of state.heldUsage.splice(0)) release();
  });
  await expect(codex.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
  await agent.press('Escape');

  // An account that needs signing in shows that alone.
  await page.evaluate((id) => localStorage.setItem(`test-auth-connection-${id}`, 'login'), codexId);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.locator('.fleet-account').filter({ hasText: 'Codex' }).first()).toContainText(
    'Sign-in needed',
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await agent.click();
  const lapsed = page.getByRole('option', { name: 'Codex, Sign-in needed', exact: true });
  await expect(lapsed).toBeVisible();
  await expect(lapsed.locator('.quota-bars')).toHaveCount(0);
  await expect(lapsed.locator('.option-aside')).toBeHidden();
  await expect(
    page.getByRole('option', { name: 'Claude', exact: true }).locator('.quota-bar'),
  ).toHaveCount(2);
});

test('an account whose check finishes while the picker is open gets its bars', async ({ page }) => {
  await prepare(page);
  await page.addInitScript(() => ((window as any).holdCli = ['detect_connection']));
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  const claude = page.getByRole('option', { name: 'Claude', exact: true });
  await expect(claude.locator('.option-detail')).toHaveText('Checking availability…');
  await expect(claude.locator('.quota-bars')).toHaveCount(0);
  await expect(claude.locator('.option-aside')).toBeHidden();
  await page.evaluate(() => {
    const state = window as any;
    state.holdCli = [];
    for (const request of state.pendingCli.splice(0)) request.resolve();
  });
  await expect(claude.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
});

test('a narrow Agent picker puts each account’s bars below its name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  const claude = page.getByRole('option', { name: 'Claude', exact: true });
  await expect(claude.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
  const name = (await claude.locator('.option-name').boundingBox())!;
  const bars = (await claude.locator('.quota-bars').boundingBox())!;
  const list = (await page.getByRole('listbox').boundingBox())!;
  expect(bars.y).toBeGreaterThanOrEqual(name.y + name.height);
  expect(Math.round(bars.x)).toBe(Math.round(name.x));
  expect(bars.x + bars.width).toBeLessThanOrEqual(list.x + list.width);
  await page.screenshot({ path: 'artifacts/agent-usage-picker-narrow.png' });
});

test('limits an account’s reading leaves out show nowhere', async ({ page }) => {
  await prepare(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  const login = await connectionNamed(page, 'Claude CLI login');
  const codexId = await connectionOf(page, 'codex');
  // A plan without a 5-hour limit, as Claude now has, an account whose weekly limit comes
  // without a share used, and one that reports no limit at all.
  await page.evaluate(
    ({ second, login, codexId }) => {
      const own = (id: string, value: object) =>
        localStorage.setItem(`test-usage-percent-${id}`, JSON.stringify(value));
      own(second, { omit: ['5-hour'], Weekly: 40 });
      own(login, { Weekly: null });
      own(codexId, { omit: ['5-hour', 'Weekly'] });
    },
    { second, login, codexId },
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);

  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  const other = page.getByRole('option', { name: 'Claude · Second Claude', exact: true });
  const cli = page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true });
  const codex = page.getByRole('option', { name: 'Codex', exact: true });
  const gemini = page.getByRole('option', { name: 'Gemini', exact: true });
  await expect(other.locator('.quota-bar')).toHaveText(['Weekly40% used']);
  await expect(cli.locator('.quota-bar')).toHaveText(['5-hour70% used']);
  await expect(gemini.locator('.quota-bar')).toHaveText(['5-hour70% used', 'Weekly25% used']);
  await expect(codex.locator('.quota-bars')).toHaveCount(0);
  await expect(codex.locator('.option-aside')).toBeHidden();
  await expect(page.getByRole('listbox')).not.toContainText('Not reported');
  await expect(other).toHaveAccessibleDescription('Weekly 40% used Below pace');
  // Weekly keeps its column, so the accounts still line up.
  const weeklyX = async (option: typeof other) =>
    Math.round((await option.locator('.quota-bar.weekly').boundingBox())!.x);
  expect(await weeklyX(other)).toBe(await weeklyX(gemini));
  await page.screenshot({ path: 'artifacts/agent-usage-unreported.png' });

  // The composer shows the limits the chosen account has, and the rest fill the row.
  await other.click();
  await expect(agent).toHaveText(/Claude · Second Claude/);
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  const strip = page.locator('.composer-area .usage-strip');
  await expect(strip.getByRole('button')).toHaveCount(2);
  await expect(strip.getByRole('progressbar', { name: '5-hour limit used' })).toHaveCount(0);
  await expect(strip.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute(
    'aria-valuenow',
    '40',
  );
  await expect(strip).not.toContainText('Not reported');
  const widths = await strip
    .getByRole('button')
    .evaluateAll((chips) => chips.map((chip) => Math.round(chip.getBoundingClientRect().width)));
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-5-hour')).toHaveCount(0);
  await expect(page.getByTestId('limit-weekly')).toContainText('40%');
  await page.screenshot({ path: 'artifacts/composer-usage-unreported.png' });
  await page.keyboard.press('Escape');
  // Fable's own weekly limit joins the weekly one.
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Fable', exact: true }).click();
  await expect(strip.locator('.usage-chip .usage-bar-heading > span:first-child')).toHaveText([
    'Context',
    'Weekly',
    'Fable weekly',
  ]);

  // Connections lists the same limits for each account.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const usage = (name: string) =>
    page.getByRole('region', { name: `Usage for ${name}`, exact: true });
  const labels = (name: string) =>
    usage(name).locator('.account-limit .limit-heading > span:first-child');
  await expect(labels('Second Claude')).toHaveText(['Weekly', 'Fable weekly']);
  await expect(labels('Claude CLI login')).toHaveText(['5-hour', 'Fable weekly']);
  await expect(labels('Codex CLI login')).toHaveCount(0);
  await expect(usage('Codex CLI login')).toContainText('No limits reported.');
  await expect(page.locator('.account-limit', { hasText: 'Not reported' })).toHaveCount(0);
});
