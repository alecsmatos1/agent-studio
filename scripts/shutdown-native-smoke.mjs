// Native smoke of Shut down when chats finish (docs/BACKGROUND.md) on Windows, against a debug
// build, which records the shutdown it is asked for in shutdown-dry-run.txt instead of turning the
// computer off (src-tauri/src/shutdown.rs). Never run it against a release build.
//
//   npm run build
//   CARGO_TARGET_DIR=<scratch>/shutdown-qa-target npx tauri build --debug --no-bundle --config scripts/native-shutdown.tauri.json
//   npm run start:windows -- -Executable <long path>/target/debug/agent-studio.exe
//   node scripts/shutdown-native-smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const port = 19893;
const data = join(process.env.LOCALAPPDATA, 'com.vinicius.agentstudio.shutdown-qa');
const dryRun = join(data, 'shutdown-dry-run.txt');

if (process.argv.includes('--prepare')) {
  // Before the first launch: closing quits, and the QA app never updates the CLIs.
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'tray.json'), '{"closeToTray":false}');
  writeFileSync(join(data, 'cli-updates.json'), '{"claude":false,"codex":false}');
  console.log(`Prepared ${data}`);
  process.exit(0);
}

// The system's execution state, which has ES_SYSTEM_REQUIRED (1) while any thread keeps the
// computer awake. Reading it needs no administrator, unlike powercfg /requests.
function executionState() {
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class PowerState { [DllImport("powrprof.dll")] public static extern uint CallNtPowerInformation(int level, IntPtr input, uint inputLength, out uint output, uint outputLength); }\'',
    '$state = 0',
    '[void][PowerState]::CallNtPowerInformation(16, [IntPtr]::Zero, 0, [ref]$state, 4)',
    '$state',
  ].join('; ');
  return Number(
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim(),
  );
}
const awake = () => (executionState() & 1) === 1;
// Another program holding the computer awake hides whether this app does too.
let watchable = true;
async function until(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

rmSync(dryRun, { force: true });
const page = await nativePage(port);
const toggle = 'button[aria-label="Shut down when chats finish"]';
const dialogTitle = () =>
  page.evaluate(() => document.querySelector('dialog[open] h2')?.textContent ?? '');
const inDialog = (name) =>
  page.evaluate((name) => {
    const control = [
      ...(document.querySelector('dialog[open]')?.querySelectorAll('button') ?? []),
    ].find((el) => el.innerText.trim() === name);
    if (!control || control.disabled) throw new Error(`Button unavailable: ${name}`);
    control.click();
  }, name);
try {
  await page.quitOnClose();
  // A stale build-script output in a reused target leaves the page without Tauri's own plugins.
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.shutdown-qa');
  await page.waitFor((toggle) => !!document.querySelector(toggle), toggle);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? ''),
    '',
  );
  watchable = !awake();
  if (!watchable)
    console.log('Another program keeps this computer awake: staying awake goes unchecked.');

  // On with nothing running: the countdown begins at once, and the computer stays awake.
  await page.click(toggle);
  await page.waitFor(() =>
    /^Shutting down in \d:\d\d$/.test(document.querySelector('dialog[open] h2')?.textContent ?? ''),
  );
  assert.deepEqual(await page.invoke('shutdown_watch'), { armed: true, running: [] });
  if (watchable) await until(awake, 'the computer to be held awake');
  // Cancel turns the watch off and lets the computer sleep again.
  await inDialog('Cancel');
  await page.waitFor(() => !document.querySelector('dialog[open]'));
  assert.equal((await page.invoke('shutdown_watch')).armed, false);
  if (watchable) await until(() => !awake(), 'the computer to be let sleep');

  // A watch left on goes on after the window reloads.
  await page.click(toggle);
  await page.waitFor(() => !!document.querySelector('dialog[open]'));
  await page.cdp('Page.reload');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.waitFor(
    (toggle) => document.querySelector(toggle)?.getAttribute('aria-pressed') === 'true',
    toggle,
  );
  await page.waitFor(() => !!document.querySelector('dialog[open]'));
  if (watchable) assert(awake(), 'The reload let the computer sleep.');

  // Shut down now: this debug build records the request instead.
  await inDialog('Shut down now');
  await until(async () => (await dialogTitle()) === 'Shutting down…', 'Shutting down…');
  await until(() => existsSync(dryRun), 'the dry run');
  assert.equal((await page.invoke('shutdown_watch')).armed, false);
  if (watchable) await until(() => !awake(), 'the computer to be let sleep after the shutdown');
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('artifacts/shutdown-native.png', Buffer.from(shot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  console.log('Shutdown native smoke passed.');
} finally {
  await page.button('Close window').catch(() => {});
  page.close();
}
process.exit(0);
