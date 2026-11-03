import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { chooseTestFolder } from './folder-helper';
import { expectVisibleQuotaComparison } from './quota-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server';
import { modelViewsRenderer } from '../src/lib/tool-output';
import { createHash } from 'node:crypto';
import { triangleGlbBase64 } from './model-fixture';
import { mockAppCalls } from './desktop-helper';

test('shared account context is explicit, scoped, cancellable and saved across reloads', async ({
  page,
}) => {
  await host(page, '', '', 'Desktop', 'windows');
  const computer = page.getByRole('article', { name: 'Desktop computer', exact: true });
  const claude = computer.getByRole('article', { name: 'Claude connections', exact: true });
  for (const name of ['Shared source', 'Second account']) {
    await computer.getByRole('button', { name: 'Add account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add account' });
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  const account = claude.locator('.fleet-account').filter({ hasText: 'Second account' });
  await account.getByRole('button', { name: 'Manage account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage account' });
  await dialog.getByRole('combobox', { name: 'Shared context source' }).click();
  await page.getByRole('option', { name: 'Shared source', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await account.getByRole('button', { name: 'Manage account' }).click();
  // Separate profiles use this computer's CLI context until another choice is saved.
  await expect(dialog.getByRole('combobox', { name: 'Shared context source' })).toHaveText(
    'This computer’s CLI context',
  );
  await dialog.getByRole('combobox', { name: 'Shared context source' }).click();
  await page.getByRole('option', { name: 'Shared source', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('fixture-workspace')!).fleet,
  );
  const source = saved.connections.find(
    (c: any) => c.accountId === saved.accounts.find((a: any) => a.name === 'Shared source').id,
  );
  const target = saved.connections.find(
    (c: any) => c.accountId === saved.accounts.find((a: any) => a.name === 'Second account').id,
  );
  expect(target.sharedContextConnectionId).toBe(source.id);
  expect(target.sharedContext).toBeUndefined();
  expect(source.sharedContextConnectionId).toBeUndefined();
  expect(source.sharedContext).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await account.getByRole('button', { name: 'Manage account' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Shared context source' })).toHaveText(
    'Shared source',
  );
  await page.setViewportSize({ width: 840, height: 640 });
  await dialog.screenshot({ path: 'artifacts/shared-context-account.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: 'artifacts/shared-context-account-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('combobox', { name: 'Shared context source' }).click();
  await page.getByRole('option', { name: 'This account only', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  const cleared = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem('fixture-workspace')!).fleet.connections.find(
        (c: any) => c.id === id,
      ),
    target.id,
  );
  expect(cleared.sharedContextConnectionId).toBeUndefined();
  expect(cleared.sharedContext).toBe('none');
  await account.getByRole('button', { name: 'Manage account' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Shared context source' })).toHaveText(
    'This account only',
  );
  await dialog.getByRole('combobox', { name: 'Shared context source' }).click();
  await page.getByRole('option', { name: 'This computer’s CLI context', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  const restored = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem('fixture-workspace')!).fleet.connections.find(
        (c: any) => c.id === id,
      ),
    target.id,
  );
  expect(restored.sharedContextConnectionId).toBeUndefined();
  expect(restored.sharedContext).toBeUndefined();
  await expect(page.locator('select')).toHaveCount(0);
});

async function host(
  page: Page,
  relay: string,
  token: string,
  name: string,
  platform: string,
  server = false,
) {
  const identity = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name,
    platform,
    ...(server ? { server: true } : {}),
  };
  await page.exposeFunction('relayBridge', async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${relay}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': identity.id,
        'content-type': 'application/json',
        // The native relay client says it keeps images as references to the image store.
        'x-studio-images': '1',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  });
  // The native client uploads what the relay lacks from this computer's image store.
  await page.exposeFunction('uploadImages', async (images: [string, string][]) => {
    const headers = {
      authorization: `Bearer ${token}`,
      'x-environment-id': identity.id,
      'x-studio-images': '1',
    };
    const answer = await fetch(`${relay}/v1/images/missing`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: images.map(([hash]) => hash) }),
    });
    const { missing } = (await answer.json()) as { missing: string[] };
    for (const [hash, data] of images)
      if (missing.includes(hash))
        await fetch(`${relay}/v1/images/${hash}`, {
          method: 'PUT',
          headers,
          body: new Uint8Array(Buffer.from(data, 'base64')),
        });
    return [];
  });
  await mockAppCalls(page);
  await page.addInitScript(
    ({ identity }) => {
      const w = window as any;
      w.isTauri = true;
      let next = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      let finish: (() => void) | undefined;
      // This computer's image store, by hash.
      const storedImages = (): Record<string, { mediaType: string; data: string }> =>
        JSON.parse(localStorage.getItem('fixture-images') ?? '{}');
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.emitTauriEvent = (event: string, payload: unknown) => {
        for (const listener of w.eventListeners ?? [])
          if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: 0, payload });
      };
      w.__TAURI_INTERNALS__ = {
        convertFileSrc: (path: string) => {
          const image = storedImages()[path];
          return image ? `data:${image.mediaType};base64,${image.data}` : 'data:,';
        },
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(fn: (value: unknown) => void) {
          const id = ++next;
          callbacks.set(id, fn);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: any) {
          args = w.studioCallArguments(command, args);
          if (command === 'desktop_notification_settings') return { enabled: true, sound: true };
          if (command === 'desktop_notification' || command === 'set_pending_chat_badge') return;
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:event|listen') {
            (w.eventListeners ??= []).push({ event: args.event, handler: args.handler });
            return w.eventListeners.length;
          }
          if (command === 'plugin:event|unlisten') return;
          if (command === 'live_account_updates') return [];
          if (command === 'manage_account') {
            if (args.input.action !== 'workspaceMessages')
              throw new Error('This fixture cannot redeem credits.');
            if (w.holdAccountNoticeReads)
              await new Promise<void>((resolve) => (w.pendingNoticeReads ??= []).push(resolve));
            return {
              featureEnabled: true,
              messages: [{ messageId: 'fixture', messageBody: 'Synthetic workspace notice' }],
            };
          }
          if (command === 'get_installation') return identity;
          if (command === 'read_native_instructions') {
            localStorage.setItem('fixture-native-instructions', JSON.stringify(args));
            return {
              provider: args.provider,
              checkedAt: Date.now(),
              notice: 'Recorded on the owning host.',
              studioGuidance: '',
              blocks: [
                {
                  label: 'System prompt',
                  text: `Native instruction from ${identity.name}`,
                  capturedAt: '2026-09-13T10:00:00Z',
                  version: 'fixture',
                  model: null,
                },
              ],
            };
          }
          if (command === 'read_context') {
            localStorage.setItem('fixture-context', JSON.stringify(args));
            return {
              provider: args.provider,
              model: args.model,
              checkedAt: Date.now(),
              execution: identity.name,
              folder: args.location.path,
              profile: '/profiles/selected',
              entries: [],
              notes: ['Inspected on the owning host.'],
              truncated: false,
            };
          }
          if (command === 'list_folders') {
            localStorage.setItem('fixture-folders', JSON.stringify(args));
            return {
              path:
                args.path ||
                (identity.platform === 'windows' && args.environmentId === identity.id
                  ? 'C:\\Projects\\studio'
                  : '/home/test/studio'),
              parent: null,
              entries: [],
              truncated: false,
            };
          }
          if (command === 'discover_wsl') {
            if (localStorage.getItem('fixture-wsl-error'))
              throw new Error('Synthetic WSL discovery failure');
            return JSON.parse(
              localStorage.getItem('fixture-wsl') ?? '{"distributions":[],"warning":null}',
            );
          }
          if (command === 'load_workspace')
            return JSON.parse(localStorage.getItem('fixture-workspace') ?? 'null');
          if (command === 'save_workspace' || command === 'save_workspace_patch') {
            if (w.holdAccountSave)
              await new Promise<void>((resolve) => (w.releaseAccountSave = resolve));
            if (w.failAccountSave) throw new Error('Synthetic account save failure');
            if (command === 'save_workspace') {
              localStorage.setItem('fixture-workspace', JSON.stringify(args.workspace));
              return;
            }
            // The host completes a patch from its last write and asks for the whole workspace
            // when it cannot, as src-tauri's save_workspace_patch does.
            const saved = JSON.parse(localStorage.getItem('fixture-workspace') ?? 'null');
            const kept = new Map<string, unknown>(
              (saved?.conversations ?? []).map((c: { id: string }) => [c.id, c]),
            );
            const sent = new Map<string, unknown>(
              args.upsert.map((c: { id: string }) => [c.id, c]),
            );
            const conversations = (args.order as string[]).map((id) => {
              const conversation = sent.get(id) ?? kept.get(id);
              if (!conversation)
                throw new Error('The whole workspace is needed to save this change.');
              sent.delete(id);
              return conversation;
            });
            if (sent.size) throw new Error('The whole workspace is needed to save this change.');
            localStorage.setItem(
              'fixture-workspace',
              JSON.stringify({ ...args.index, conversations }),
            );
            return;
          }
          if (command === 'load_sync_state')
            return JSON.parse(localStorage.getItem('fixture-sync') ?? 'null');
          if (command === 'save_sync_state') {
            const before = JSON.parse(localStorage.getItem('fixture-sync') ?? 'null');
            localStorage.setItem('fixture-sync', JSON.stringify(w.studioCheckpoint(before, args)));
            return;
          }
          if (command === 'relay_resume') return localStorage.getItem('fixture-relay-origin');
          if (command === 'relay_connect') {
            localStorage.setItem('fixture-relay-origin', args.url);
            return;
          }
          if (command === 'relay_disconnect') {
            localStorage.removeItem('fixture-relay-origin');
            return;
          }
          if (command === 'relay_request') {
            // A relay that cannot carry a whole model's result, as relays before 2026-10-10
            // refused a result past 24 MB.
            if (
              localStorage.getItem('fixture-relay-refuses-models') &&
              args.method === 'PUT' &&
              typeof args.body?.result?.data === 'string' &&
              args.body.result.format
            )
              return {
                status: 413,
                body: { code: 'too_large', error: 'Request exceeds its size limit.' },
              };
            return w.relayBridge(args.method, args.path, args.body);
          }
          const status = (id: string) => ({
            id,
            installed: true,
            auth: 'ready',
            version: 'Synthetic CLI',
            detail: 'Verified fixture',
          });
          if (command === 'inspect_environment_clis') {
            if (localStorage.getItem('fixture-inventory-error'))
              throw new Error('Synthetic installation check failure');
            const linux = args.environmentId !== identity.id;
            return ['codex', 'claude', 'gemini'].map((id) => ({
              id,
              path: linux
                ? JSON.parse(
                    localStorage.getItem('fixture-linux-clis') ?? '["codex","claude"]',
                  ).includes(id)
                  ? '/usr/local/bin/' + id
                  : null
                : 'C:\\CLIs\\' + id + '.exe',
            }));
          }
          if (command === 'detect_providers') return ['codex', 'claude', 'gemini'].map(status);
          if (command === 'detect_connection') {
            const result = status(args.provider);
            if (localStorage.getItem('fixture-pending-auth') === args.connectionId)
              result.auth = 'login';
            // A new separate profile has no login until it signs in, as its CLI reports.
            if (w.separateProfilesSignIn && !(w.signedIn ?? []).includes(args.connectionId)) {
              const saved = JSON.parse(localStorage.getItem('fixture-workspace') ?? '{}');
              const connection = saved.fleet?.connections?.find(
                (c: any) => c.id === args.connectionId,
              );
              if (connection?.profile === 'isolated') result.auth = 'login';
            }
            return result;
          }
          if (command === 'list_models')
            return Object.fromEntries(
              ['codex', 'claude', 'gemini'].map((id) => [
                id,
                [{ id: '', name: 'CLI default', reasoningLevels: [], defaultReasoning: '' }],
              ]),
            );
          if (command === 'read_usage') {
            localStorage.setItem('fixture-usage', JSON.stringify(args));
            (w.usageCalls ??= []).push(args);
            if (w.holdUsageConnections?.includes(args.connectionId))
              await new Promise<void>((resolve) =>
                (w.pendingUsage ??= []).push({ ...args, resolve }),
              );
            if (w.failUsageConnections?.includes(args.connectionId))
              throw new Error('Usage check failed for this account.');
            if (w.usageReadings?.[args.connectionId])
              return { ...w.usageReadings[args.connectionId], provider: args.provider };
            return {
              provider: args.provider,
              checkedAt: Date.now() / 1000,
              windows: [],
              context: null,
              detail: 'Fixture',
            };
          }
          if (command === 'store_chat_image') {
            const bytes = new Uint8Array(args as ArrayBuffer);
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const images = storedImages();
            images[hash] = { mediaType: 'image/png', data: btoa(binary) };
            localStorage.setItem('fixture-images', JSON.stringify(images));
            return { hash, bytes: bytes.length, mediaType: 'image/png' };
          }
          if (command === 'upload_chat_images') {
            const images = storedImages();
            return w.uploadImages(
              (args.hashes as string[]).flatMap((hash) =>
                images[hash] ? [[hash, images[hash].data]] : [],
              ),
            );
          }
          // A model this computer keeps: read whole for another device, raw for this window,
          // and drawn as views for a device the whole model cannot reach.
          if (command === 'read_tool_output_model') {
            w.modelReads = (w.modelReads ?? 0) + 1;
            const data = localStorage.getItem('fixture-model');
            if (!data) throw 'This output was not kept on the computer that ran it.';
            return { format: 'glb', data, bytes: atob(data).length };
          }
          if (command === 'read_tool_output_model_file') {
            w.modelFileReads = (w.modelFileReads ?? 0) + 1;
            const data = localStorage.getItem('fixture-model');
            if (!data) throw 'This output was not kept on the computer that ran it.';
            return Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer;
          }
          if (command === 'read_tool_output_model_views') {
            const kept = JSON.parse(localStorage.getItem('fixture-model-views') ?? 'null');
            return { format: 'glb', bytes: 40 * 1024 * 1024, ...kept, views: kept?.views ?? [] };
          }
          if (command === 'store_tool_output_model_views') {
            const views = (args.views as string[]).map((data) => ({
              mediaType: 'image/webp',
              data,
              bytes: Math.floor((data.length * 3) / 4),
            }));
            localStorage.setItem(
              'fixture-model-views',
              JSON.stringify({ renderer: args.renderer, views }),
            );
            return;
          }
          if (command === 'generate_title') throw new Error('Synthetic title unavailable');
          if (command === 'cancel_title') return;
          if (command === 'sign_in' && args.remote) {
            (w.signInCalls ??= []).push(args);
            localStorage.setItem('fixture-pending-auth', args.connectionId);
            w.remoteSignIn = {
              id: crypto.randomUUID(),
              provider: args.provider,
              connectionId: args.connectionId,
              phase: 'waiting',
              url: 'https://auth.openai.com/codex/device',
              code: false,
              codeExpected: false,
              userCode: 'ABCD-12345',
              message: 'Open the sign-in page and enter this code.',
            };
            w.emitTauriEvent('studio-sign-in', w.remoteSignIn);
            return w.remoteSignIn;
          }
          if (command === 'sign_ins') return w.remoteSignIn ? [w.remoteSignIn] : [];
          if (command === 'sign_in') {
            (w.signInCalls ??= []).push(args);
            if (w.holdSignIn) await new Promise<void>((resolve) => (w.releaseSignIn = resolve));
            if (w.failSignIn) throw new Error('Synthetic terminal failed to start');
            if (w.requireNewLogin) localStorage.setItem('fixture-pending-auth', args.connectionId);
            localStorage.setItem('fixture-login', JSON.stringify(args));
            return;
          }
          if (command === 'cancel_run') {
            finish?.();
            return;
          }
          if (command === 'run_agent') {
            localStorage.setItem('fixture-run', JSON.stringify(args.request));
            localStorage.setItem('fixture-run-connection', args.connectionId ?? '');
            let index = 0;
            const emit = (message: unknown) =>
              callbacks.get(args.onEvent.id)?.({ message, index: index++ });
            emit({ kind: 'activity', text: `Running on ${identity.name}` });
            emit({
              kind: 'progress',
              id: 'inspection',
              revision: 1,
              text: 'Checking the remote sources.',
            });
            emit({ kind: 'text', text: `Response from ${identity.name}` });
            for (const id of ['search-one', 'search-two'])
              emit({
                kind: 'tool',
                tool: {
                  id,
                  revision: 1,
                  category: 'search',
                  name: 'Web search',
                  query: `Query ${id}`,
                  status: 'running',
                  sources: [],
                  agents: [],
                },
              });
            if (localStorage.getItem('fixture-slow')) {
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              return 'cancelled';
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            emit({
              kind: 'progress',
              id: 'inspection',
              revision: 2,
              text: 'Checked both remote sources.',
            });
            for (const id of ['search-one', 'search-two'])
              emit({
                kind: 'tool',
                tool: {
                  id,
                  revision: 2,
                  category: 'search',
                  name: 'Web search',
                  query: `Query ${id}`,
                  status: 'complete',
                  sources: [{ title: 'Fixture source', url: 'https://example.com' }],
                  agents: [],
                },
              });
            emit({ kind: 'text', text: `Response from ${identity.name}, completed.` });
            // A model kept at full detail, 40 MB by its record, or two compared side by side.
            if (localStorage.getItem('fixture-model'))
              emit({
                kind: 'sentfiles',
                sentFiles: {
                  id: 'figure',
                  revision: 1,
                  runId: args.request.runId,
                  toolId: 'toolu_figure',
                  ...(localStorage.getItem('fixture-model-compare')
                    ? {
                        compare: true,
                        files: ['before', 'after'].map((name, index) => ({
                          index,
                          name: `${name}.glb`,
                          mediaType: 'model/gltf-binary',
                          bytes: 40 * 1024 * 1024,
                        })),
                      }
                    : {
                        files: [
                          {
                            index: 0,
                            name: 'figure.glb',
                            mediaType: 'model/gltf-binary',
                            bytes: 40 * 1024 * 1024,
                          },
                        ],
                      }),
                },
              });
            emit({ kind: 'usage', input: 2400, output: 50, costUsd: 0.012345 });
            return 'complete';
          }
          throw new Error(`Unexpected fixture command ${command}`);
        },
      };
    },
    { identity },
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(
    page
      .locator('.fleet-account')
      .getByRole('heading', { name: 'Claude CLI login', exact: true })
      .first(),
  ).toBeVisible();
  return identity;
}
test('Connections shows separate account quotas, refresh progress, and retained readings on failure', async ({
  page,
}) => {
  await page.clock.install();
  await host(page, '', '', 'Desktop', 'windows');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await page.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ids = await page.evaluate(() => {
    const w = window as any;
    const fleet = JSON.parse(localStorage.getItem('fixture-workspace')!).fleet;
    const ids: Record<string, string> = {};
    w.usageReadings = {};
    for (const connection of fleet.connections) {
      const account = fleet.accounts.find((a: any) => a.id === connection.accountId);
      ids[account.name] = connection.id;
      const values =
        account.name === 'Second Claude'
          ? [80, 0]
          : account.provider === 'claude'
            ? [25, 60]
            : account.provider === 'codex'
              ? [0, null]
              : [null, null];
      const now = Date.now() / 1000;
      w.usageReadings[connection.id] = {
        checkedAt: now,
        context: null,
        detail: 'Fixture account limits',
        windows: [300, 10080].map((minutes, i) => ({
          id: i === 0 ? 'five-hour' : 'weekly',
          label: i === 0 ? '5-hour' : 'Weekly',
          usedPercent: values[i],
          resetsAt: now + minutes * 30,
          windowMinutes: minutes,
          model: null,
          bucket: account.provider,
        })),
      };
    }
    return ids;
  });
  const usage = (name: string) =>
    page.getByRole('region', { name: `Usage for ${name}`, exact: true });
  const meter = (name: string, window = '5-hour') =>
    usage(name).getByRole('progressbar', { name: `${window} limit used`, exact: true });
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(meter('Claude CLI login')).toHaveAttribute('aria-valuenow', '25');
  await expect(meter('Second Claude')).toHaveAttribute('aria-valuenow', '80');
  await expect(meter('Codex CLI login')).toHaveAttribute('aria-valuenow', '0');
  // A limit reported without a share used is not shown, nor any for an account without one.
  await expect(meter('Codex CLI login', 'Weekly')).toHaveCount(0);
  await expect(usage('Second Claude')).toContainText('Budget');
  const resetDate = await page.evaluate((id) => {
    const reset = (window as any).usageReadings[id].windows[1].resetsAt;
    const date = new Date(reset * 1000);
    const weekday = date.toLocaleDateString([], { weekday: 'long' });
    const clock = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    return `${weekday}, ${clock}`;
  }, ids['Second Claude']);
  await expect(usage('Second Claude')).toContainText(`Resets ${resetDate}`);
  await expect(usage('Second Claude').locator('.limit-advice')).toHaveCount(0);
  await expect(usage('Second Claude').locator('[title*="less until reset"]')).toHaveCount(0);
  await expect(usage('Second Claude').getByRole('img', { name: 'Ahead of pace' })).toBeVisible();
  await expect(usage('Claude CLI login').getByRole('img', { name: 'Below pace' })).toBeVisible();
  await expect(usage('Gemini CLI login')).toContainText('No limits reported.');
  await expect(usage('Gemini CLI login').getByRole('progressbar')).toHaveCount(0);
  await expect(usage('Gemini CLI login')).not.toContainText('0%');
  await expect(usage('Claude CLI login')).not.toContainText('Context');
  await expectVisibleQuotaComparison(meter('Second Claude'), true);
  await expectVisibleQuotaComparison(meter('Claude CLI login'), false);
  const computer = page.getByRole('article', { name: 'Desktop computer', exact: true });
  const boxes = await computer.locator('.provider-group').evaluateAll((cards) =>
    cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, x: r.x, width: r.width };
    }),
  );
  expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom);
  expect(boxes[1].x).toBe(boxes[0].x);
  await page.setViewportSize({ width: 1380, height: 1600 });
  await computer.screenshot({ path: 'artifacts/account-usage-desktop.png' });
  await page.evaluate((ids) => {
    const w = window as any;
    w.holdUsageConnections = [ids['Second Claude']];
    w.usageReadings[ids['Claude CLI login']].windows[0].usedPercent = 35;
    w.usageReadings[ids['Codex CLI login']].windows[0].usedPercent = null;
  }, ids);
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(usage('Second Claude')).toContainText('Updating…');
  await expect(meter('Second Claude')).toHaveAttribute('aria-valuenow', '80');
  await expect(meter('Claude CLI login')).toHaveAttribute('aria-valuenow', '35');
  await expect(meter('Codex CLI login')).toHaveCount(0);
  await expect(meter('Codex CLI login', 'Weekly')).toHaveCount(0);
  await expect(usage('Codex CLI login')).toContainText('No limits reported.');
  await page.evaluate((id) => {
    const w = window as any;
    w.failUsageConnections = [id];
    w.holdUsageConnections = [];
    for (const pending of w.pendingUsage) pending.resolve();
  }, ids['Second Claude']);
  await expect(usage('Second Claude')).toContainText('Last reported');
  await expect(usage('Second Claude')).toContainText('Usage check failed for this account.');
  await expect(usage('Second Claude').locator('.recommended-fill')).toHaveCount(0);
  await expect(usage('Second Claude')).not.toContainText('Budget');
  await expect(meter('Second Claude')).toHaveAttribute('aria-valuenow', '80');
  await expect(usage('Claude CLI login')).not.toContainText('Last reported');
  await page.setViewportSize({ width: 840, height: 1800 });
  await computer.screenshot({ path: 'artifacts/account-usage-narrow.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(
    (id) => localStorage.setItem('fixture-pending-auth', id),
    ids['Second Claude'],
  );
  const before = await page.evaluate(() => (window as any).usageCalls.length);
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(usage('Second Claude')).toContainText('Sign in to read usage.');
  await page.clock.fastForward(61_000);
  await expect
    .poll(() => page.evaluate(() => (window as any).usageCalls.length))
    .toBeGreaterThan(before + 3);
  const calls = await page.evaluate((before) => (window as any).usageCalls.slice(before), before);
  expect(calls.some((call: any) => call.connectionId === ids['Second Claude'])).toBe(false);
  expect(calls.every((call: any) => Object.values(ids).includes(call.connectionId))).toBe(true);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations),
  ).toHaveLength(0);
});

test('computers discover existing logins and keep additional accounts in contextual dialogs', async ({
  page,
}) => {
  const distroId = crypto.randomUUID();
  await page.addInitScript(
    ({ distroId }) =>
      localStorage.setItem(
        'fixture-wsl',
        JSON.stringify({
          distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
          warning: null,
        }),
      ),
    { distroId },
  );
  await host(page, '', '', 'Desktop', 'windows');
  const local = page.getByRole('article', { name: 'Desktop computer', exact: true });
  const ubuntu = page.getByRole('article', { name: 'WSL · Ubuntu computer', exact: true });
  const claude = local.getByRole('article', { name: 'Claude connections', exact: true });
  await expect(local.locator('.fleet-account')).toHaveCount(3);
  await expect(ubuntu.locator('.fleet-account')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Name this account' })).toHaveCount(0);
  const primary = claude.locator('.fleet-account').first();
  await primary.getByRole('button', { name: 'Manage account' }).click();
  await page.getByRole('textbox', { name: 'Edit account name', exact: true }).fill('Personal 1');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  for (const name of ['Personal 2', 'Company']) {
    await local.getByRole('button', { name: 'Add account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
    await expect(dialog.getByRole('combobox')).toHaveCount(1);
    await expect(dialog.getByRole('combobox', { name: 'Account provider' })).toHaveText('Claude');
    await expect(dialog).not.toContainText('already connected');
    await expect(dialog.getByRole('combobox', { name: 'Account to connect' })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: 'Login profile' })).toHaveCount(0);
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(claude.locator('.fleet-account')).toHaveCount(3);
  // Accounts added on Desktop join Ubuntu by themselves, each to sign in there once.
  await expect(ubuntu.locator('.fleet-account')).toHaveCount(4);
  await expect(ubuntu).toContainText('Personal 2');
  await expect(ubuntu).toContainText('Company');
  await primary.getByRole('button', { name: 'Manage account' }).click();
  const management = page.getByRole('dialog', { name: 'Manage account' });
  await expect(primary.locator('input')).toHaveCount(0);
  await management.getByRole('textbox', { name: 'Edit account name' }).fill('Discarded');
  await management.getByRole('button', { name: 'Disconnect account' }).click();
  await management.getByRole('button', { name: 'Keep connection' }).click();
  await management.press('Escape');
  await expect(primary.getByRole('button', { name: 'Manage account' })).toBeFocused();
  await expect(primary).toContainText('Personal 1');
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(claude.locator('.fleet-account')).toHaveCount(3);
  await page.setViewportSize({ width: 840, height: 640 });
  await claude.screenshot({ path: 'artifacts/connections-accounts-narrow.png' });
  await local.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByRole('dialog').screenshot({ path: 'artifacts/add-account-simple-browser.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('select')).toHaveCount(0);
});

test('computer cards keep local and remote accounts separate and explain both login methods', async ({
  page,
}) => {
  const identity = await host(page, '', '', 'Desktop', 'windows');
  await page.evaluate(
    ({ identity }) => {
      const workspace = JSON.parse(localStorage.getItem('fixture-workspace')!);
      const computer = crypto.randomUUID(),
        environment = crypto.randomUUID();
      const shared = crypto.randomUUID(),
        remote = crypto.randomUUID(),
        unused = crypto.randomUUID();
      workspace.fleet.computers.push({ id: computer, name: 'MacBook' });
      workspace.fleet.environments.push({
        id: environment,
        computerId: computer,
        name: 'macOS',
        platform: 'macos',
      });
      const originalClaude = workspace.fleet.accounts
        .filter((a: any) => a.provider === 'claude')
        .map((a: any) => a.id);
      workspace.fleet.connections = workspace.fleet.connections.filter(
        (c: any) => !originalClaude.includes(c.accountId),
      );
      workspace.fleet.accounts = workspace.fleet.accounts.filter(
        (a: any) => !originalClaude.includes(a.id),
      );
      workspace.fleet.accounts.push(
        { id: shared, name: 'Personal', purpose: 'personal', provider: 'claude' },
        { id: remote, name: 'Company', purpose: 'work', provider: 'claude' },
        { id: unused, name: 'Unused', purpose: 'personal', provider: 'codex' },
      );
      workspace.fleet.connections.push(
        {
          id: crypto.randomUUID(),
          accountId: shared,
          environmentId: identity.id,
          profile: 'existing',
        },
        {
          id: crypto.randomUUID(),
          accountId: shared,
          environmentId: environment,
          profile: 'existing',
        },
        {
          id: crypto.randomUUID(),
          accountId: remote,
          environmentId: environment,
          profile: 'isolated',
        },
      );
      localStorage.setItem('fixture-workspace', JSON.stringify(workspace));
    },
    { identity },
  );
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const local = page.getByRole('article', { name: 'Desktop computer', exact: true });
  const remote = page.getByRole('article', { name: 'MacBook computer', exact: true });
  await expect(page.locator('.fleet-computer')).toHaveCount(2);
  await expect(local.locator('.provider-group')).toHaveCount(3);
  await expect(local.getByRole('heading', { name: 'Personal', exact: true })).toHaveCount(1);
  await expect(local.getByRole('heading', { name: 'Company', exact: true })).toHaveCount(0);
  await expect(remote.getByRole('heading', { name: 'Personal', exact: true })).toHaveCount(1);
  await expect(remote.getByRole('heading', { name: 'Company', exact: true })).toHaveCount(1);
  await expect(remote.locator('.computer-state')).toHaveText('Offline');
  await expect(remote.getByRole('button', { name: 'Open sign-in', exact: true })).toHaveCount(0);
  await expect(remote.getByRole('button', { name: 'Add account', exact: true })).toHaveCount(0);
  await expect(local.locator('.account-connection').first()).not.toContainText('Windows');
  await expect(local.locator('.fleet-account').first()).not.toContainText('Connected');
  await expect(local.locator('.fleet-account-heading small')).toHaveCount(0);
  await expect(remote.locator('.account-connection').first()).not.toContainText('macOS');
  await expect(
    local
      .locator('.fleet-account')
      .first()
      .getByRole('button', { name: 'Open sign-in', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'artifacts/connections-computer-list-browser.png',
    fullPage: true,
  });

  await remote
    .locator('.fleet-account')
    .filter({ hasText: 'Personal' })
    .getByRole('button', { name: 'Manage account', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Edit account name', exact: true })).toHaveCount(
    1,
  );
  await page
    .getByRole('textbox', { name: 'Edit account name', exact: true })
    .fill('Shared personal');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(local.getByRole('heading', { name: 'Shared personal', exact: true })).toBeVisible();
  await expect(remote.getByRole('heading', { name: 'Shared personal', exact: true })).toBeVisible();
  await remote
    .locator('.fleet-account')
    .filter({ hasText: 'Company' })
    .getByRole('button', { name: 'Manage account', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Connect on Desktop', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Add an account on Desktop');
  await expect(page.getByRole('textbox', { name: 'Account name', exact: true })).toHaveValue(
    'Company',
  );
  await expect(page.getByRole('combobox', { name: 'Account to connect' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Login profile' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('Accounts without a computer', { exact: false }).click();
  const unused = page.locator('.unassigned-accounts .fleet-account');
  await expect(unused).toContainText('Unused');
  await expect(unused).toContainText('Codex');
  await unused.getByRole('button', { name: 'Manage account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove account label' }).click();
  await expect(page.locator('.unassigned-accounts')).toHaveCount(0);
  await expect(local.locator('.fleet-account')).toHaveCount(3);
  await expect(remote.locator('.fleet-account')).toHaveCount(2);
});

for (const provider of ['claude', 'codex'] as const) {
  test(`adding ${provider} saves a separate profile and opens its sign-in automatically`, async ({
    page,
  }) => {
    const label = provider === 'claude' ? 'Claude' : 'Codex';
    await host(page, '', '', 'Desktop', 'windows');
    const before = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-workspace')!),
    );
    const computer = page.getByRole('article', { name: 'Desktop computer', exact: true });
    await computer.getByRole('button', { name: 'Add account', exact: true }).click();
    await page.getByRole('combobox', { name: 'Account provider' }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.getByRole('textbox', { name: 'Account name', exact: true }).fill(label + ' Second');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add account', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!));
    const added = after.fleet.accounts.find((a: any) => a.name === label + ' Second');
    const connection = after.fleet.connections.find((c: any) => c.accountId === added.id);
    expect(connection.profile).toBe('isolated');
    expect(after.fleet.connections.filter((c: any) => c.id !== connection.id)).toEqual(
      before.fleet.connections,
    );
    expect(after.fleet.accounts.filter((a: any) => a.id !== added.id)).toEqual(
      before.fleet.accounts,
    );
    expect(await page.evaluate(() => (window as any).signInCalls)).toEqual([
      { provider, connectionId: connection.id },
    ]);
    await page.reload();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(
      computer
        .getByRole('article', { name: label + ' connections', exact: true })
        .locator('.fleet-account'),
    ).toHaveCount(2);
  });
}

test('account creation shows progress, retries the same connection, and tracks its own authentication', async ({
  page,
}) => {
  await host(page, '', '', 'Desktop', 'windows');
  const computer = page.getByRole('article', { name: 'Desktop computer', exact: true });
  await computer.getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await page.evaluate(() => {
    const w = window as any;
    w.holdAccountSave = true;
    w.holdSignIn = true;
    w.failSignIn = true;
    w.requireNewLogin = true;
  });
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Creating account…');
  await expect(dialog.locator('form')).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('textbox', { name: 'Account name', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w.holdAccountSave = false;
    w.releaseAccountSave();
  });
  await expect(dialog.getByRole('status')).toHaveText('Opening sign-in…');
  await dialog.screenshot({ path: 'artifacts/add-account-progress-browser.png' });
  await expect.poll(() => page.evaluate(() => (window as any).signInCalls?.length)).toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.holdSignIn = false;
    w.releaseSignIn();
  });
  await expect(dialog.getByRole('alert')).toContainText('terminal failed to start');
  await expect(dialog.getByRole('button', { name: 'Retry sign-in' })).toBeEnabled();
  const afterFailure = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('fixture-workspace')!),
  );
  await page.evaluate(() => {
    (window as any).failSignIn = false;
  });
  await dialog.getByRole('button', { name: 'Retry sign-in' }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!).fleet),
  ).toEqual(afterFailure.fleet);
  const calls = await page.evaluate(() => (window as any).signInCalls);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  // The notice that asked to finish signing in stays until this account, not another profile,
  // reads connected, and no notice replaces it.
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  const notice = page.locator('.notice[role="status"]');
  const account = computer.locator('.fleet-account').filter({ hasText: 'Second Claude' });
  await expect(account).toContainText('Sign-in needed');
  await expect(notice).toHaveText('Finish signing in through Claude.');
  await page.evaluate(() => {
    localStorage.removeItem('fixture-pending-auth');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(account).not.toContainText('Sign-in needed');
  await expect(notice).toHaveCount(0);
});

test('the additional-account modal offers supported providers without login choices', async ({
  page,
}) => {
  await host(page, '', '', 'Desktop', 'windows');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await expect(dialog.getByRole('combobox')).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Gemini', exact: true })).toHaveCount(0);
});

test('missing WSL CLIs require installation before connecting accounts', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fixture-linux-clis', '[]');
    localStorage.setItem(
      'fixture-wsl',
      JSON.stringify({
        distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: true }],
        warning: null,
      }),
    );
  });
  await host(page, '', '', 'Desktop', 'windows');
  const ubuntu = page.getByRole('article', { name: 'WSL · Ubuntu computer', exact: true });
  await expect(ubuntu.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    'Not installed',
  );
  await expect(ubuntu.getByRole('button', { name: 'Add account', exact: true })).toBeDisabled();
  await expect(
    ubuntu.locator('.provider-group').getByRole('button', { name: 'Add account', exact: true }),
  ).toHaveCount(0);
  const desktop = page.getByRole('article', { name: 'Desktop computer', exact: true });
  await expect(desktop.getByRole('button', { name: 'Add account', exact: true })).toBeEnabled();
});

test('Windows discovers WSL automatically and management forms use accessible design-system pickers', async ({
  page,
}) => {
  const ubuntu = crypto.randomUUID(),
    debian = crypto.randomUUID();
  await page.addInitScript(
    ({ ubuntu, debian }) => {
      localStorage.setItem('fixture-linux-clis', '["codex"]');
      if (!localStorage.getItem('fixture-wsl'))
        localStorage.setItem(
          'fixture-wsl',
          JSON.stringify({
            distributions: [
              { id: ubuntu, name: 'Ubuntu', running: true },
              { id: debian, name: 'Debian', running: false },
            ],
            warning: null,
          }),
        );
    },
    { ubuntu, debian },
  );
  await host(page, '', '', 'Desktop', 'windows');
  const ubuntuRow = page
    .getByRole('article', { name: 'WSL · Ubuntu computer', exact: true })
    .locator('.computer-state');
  const debianRow = page
    .getByRole('article', { name: 'WSL · Debian computer', exact: true })
    .locator('.computer-state');
  await expect(ubuntuRow).toContainText('WSL running');
  await expect(page.locator('.environment-row, .provider-setup, .connection-copy')).toHaveCount(0);
  await expect(page.getByText('CLI setup', { exact: true })).toHaveCount(0);
  await expect(debianRow).toContainText('WSL stopped');
  await expect(page.locator('.fleet-computer')).toHaveCount(3);
  await expect(page.locator('select')).toHaveCount(0);
  const ubuntuCard = page.getByRole('article', { name: 'WSL · Ubuntu computer', exact: true });
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    'Installed',
  );
  await expect(ubuntuCard.getByLabel('Claude installation in WSL · Ubuntu')).toContainText(
    'Not installed',
  );
  await expect(
    page
      .getByRole('article', { name: 'Desktop computer', exact: true })
      .getByLabel('Claude installation in Windows'),
  ).toContainText('Installed');
  await expect(ubuntuCard).not.toContainText('C:\\CLIs');
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.locator('.fleet-computer')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/wsl-discovery-browser.png' });

  await page
    .getByRole('article', { name: 'Desktop computer', exact: true })
    .getByRole('button', { name: 'Add account', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Account purpose', exact: true })).toHaveCount(0);
  const provider = page.getByRole('combobox', { name: 'Account provider' });
  await provider.click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Codex work');
  await page.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
  const desktop = page.getByRole('article', { name: 'Desktop computer', exact: true });
  await expect(desktop.getByRole('heading', { name: 'Codex work' })).toBeVisible();
  // Both distributions have Codex, so the new account joins each of them by itself too.
  await expect(page.getByRole('heading', { name: 'Codex work' })).toHaveCount(3);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!));
  const added = saved.fleet.accounts.find((a: any) => a.name === 'Codex work');
  expect(added.provider).toBe('codex');
  expect(
    saved.fleet.connections.filter((c: any) => c.accountId === added.id).map((c: any) => c.profile),
  ).toEqual(['isolated', 'isolated', 'isolated']);
  await desktop
    .locator('.fleet-account')
    .filter({ hasText: 'Codex work' })
    .getByRole('button', { name: 'Manage account' })
    .click();
  await page.getByRole('button', { name: 'Save account' }).click();
  await ubuntuCard.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('WSL · Ubuntu');
  await expect(page.getByRole('combobox', { name: 'Account provider' })).toHaveText('Codex');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Manage computer Desktop' }).click();
  await page.getByText('Advanced: group environments', { exact: true }).click();
  const group = page.getByRole('combobox', { name: 'Group this environment under' });
  await group.click();
  await group.press('Escape');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.evaluate(() => localStorage.setItem('fixture-wsl-error', 'yes'));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic WSL discovery failure');
  await expect(ubuntuRow).toContainText('WSL state unavailable');
  await expect(page.locator('.fleet-computer')).toHaveCount(3);
  await page.evaluate(() => {
    localStorage.removeItem('fixture-wsl-error');
    const value = JSON.parse(localStorage.getItem('fixture-wsl')!);
    value.distributions[0].running = false;
    localStorage.setItem('fixture-wsl', JSON.stringify(value));
  });
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(ubuntuRow).toContainText('WSL stopped');
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.fleet-computer')).toHaveCount(3);
  await expect(ubuntuRow).toContainText('WSL stopped');
  await expect(page.locator('select')).toHaveCount(0);
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    'Installed',
  );
  await page.evaluate(() => localStorage.setItem('fixture-inventory-error', 'yes'));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(ubuntuCard.getByRole('alert')).toContainText('Synthetic installation check failure');
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    'Last check',
  );
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    '/usr/local/bin/codex',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).toContainText(
    'Installation unknown',
  );
  await expect(ubuntuCard.getByLabel('Codex installation in WSL · Ubuntu')).not.toContainText(
    'Not installed',
  );
});

test('one Windows app signs in, runs, and stops a WSL account without pairing a relay', async ({
  page,
}) => {
  const distroId = crypto.randomUUID();
  await page.addInitScript(
    ({ distroId }) =>
      localStorage.setItem(
        'fixture-wsl',
        JSON.stringify({
          distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
          warning: null,
        }),
      ),
    { distroId },
  );
  const identity = await host(page, '', '', 'Desktop', 'windows');
  await expect(
    page.locator('.sidebar-tools').getByRole('button', { name: 'Connections', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator('.sidebar-tools').getByRole('button', { name: 'Settings', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Computers & accounts', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: 'Claude', exact: true })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Your computers', exact: true })).toBeVisible();
  await expect(
    page.getByText('Open Agent Studio in Ubuntu and pair its relay to connect.'),
  ).toHaveCount(0);
  await page
    .getByRole('article', { name: 'WSL · Ubuntu computer', exact: true })
    .getByRole('button', { name: 'Add account', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('WSL · Ubuntu');
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Claude in Ubuntu');
  await page.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
  const account = page.locator('.fleet-account').filter({ hasText: 'Claude in Ubuntu' });
  await expect(account.getByRole('button', { name: 'Open sign-in', exact: true })).toBeEnabled();
  await account.getByRole('button', { name: 'Open sign-in', exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!));
  const connection = saved.fleet.connections.find((c: any) =>
    saved.fleet.accounts.some((a: any) => a.id === c.accountId && a.name === 'Claude in Ubuntu'),
  );
  expect(connection.environmentId).toBe(distroId);
  expect(connection.environmentId).not.toBe(identity.id);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-login')!)),
  ).toMatchObject({ provider: 'claude', connectionId: connection.id });
  await account.getByRole('button', { name: 'Chat', exact: true }).click();
  await chooseTestFolder(page);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Run through Windows into Ubuntu');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  expect(await page.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
    connection.id,
  );
  await expect(page.getByTestId('message').last().locator('.message-execution')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0].messages.at(-1)
          .executionLabel,
    ),
  ).toContain('WSL · Ubuntu');
  await page.evaluate(() => localStorage.setItem('fixture-slow', 'yes'));
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Stop the Linux process');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toContainText('Response from Desktop');
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'cancelled');
});

test('a remote computer reaches a WSL account through the paired Windows host', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-wsl-relay-'));
  const token = 'synthetic-wsl-relay-key-for-browser-checks-123';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const windows = await a.newPage(),
      mac = await b.newPage();
    const distroId = crypto.randomUUID();
    await windows.addInitScript(
      ({ distroId }) =>
        localStorage.setItem(
          'fixture-wsl',
          JSON.stringify({
            distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
            warning: null,
          }),
        ),
      { distroId },
    );
    await host(windows, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    await windows
      .getByRole('article', { name: 'WSL · Ubuntu computer', exact: true })
      .getByRole('button', { name: 'Add account', exact: true })
      .click();
    await expect(windows.getByRole('dialog')).toContainText('WSL · Ubuntu');
    await windows
      .getByRole('textbox', { name: 'Account name', exact: true })
      .fill('Claude WSL shared');
    await windows
      .getByRole('dialog')
      .getByRole('button', { name: 'Add account', exact: true })
      .click();
    await expect(
      windows
        .locator('.fleet-account')
        .filter({ hasText: 'Claude WSL shared' })
        .getByRole('button', { name: 'Open sign-in', exact: true }),
    ).toBeEnabled();
    const usageConnectionId = await windows.evaluate(() => {
      const w = window as any;
      const fleet = JSON.parse(localStorage.getItem('fixture-workspace')!).fleet;
      const account = fleet.accounts.find((a: any) => a.name === 'Claude WSL shared');
      const connection = fleet.connections.find((c: any) => c.accountId === account.id);
      (w.usageReadings ??= {})[connection.id] = {
        checkedAt: Date.now() / 1000,
        context: null,
        detail: 'Reported on Ubuntu through Desktop',
        windows: [
          {
            id: 'five-hour',
            label: '5-hour',
            usedPercent: 42,
            resetsAt: Date.now() / 1000 + 9000,
            windowMinutes: 300,
            model: null,
            bucket: 'claude',
          },
        ],
      };
      return connection.id;
    });
    for (const page of [windows, mac]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL').fill(url);
      await page.getByLabel('Relay pairing key').fill(token);
      await page.getByRole('button', { name: 'Pair & sync' }).click();
      await expect(page.locator('.fleet-relay .connection-badge')).toContainText('Paired', {
        timeout: 15_000,
      });
    }
    const account = mac.locator('.fleet-account').filter({ hasText: 'Claude WSL shared' });
    await expect(account).toBeVisible({ timeout: 15_000 });
    await expect(account.locator('.connection-hint')).toHaveCount(0, { timeout: 15_000 });
    await expect(
      account.getByRole('progressbar', { name: '5-hour limit used', exact: true }),
    ).toHaveAttribute('aria-valuenow', '42', { timeout: 15_000 });
    expect(
      await mac.evaluate(
        (id) => (window as any).usageCalls.some((c: any) => c.connectionId === id),
        usageConnectionId,
      ),
    ).toBe(false);
    await account.getByRole('button', { name: 'Chat', exact: true }).click();
    await chooseTestFolder(mac);
    await mac
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Reach Ubuntu through Windows');
    await mac.getByRole('button', { name: 'Send message' }).click();
    await expect(mac.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 20_000,
    });
    await expect(mac.getByTestId('message').last()).toContainText('Response from Desktop');
    const saved = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-workspace')!),
    );
    const connection = saved.fleet.connections.find(
      (c: { environmentId: string; accountId: string }) =>
        c.environmentId === distroId &&
        saved.fleet.accounts.some(
          (a: { id: string; name: string }) =>
            a.id === c.accountId && a.name === 'Claude WSL shared',
        ),
    );
    expect(await windows.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection.id,
    );
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
    const firstRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-run')!),
    );
    await mac.getByRole('button', { name: 'Model context', exact: true }).click();
    await expect(mac.getByRole('dialog')).toContainText('Inspected on the owning host.', {
      timeout: 20_000,
    });
    const contextRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-context')!),
    );
    expect(contextRequest.connectionId).toBe(connection.id);
    expect(contextRequest.location).toEqual(firstRequest.location);
    expect(await mac.evaluate(() => localStorage.getItem('fixture-context'))).toBeNull();
    await mac.getByRole('button', { name: 'Native prompt', exact: true }).click();
    await expect(mac.getByRole('dialog')).toContainText('Recorded on the owning host.', {
      timeout: 20_000,
    });
    await mac.getByRole('dialog').getByText('System prompt', { exact: true }).click();
    await expect(mac.getByRole('dialog').locator('pre:visible')).toHaveText(
      'Native instruction from Desktop',
    );
    const nativeRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-native-instructions')!),
    );
    expect(nativeRequest).toEqual({
      conversationId: firstRequest.conversationId,
      provider: 'claude',
      connectionId: connection.id,
    });
    expect(
      await mac.evaluate(() => localStorage.getItem('fixture-native-instructions')),
    ).toBeNull();
    await mac.getByRole('button', { name: 'Close model context' }).click();
    await mac.getByRole('button', { name: 'New conversation', exact: true }).click();
    await mac.getByRole('combobox', { name: 'Computer', exact: true }).click();
    await mac.getByRole('option', { name: 'MacBook', exact: true }).click();
    await mac.locator('#conversation-panel-active .folder-new-chat').click();
    await expect(mac.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
      'WSL · Ubuntu',
    );
    await expect(mac.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
      'title',
      firstRequest.location.path,
    );
    await expect(mac.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
    await mac
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Start another conversation in this remote folder');
    await mac.getByRole('button', { name: 'Send message' }).click();
    await expect(mac.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 20_000,
    });
    const folderRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-run')!),
    );
    expect(folderRequest.runId).not.toBe(firstRequest.runId);
    expect(folderRequest.location).toEqual(firstRequest.location);
    expect(await windows.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection.id,
    );
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
    await windows.evaluate(() => {
      (window as any).holdAccountNoticeReads = true;
    });
    await mac.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(mac.locator('.account-usage[aria-busy="true"]')).toHaveCount(0, {
      timeout: 15000,
    });
    await expect
      .poll(() => windows.evaluate(() => (window as any).pendingNoticeReads?.length ?? 0))
      .toBeGreaterThan(0);
    await mac.getByText('Sync settings', { exact: true }).click();
    await mac.getByRole('button', { name: 'Disconnect relay', exact: true }).click();
    await expect(
      account.getByRole('region', { name: 'Usage for Claude WSL shared' }),
    ).toContainText('Computer offline.');
    await expect(
      account.getByRole('progressbar', { name: '5-hour limit used', exact: true }),
    ).toHaveAttribute('aria-valuenow', '42');
    await expect(account.locator('.recommended-fill')).toHaveCount(0);
    await windows.evaluate(() =>
      (window as any).pendingNoticeReads.forEach((resolve: () => void) => resolve()),
    );
    await expect(mac.locator('.fleet-account .workspace-message')).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two app environments pair, share accounts, route chats, retain progress and cancel on the owning host', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-e2e-'));
  const token = 'synthetic-relay-key-for-browser-checks-123456';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const desktop = await a.newPage(),
      mac = await b.newPage();
    await host(desktop, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    await mac.getByRole('button', { name: 'Add account', exact: true }).click();
    await mac.getByLabel('Account name', { exact: true }).fill('Claude personal 1');
    await mac.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(mac.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    await mac
      .locator('.fleet-account')
      .filter({ hasText: 'Claude personal 1' })
      .getByRole('button', { name: 'Open sign-in', exact: true })
      .click();
    const connection = await mac.evaluate(
      () => JSON.parse(localStorage.getItem('fixture-login')!).connectionId,
    );
    expect(connection).toBeTruthy();
    for (const page of [mac, desktop]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL', { exact: true }).fill(url);
      await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
      await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 15_000 });
    }
    await expect(desktop.getByRole('heading', { name: 'MacBook', exact: true })).toBeVisible();
    await expect(desktop.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    await desktop
      .locator('.fleet-account')
      .filter({ hasText: 'Claude personal 1' })
      .getByRole('button', { name: 'Chat', exact: true })
      .click();
    await chooseTestFolder(desktop);
    await expect(desktop.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
      'MacBook',
    );
    await expect(desktop.getByRole('combobox', { name: 'Account and environment' })).toHaveCount(0);
    await desktop.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await desktop.getByRole('option', { name: 'Claude · Claude personal 1', exact: true }).click();
    const imageData = await desktop.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 60;
      canvas.getContext('2d')!.fillRect(0, 0, 80, 60);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await desktop.getByLabel('Image files').setInputFiles({
      name: 'remote-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(imageData, 'base64'),
    });
    await expect(desktop.getByRole('button', { name: 'Remove remote-image.png' })).toBeVisible();
    await desktop
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Hello from another computer');
    await expect(desktop.getByRole('button', { name: 'Send message' })).toBeEnabled({
      timeout: 15_000,
    });
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(
      desktop.getByTestId('message').filter({ hasText: 'Response from MacBook, completed.' }),
    ).toHaveAttribute('data-status', 'complete', { timeout: 20_000 });
    expect(await desktop.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
    // The reply names the image by hash, and the relay holds its bytes once for the computer
    // that runs it to read.
    const imageHash = createHash('sha256').update(Buffer.from(imageData, 'base64')).digest('hex');
    expect(
      await mac.evaluate(
        () => JSON.parse(localStorage.getItem('fixture-run')!).messages[0].images[0],
      ),
    ).toMatchObject({ name: 'remote-image.png', hash: imageHash });
    const held = await fetch(`${url}/v1/images/${imageHash}`, {
      headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
    });
    expect(Buffer.from(await held.arrayBuffer()).toString('base64')).toBe(imageData);
    await expect(desktop.locator('.activity-summary')).not.toHaveAttribute('open', '');
    await expect(desktop.getByLabel('Reply usage and cost')).not.toContainText(
      /input|output|tokens|cost|\$/i,
    );
    await desktop.getByLabel('Reply usage and cost').click();
    await expect(desktop.getByText('$0.012345', { exact: true })).toBeVisible();
    await desktop.getByLabel('Reply usage and cost').click();
    await expect(desktop.getByLabel('Work history', { exact: true })).toHaveText('Work history');
    await desktop.getByLabel('Work history', { exact: true }).click();
    await expect(desktop.getByLabel('Filter activity')).toHaveCount(0);
    await expect(desktop.getByText('Checked both remote sources.', { exact: true })).toBeVisible();
    await expect(desktop.getByText('Checking the remote sources.', { exact: true })).toHaveCount(0);
    await expect(desktop.locator('.activity-group')).toHaveCount(1);
    await expect(desktop.locator('.activity-group')).not.toHaveAttribute('open', '');
    await expect(desktop.locator('.activity-group > summary')).toHaveText('Ran 2 web searches');
    await desktop.locator('.activity-group > summary').click();
    await expect(desktop.locator('[data-category="search"]')).toHaveCount(2);
    await expect(desktop.locator('[data-category="search"]').first()).toBeVisible();
    for (const card of await desktop.locator('[data-category="search"]').all())
      await expect(card).toContainText('Completed');
    await expect
      .poll(() =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!)
              .conversations[0]?.messages.at(-1)
              ?.blocks.filter(
                (b: any) => b.tool?.category === 'search' && b.tool.status === 'complete',
              ).length,
        ),
      )
      .toBe(2);
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection,
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0]?.messages.at(-1)
              ?.status,
        ),
      )
      .toBe('complete');
    expect(
      await mac.evaluate(
        () =>
          JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0].messages[0]
            .images[0].hash,
      ),
    ).toBe(imageHash);
    expect(
      await mac.evaluate(
        () =>
          JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0].messages.at(-1)
            .usage.costUsd,
      ),
    ).toBe(0.012345);
    await expect
      .poll(async () =>
        desktop.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await mac.evaluate(() => localStorage.setItem('fixture-slow', 'true'));
    await desktop.getByRole('textbox', { name: 'Message', exact: true }).fill('A response to stop');
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(desktop.getByTestId('message').last()).toContainText('Response from MacBook', {
      timeout: 20_000,
    });
    await desktop.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect(desktop.getByTestId('message').last()).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 15_000 },
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0]?.messages.at(-1)
              ?.status,
        ),
      )
      .toBe('cancelled');
    await expect
      .poll(async () =>
        desktop.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await expect
      .poll(async () =>
        mac.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await desktop.getByRole('button', { name: 'Connections', exact: true }).click();
    await desktop.screenshot({ path: 'artifacts/federation-management.png', fullPage: true });
    // The executing environment can manage an inbound response without an initiating UI run.
    await desktop
      .getByRole('button', { name: 'Hello from another computer', exact: true })
      .first()
      .click();
    await desktop
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Stop this one on the host');
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(desktop.getByTestId('message').last()).toContainText('Response from MacBook', {
      timeout: 20_000,
    });
    // While the MacBook runs the reply, the device that started it chooses another account of
    // the agent for the next message.
    await desktop.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await desktop
      .getByRole('option', { name: /^Claude · / })
      .filter({ hasNotText: 'Claude personal 1' })
      .first()
      .click();
    await expect(desktop.locator('.next-reply-settings')).toContainText(/Next message: .+ account/);
    await mac
      .getByRole('button', { name: 'Hello from another computer', exact: true })
      .first()
      .click();
    // The host's window follows the reply as running: its settings wait for it, while the
    // account chosen on the other device already shows for the next message.
    await expect(
      mac.getByRole('button', { name: 'Chat instructions', exact: true }),
    ).toBeDisabled();
    const macAgent = mac.getByRole('combobox', { name: 'Agent', exact: true });
    await expect(macAgent).toBeEnabled();
    await expect(macAgent).not.toContainText('Claude personal 1', { timeout: 15_000 });
    await mac.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect(desktop.getByTestId('message').last()).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 15_000 },
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    // Both keep the account chosen for the next message, and the stopped reply its own.
    for (const page of [desktop, mac])
      await expect
        .poll(() =>
          page.evaluate((connection) => {
            const chat = JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0];
            return [chat.settings.connectionId === connection, chat.messages.at(-1).settings];
          }, connection),
        )
        .toEqual([false, expect.objectContaining({ connectionId: connection })]);
    expect(await desktop.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an account’s color is the same on every computer, and a choice made on one reaches the other', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-e2e-'));
  const token = 'synthetic-relay-key-for-browser-checks-123456';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const desktop = await a.newPage(),
      mac = await b.newPage();
    await host(desktop, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    for (const page of [desktop, mac]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL', { exact: true }).fill(url);
      await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
      await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 15_000 });
    }
    const colors = (page: Page) =>
      page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('fixture-workspace')!);
        return {
          accounts: workspace.fleet.accounts.length as number,
          list: (workspace.accountColors ?? []) as { accountId: string; color: string }[],
        };
      });
    // Each computer's own logins took their colors there. Synced, both hold one list with a
    // color for every account, none of them twice.
    await expect
      .poll(
        async () => {
          const [here, there] = [await colors(desktop), await colors(mac)];
          return (
            here.accounts === 6 &&
            here.list.length === 6 &&
            JSON.stringify(here.list) === JSON.stringify(there.list)
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const before = (await colors(desktop)).list;
    expect(new Set(before.map((c) => c.color)).size).toBe(6);

    // The MacBook's Claude account gets another color from the desktop.
    const claude = (page: Page) =>
      page
        .getByRole('article', { name: 'MacBook computer', exact: true })
        .locator('.fleet-account')
        .filter({ has: page.getByRole('heading', { name: 'Claude CLI login', exact: true }) });
    const dot = (page: Page) =>
      claude(page)
        .locator('.account-dot')
        .evaluate((element) => (element as HTMLElement).style.getPropertyValue('--account-color'));
    const taken = await dot(desktop);
    expect(await dot(mac)).toBe(taken);
    await claude(desktop).getByRole('button', { name: 'Manage account' }).click();
    const dialog = desktop.getByRole('dialog', { name: 'Manage account', exact: true });
    await dialog.getByRole('radio', { name: 'Brown', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await dot(desktop)).toBe('var(--account-brown)');
    await expect.poll(() => dot(mac), { timeout: 15_000 }).toBe('var(--account-brown)');
    // Only that account changed, on both computers.
    await expect
      .poll(async () => JSON.stringify((await colors(mac)).list), { timeout: 15_000 })
      .toBe(JSON.stringify((await colors(desktop)).list));
    const after = (await colors(mac)).list;
    expect(after.filter((c, i) => c.color !== before[i].color)).toHaveLength(1);
    expect(after.map((c) => c.accountId)).toEqual(before.map((c) => c.accountId));
  } finally {
    await a.close();
    await b.close();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a server’s accounts are added and signed in from another computer through the relay', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-e2e-'));
  const token = 'synthetic-relay-key-for-browser-checks-123456';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const desktop = await a.newPage(),
      vps = await b.newPage();
    await host(desktop, url, token, 'Desktop', 'windows');
    await host(vps, url, token, 'VPS', 'linux', true);
    for (const page of [vps, desktop]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL', { exact: true }).fill(url);
      await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
      await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 15_000 });
    }
    // A server keeps everyone's chats where they are and records no app session of its own.
    expect(
      await vps.evaluate(
        () => JSON.parse(localStorage.getItem('fixture-workspace')!).appSessions ?? [],
      ),
    ).toEqual([]);
    await vps.evaluate(() => ((window as any).separateProfilesSignIn = true));
    const server = desktop.getByRole('article', { name: 'VPS computer', exact: true });
    await expect(server.getByRole('heading', { name: 'Codex CLI login' })).toBeVisible({
      timeout: 15_000,
    });
    await server.getByRole('button', { name: 'Add account', exact: true }).click();
    const dialog = desktop.getByRole('dialog');
    await expect(dialog).toContainText('Add an account on VPS.');
    await dialog.getByRole('combobox', { name: 'Account provider' }).click();
    await desktop.getByRole('option', { name: 'Codex', exact: true }).click();
    await dialog.getByLabel('Account name', { exact: true }).fill('Codex on the server');
    await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
    const account = server.locator('.fleet-account').filter({ hasText: 'Codex on the server' });
    // The server signs in with a device code, and this computer shows its page and code.
    await expect(account.locator('.sign-in-user-code')).toContainText('ABCD-12345', {
      timeout: 15_000,
    });
    await expect(account.getByRole('button', { name: 'Open sign-in page' })).toBeVisible();
    await account.screenshot({ path: 'artifacts/server-account-sign-in-code.png' });
    const calls = await vps.evaluate(() => (window as any).signInCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'codex', remote: true });
    expect(await desktop.evaluate(() => (window as any).signInCalls ?? [])).toEqual([]);
    await expect(account).toContainText('Sign-in needed');
    // The code was entered on that page, and the server's CLI reports success.
    await vps.evaluate(() => {
      const w = window as any;
      localStorage.removeItem('fixture-pending-auth');
      (w.signedIn ??= []).push(w.remoteSignIn.connectionId);
      w.remoteSignIn = { ...w.remoteSignIn, phase: 'connected', message: '' };
      delete w.remoteSignIn.url;
      delete w.remoteSignIn.userCode;
      w.emitTauriEvent('studio-sign-in', w.remoteSignIn);
      w.remoteSignIn = undefined;
    });
    await expect(account.locator('.sign-in-user-code')).toHaveCount(0, { timeout: 15_000 });
    await expect(account).not.toContainText('Sign-in needed', { timeout: 15_000 });
    await desktop.screenshot({ path: 'artifacts/server-account-signed-in.png', fullPage: true });
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Runs `check` on a reply the MacBook runs for the desktop through a real relay, which sends a
 * model the MacBook keeps, 40 MB by its record, or with `compare` two of them side by side. With
 * `refused`, the way to the relay cannot carry the whole model, as relays before 2026-10-10
 * refused a result past 24 MB.
 */
async function modelReply(
  browser: Browser,
  refused: boolean,
  check: (reply: { desktop: Page; mac: Page; answer: Locator }) => Promise<void>,
  compare = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-e2e-'));
  const token = 'synthetic-relay-key-for-browser-checks-123456';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const desktop = await a.newPage(),
      mac = await b.newPage();
    await host(desktop, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    await mac.evaluate(
      ({ data, refused, compare }) => {
        localStorage.setItem('fixture-model', data);
        if (refused) localStorage.setItem('fixture-relay-refuses-models', '1');
        if (compare) localStorage.setItem('fixture-model-compare', '1');
      },
      { data: triangleGlbBase64({ animated: false }), refused, compare },
    );
    await mac.getByRole('button', { name: 'Add account', exact: true }).click();
    await mac.getByLabel('Account name', { exact: true }).fill('Claude personal 1');
    await mac.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(mac.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    for (const page of [mac, desktop]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL', { exact: true }).fill(url);
      await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
      await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 15_000 });
    }
    await expect(desktop.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    await desktop
      .locator('.fleet-account')
      .filter({ hasText: 'Claude personal 1' })
      .getByRole('button', { name: 'Chat', exact: true })
      .click();
    await chooseTestFolder(desktop);
    await desktop.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await desktop.getByRole('option', { name: 'Claude · Claude personal 1', exact: true }).click();
    await desktop.getByRole('textbox', { name: 'Message', exact: true }).fill('Show me the figure');
    await expect(desktop.getByRole('button', { name: 'Send message' })).toBeEnabled({
      timeout: 15_000,
    });
    await desktop.getByRole('button', { name: 'Send message' }).click();
    const answer = desktop
      .getByTestId('message')
      .filter({ hasText: 'Response from MacBook, completed.' });
    await expect(answer).toHaveAttribute('data-status', 'complete', { timeout: 20_000 });
    await check({ desktop, mac, answer });
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('another computer’s model comes whole through the relay, whatever its size', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await modelReply(browser, false, async ({ desktop, mac, answer }) => {
    // The desktop builds the scene of the model the MacBook keeps, read whole through the relay.
    await expect(answer.getByLabel('3D model figure.glb')).toBeVisible({ timeout: 30_000 });
    await expect(answer.getByText('GLB · 40 MB', { exact: true })).toBeVisible();
    await expect(answer.getByRole('slider', { name: 'Turn figure.glb' })).toHaveCount(0);
    // The MacBook read it once for the desktop, and drew no views of it.
    expect(await mac.evaluate(() => (window as any).modelReads)).toBe(1);
    expect(await mac.evaluate(() => (window as any).modelFileReads)).toBeUndefined();
    expect(await mac.evaluate(() => localStorage.getItem('fixture-model-views'))).toBeNull();
    expect(await desktop.evaluate(() => (window as any).modelFileReads)).toBeUndefined();
  });
});

test('another computer shows a model the relay cannot carry whole as eight views its own computer draws', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await modelReply(browser, true, async ({ desktop, mac, answer }) => {
    // The desktop asks for views instead, which the MacBook's window draws from the model it keeps.
    const turntable = answer.getByRole('slider', { name: 'Turn figure.glb' });
    await expect(turntable).toHaveAttribute('aria-valuetext', 'View 1 of 8', { timeout: 30_000 });
    await expect(answer.getByText('GLB · 40 MB · 8 views')).toBeVisible();
    await answer.locator('.model-view').screenshot({ path: 'artifacts/model-views/turntable.png' });
    const first = await turntable.locator('img').getAttribute('src');
    expect(first).toMatch(/^data:image\/webp;base64,/);
    await turntable.focus();
    await desktop.keyboard.press('ArrowRight');
    await expect(turntable).toHaveAttribute('aria-valuetext', 'View 2 of 8');
    expect(await turntable.locator('img').getAttribute('src')).not.toBe(first);
    await answer.getByRole('button', { name: 'Turn left' }).click();
    await answer.getByRole('button', { name: 'Turn left' }).click();
    await expect(turntable).toHaveAttribute('aria-valuetext', 'View 8 of 8');
    // Dragging to the right turns on, as it turns the 3D viewer.
    const box = (await turntable.boundingBox())!;
    await desktop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desktop.mouse.down();
    await desktop.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 5 });
    await desktop.mouse.up();
    await expect(turntable).toHaveAttribute('aria-valuetext', 'View 1 of 8');
    expect(await turntable.locator('img').getAttribute('src')).toBe(first);
    // Expanded, the same views turn at full size without asking again.
    await answer.getByRole('button', { name: 'Expand figure.glb' }).click();
    const preview = desktop.getByRole('dialog', { name: 'Model preview' });
    await expect(preview.getByRole('slider', { name: 'Turn figure.glb' })).toBeVisible();
    await preview.getByRole('button', { name: 'Turn right' }).click();
    await preview.screenshot({ path: 'artifacts/model-views/turntable-expanded.png' });
    await expect(preview.getByRole('slider', { name: 'Turn figure.glb' })).toHaveAttribute(
      'aria-valuetext',
      'View 2 of 8',
    );
    await desktop.getByRole('button', { name: 'Close model preview' }).click();
    // The model never left the MacBook: the relay refused it whole, and the MacBook read its
    // file once to draw the views, which it keeps.
    expect(await mac.evaluate(() => (window as any).modelFileReads)).toBe(1);
    expect(await desktop.evaluate(() => (window as any).modelFileReads)).toBeUndefined();
    const kept = await mac.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-model-views') ?? 'null'),
    );
    expect(kept.renderer).toBe(modelViewsRenderer);
    expect(kept.views).toHaveLength(8);
    expect(new Set(kept.views.map((view: { data: string }) => view.data)).size).toBeGreaterThan(1);
  });
});

test('compared models another computer could only draw as views turn together while synced', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await modelReply(
    browser,
    true,
    async ({ desktop, answer }) => {
      const before = answer.getByRole('slider', { name: 'Turn before.glb' });
      const after = answer.getByRole('slider', { name: 'Turn after.glb' });
      await expect(before).toHaveAttribute('aria-valuetext', 'View 1 of 8', { timeout: 30_000 });
      await expect(after).toHaveAttribute('aria-valuetext', 'View 1 of 8', { timeout: 30_000 });
      await expect(answer.getByText('GLB · 40 MB · 8 views')).toHaveCount(2);
      // Synced: turning one turns the other, by keys or by Reset.
      await before.focus();
      await desktop.keyboard.press('ArrowRight');
      await expect(before).toHaveAttribute('aria-valuetext', 'View 2 of 8');
      await expect(after).toHaveAttribute('aria-valuetext', 'View 2 of 8');
      await answer.getByRole('button', { name: 'Reset views' }).click();
      await expect(after).toHaveAttribute('aria-valuetext', 'View 1 of 8');
      await expect(before).toHaveAttribute('aria-valuetext', 'View 1 of 8');
      // Free: each turns on its own, and synced again they take the one turned last.
      await answer.getByRole('radio', { name: 'Free' }).click();
      await after.focus();
      await desktop.keyboard.press('End');
      await expect(after).toHaveAttribute('aria-valuetext', 'View 8 of 8');
      await expect(before).toHaveAttribute('aria-valuetext', 'View 1 of 8');
      await answer.getByRole('radio', { name: 'Synced' }).click();
      await expect(before).toHaveAttribute('aria-valuetext', 'View 8 of 8');
    },
    true,
  );
});
