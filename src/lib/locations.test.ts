import { describe, it, expect } from 'vitest';
import { initialWorkspace, restoreWorkspace, settingsFor, type Conversation } from './domain';
import { registerInstallation, registerWslEnvironments, type Fleet } from './fleet';
import {
  addHostAccounts,
  conversationLocation,
  ensureLocationConnections,
  groupConversations,
  historySectionId,
  knownLocations,
  locationConnections,
  locationKey,
  loginIdentity,
  nextActiveConversation,
  rememberLocation,
  computerFolderEnvironments,
  insideDistribution,
  scratchLocation,
  type LoginIdentity,
} from './locations';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';
import { sessionTimeline } from './app-sessions';

function fixture() {
  const workspace = initialWorkspace();
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'Desktop',
    platform: 'windows' as const,
  };
  registerInstallation(workspace.fleet, installation);
  const wsl = crypto.randomUUID();
  registerWslEnvironments(workspace.fleet, installation, {
    distributions: [{ id: wsl, name: 'Ubuntu', running: true }],
    warning: null,
  });
  const location = {
    computerId: installation.computerId,
    environmentId: wsl,
    path: '/home/test/project',
  };
  return { workspace, installation, location };
}
// A Claude account connected on Desktop, as a separate profile or its terminal login.
function desktopClaude(
  fleet: Fleet,
  environmentId: string,
  name: string,
  profile: 'isolated' | 'existing' = 'isolated',
) {
  const account = {
    id: crypto.randomUUID(),
    name,
    provider: 'claude' as const,
    purpose: 'personal' as const,
  };
  const connection = { id: crypto.randomUUID(), environmentId, accountId: account.id, profile };
  fleet.accounts.push(account);
  fleet.connections.push(connection);
  return connection;
}
describe('computer and folder chat scope', () => {
  it('runs a WSL folder chosen from the Windows computer inside its distribution', () => {
    const { workspace, installation, location } = fixture();
    const fromDesktop = { ...location, executionEnvironmentId: installation.id };
    expect(insideDistribution(workspace.fleet, fromDesktop)).toEqual(location);
    expect(insideDistribution(workspace.fleet, location)).toBe(location);
    const windows = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: 'C:\\work',
    };
    expect(insideDistribution(workspace.fleet, windows)).toBe(windows);
    // Another computer's folder, or one of an environment no longer known, stays as it was chosen.
    const unknown = { ...fromDesktop, environmentId: crypto.randomUUID() };
    expect(insideDistribution(workspace.fleet, unknown)).toBe(unknown);
    // A path into the distribution chosen as a Windows folder runs inside it too.
    for (const path of [
      '\\\\wsl.localhost\\Ubuntu\\home\\test\\project',
      '\\\\wsl$\\ubuntu\\home\\test\\project\\',
      '//wsl.localhost/Ubuntu/home//test/project',
      '\\\\WSL.LOCALHOST\\UBUNTU\\home\\test\\project',
    ])
      expect(insideDistribution(workspace.fleet, { ...windows, path })).toEqual(location);
    expect(
      insideDistribution(workspace.fleet, { ...windows, path: '\\\\wsl.localhost\\Ubuntu' }),
    ).toEqual({ ...location, path: '/' });
    for (const path of [
      '\\\\wsl.localhost\\Debian\\home\\test',
      '\\\\server\\share\\project',
      'C:\\wsl.localhost\\Ubuntu',
    ]) {
      const other = { ...windows, path };
      expect(insideDistribution(workspace.fleet, other)).toBe(other);
    }
    // A scratch chat saved with Desktop running the folder is a new chat: it runs inside too.
    expect(
      scratchLocation(workspace.fleet, {
        computerId: installation.computerId,
        location: fromDesktop,
      }),
    ).toEqual(location);
  });
  it('uses the selected computer for the same WSL folder and preserves both routes across storage and sync', () => {
    const { workspace, installation, location } = fixture();
    const desktopFolder = { ...location, executionEnvironmentId: installation.id };
    // Ubuntu's own logins first: once Desktop has accounts, the distribution takes those instead.
    ensureLocationConnections(workspace.fleet, location);
    ensureLocationConnections(workspace.fleet, desktopFolder);
    const windowsConnections = locationConnections(workspace.fleet, desktopFolder);
    expect(windowsConnections).toHaveLength(3);
    expect(windowsConnections.every((c) => c.environmentId === installation.id)).toBe(true);
    expect(
      locationConnections(workspace.fleet, location).every(
        (c) => c.environmentId === location.environmentId,
      ),
    ).toBe(true);
    expect(
      computerFolderEnvironments(workspace.fleet, installation.computerId).map((e) => e.id),
    ).toEqual([installation.id, location.environmentId]);
    expect(
      computerFolderEnvironments(workspace.fleet, location.environmentId).map((e) => e.id),
    ).toEqual([location.environmentId]);
    rememberLocation(workspace, desktopFolder);
    rememberLocation(workspace, location);
    expect(knownLocations(workspace, installation.computerId)).toEqual([desktopFolder]);
    expect(knownLocations(workspace, location.environmentId)).toEqual([location]);
    const base: Conversation = {
      id: crypto.randomUUID(),
      settings: { ...settingsFor(workspace.preferences), connectionId: windowsConnections[0].id },
      location: desktopFolder,
      title: 'Desktop agent',
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    workspace.conversations = [
      base,
      { ...base, id: crypto.randomUUID(), location, title: 'Linux agent' },
    ];
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[0].location).toEqual(desktopFolder);
    expect(
      mergeShared(emptyShared(), sharedWorkspace(restored), emptyShared()).conversations[0]
        .location,
    ).toEqual(desktopFolder);
    expect(
      groupConversations(restored.conversations, restored.fleet)[0].sections.map((c) => c.name),
    ).toEqual(['Desktop', 'WSL · Ubuntu']);
    const sibling = crypto.randomUUID();
    registerWslEnvironments(workspace.fleet, installation, {
      distributions: [{ id: sibling, name: 'Debian', running: true }],
      warning: null,
    });
    expect(
      locationConnections(workspace.fleet, { ...location, executionEnvironmentId: sibling }),
    ).toEqual([]);
    expect(() =>
      ensureLocationConnections(workspace.fleet, {
        ...location,
        executionEnvironmentId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
  it('pins existing logins to a folder environment without duplicating connections or profiles', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    ensureLocationConnections(workspace.fleet, location);
    const native = { ...location, environmentId: installation.id, path: 'C:\\project' };
    ensureLocationConnections(workspace.fleet, native);
    expect(locationConnections(workspace.fleet, location)).toHaveLength(2);
    expect(locationConnections(workspace.fleet, location, 'gemini')).toHaveLength(0);
    expect(locationConnections(workspace.fleet, native)).toHaveLength(3);
    expect(
      locationConnections(workspace.fleet, { ...location, computerId: crypto.randomUUID() }),
    ).toEqual([]);
    expect(workspace.fleet.connections.every((c) => c.profile === 'existing')).toBe(true);
    expect(() =>
      ensureLocationConnections(workspace.fleet, {
        ...location,
        environmentId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
  it('keeps a removed terminal login out while another account of its agent is connected there', () => {
    const { workspace, installation } = fixture();
    const native = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    };
    const identities = (login: LoginIdentity) => ({
      login: (_environmentId: string, provider: string) => (provider === 'claude' ? login : null),
      connection: (): LoginIdentity => 'vinporb@example.com',
    });
    const claude = () => locationConnections(workspace.fleet, native, 'claude');
    const labels = () =>
      workspace.fleet.accounts.filter((a) => a.provider === 'claude').map((a) => a.name);
    // A computer's first account of an agent is its terminal login.
    ensureLocationConnections(workspace.fleet, native, identities(undefined));
    const [login] = claude();
    expect(login).toMatchObject({ profile: 'existing' });
    const profile = {
      id: crypto.randomUUID(),
      name: 'vinporb',
      provider: 'claude' as const,
      purpose: 'personal' as const,
    };
    const isolated = {
      id: crypto.randomUUID(),
      environmentId: installation.id,
      accountId: profile.id,
      profile: 'isolated' as const,
    };
    workspace.fleet.accounts.push(profile);
    workspace.fleet.connections.push(isolated);
    workspace.fleet.connections = workspace.fleet.connections.filter((c) => c.id !== login.id);
    // Whatever the terminal reports later, unchecked, the same account, signed out as an expired
    // login is, or another account, its removed connection stays removed.
    for (const reported of [undefined, 'vinporb@example.com', null, 'other@example.com']) {
      ensureLocationConnections(workspace.fleet, native, identities(reported));
      expect(claude()).toEqual([isolated]);
    }
    expect(labels()).toEqual(['Claude CLI login', 'vinporb']);
    expect(locationConnections(workspace.fleet, native, 'codex')).toHaveLength(1);
    // With no account of the agent left there, the terminal login is the first one again, under
    // the label its removed connection left behind rather than another one.
    workspace.fleet.connections = workspace.fleet.connections.filter((c) => c.id !== isolated.id);
    ensureLocationConnections(workspace.fleet, native, identities('other@example.com'));
    expect(claude()).toMatchObject([{ accountId: login.accountId, profile: 'existing' }]);
    expect(labels()).toEqual(['Claude CLI login', 'vinporb']);
  });
  it('does not register a terminal login again after it became a separate profile without an identity', () => {
    const { workspace, installation } = fixture();
    const native = { computerId: installation.computerId, environmentId: installation.id, path: '' };
    const account = {
      id: crypto.randomUUID(),
      name: 'vinicius.portela.stm',
      provider: 'codex' as const,
      purpose: 'personal' as const,
    };
    const separated = {
      id: crypto.randomUUID(),
      environmentId: installation.id,
      accountId: account.id,
      profile: 'isolated' as const,
      sharedContext: 'none' as const,
      fromTerminalLogin: true,
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(separated);
    // Codex reports no login identity; the converted profile is an account of the agent there,
    // which keeps the terminal login out like any other.
    const identities = { login: () => null, connection: () => null };
    ensureLocationConnections(workspace.fleet, native, identities);
    expect(locationConnections(workspace.fleet, native, 'codex')).toEqual([separated]);
    delete (separated as { fromTerminalLogin?: boolean }).fromTerminalLogin;
    ensureLocationConnections(workspace.fleet, native, identities);
    expect(locationConnections(workspace.fleet, native, 'codex')).toEqual([separated]);
  });
  it('adds the Desktop accounts to a WSL distribution once, so one removed there stays removed', () => {
    const { workspace, installation, location } = fixture();
    const fleet = workspace.fleet;
    const ubuntu = location.environmentId;
    const desktop = (name: string, profile: 'isolated' | 'existing' = 'isolated') =>
      desktopClaude(fleet, installation.id, name, profile);
    desktop('vinporb');
    const gamer = desktop('gamer');
    const terminal = desktop('Claude CLI login', 'existing');
    const known = new Set<string>();
    let signedIn = (_id: string) => false;
    const identities = { login: () => null, connection: () => undefined };
    const refresh = () => {
      addHostAccounts(fleet, ubuntu, 'claude', known, (id) => signedIn(id), identities);
      ensureLocationConnections(fleet, location, identities);
    };
    const claude = () =>
      locationConnections(fleet, location, 'claude').map((c) => [
        fleet.accounts.find((a) => a.id === c.accountId)?.name,
        c.profile,
      ]);
    refresh();
    // Each joins as a separate profile that signs in there once. The Desktop login stays out while
    // signed out, and so does Ubuntu's own login while Desktop has Claude accounts.
    expect(claude()).toEqual([
      ['vinporb', 'isolated'],
      ['gamer', 'isolated'],
    ]);
    expect(locationConnections(fleet, location, 'codex')).toHaveLength(1);
    // One removed there stays removed, while an account added on Desktop later joins too.
    fleet.connections = fleet.connections.filter(
      (c) => c.environmentId !== ubuntu || c.accountId !== gamer.accountId,
    );
    desktop('third');
    refresh();
    expect(claude()).toEqual([
      ['vinporb', 'isolated'],
      ['third', 'isolated'],
    ]);
    // With every Claude account removed there, nothing comes back, not even Ubuntu's own login.
    const codex = locationConnections(fleet, location, 'codex');
    fleet.connections = fleet.connections.filter(
      (c) => c.environmentId !== ubuntu || codex.includes(c),
    );
    refresh();
    expect(claude()).toEqual([]);
    // The Desktop login joins once it is signed in there.
    signedIn = (id) => id === terminal.id;
    refresh();
    expect(claude()).toEqual([['Claude CLI login', 'isolated']]);
  });
  it('lets a WSL login that reports a Desktop account join as that account, never twice', () => {
    const { workspace, installation, location } = fixture();
    const fleet = workspace.fleet;
    const ubuntu = location.environmentId;
    const vinporb = desktopClaude(fleet, installation.id, 'vinporb');
    const gamer = desktopClaude(fleet, installation.id, 'gamer');
    const emails: Record<string, string> = {
      [vinporb.id]: 'vinporb@example.com',
      [gamer.id]: 'gamer@example.com',
    };
    const identities = {
      login: (environmentId: string, provider: string) =>
        provider === 'claude' && environmentId === ubuntu ? 'vinporb@example.com' : null,
      connection: (id: string) => emails[id],
    };
    addHostAccounts(fleet, ubuntu, 'claude', new Set(), () => false, identities);
    ensureLocationConnections(fleet, location, identities);
    // Ubuntu's terminal login already is vinporb, so it joins as vinporb without another sign-in.
    expect(locationConnections(fleet, location, 'claude')).toMatchObject([
      { accountId: vinporb.accountId, profile: 'existing' },
      { accountId: gamer.accountId, profile: 'isolated' },
    ]);
    expect(fleet.accounts.filter((a) => a.provider === 'claude')).toHaveLength(2);
    // Desktop has no Codex account, so Ubuntu's own Codex login joins as before.
    expect(fleet.accounts.find((a) => a.provider === 'codex')?.name).toBe('Codex CLI login');
    // An account a connection already there reports is left out rather than added twice.
    const other = fixture();
    ensureLocationConnections(other.workspace.fleet, other.location);
    const [own] = locationConnections(other.workspace.fleet, other.location, 'claude');
    const first = desktopClaude(other.workspace.fleet, other.installation.id, 'vinporb');
    const second = desktopClaude(other.workspace.fleet, other.installation.id, 'gamer');
    emails[first.id] = 'vinporb@example.com';
    emails[second.id] = 'gamer@example.com';
    emails[own.id] = 'gamer@example.com';
    addHostAccounts(
      other.workspace.fleet,
      other.location.environmentId,
      'claude',
      new Set(),
      () => false,
      { login: () => undefined, connection: (id) => emails[id] },
    );
    expect(
      locationConnections(other.workspace.fleet, other.location, 'claude').map((c) => c.accountId),
    ).toEqual([own.accountId, first.accountId]);
    expect(loginIdentity(undefined)).toBeUndefined();
    expect(loginIdentity({ auth: 'unknown', account: 'a@b' })).toBeUndefined();
    expect(loginIdentity({ auth: 'login', account: 'a@b' })).toBeNull();
    expect(loginIdentity({ auth: 'ready' })).toBeNull();
    expect(loginIdentity({ auth: 'ready', account: '  a@b ' })).toBe('a@b');
  });
  it('restores folders and archived messages and groups identical names independently by computer', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [],
    };
    const other = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'Laptop',
      platform: 'linux' as const,
    };
    registerInstallation(workspace.fleet, other);
    workspace.conversations = [
      conversation,
      { ...conversation, id: crypto.randomUUID(), archived: true },
      {
        ...conversation,
        id: crypto.randomUUID(),
        location: { ...location, computerId: other.computerId, environmentId: other.id },
      },
    ];
    rememberLocation(workspace, location);
    rememberLocation(workspace, location);
    expect(knownLocations(workspace, installation.computerId)).toHaveLength(0);
    expect(knownLocations(workspace, location.environmentId)).toHaveLength(1);
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[1].archived).toBe(true);
    const groups = groupConversations(restored.conversations, restored.fleet, installation);
    expect(groups[0].sections.map((c) => c.name)).toEqual(['WSL · Ubuntu', 'Laptop']);
    expect(restored.conversations[0].location).toEqual(location);
    expect(groups[0].sections[0].folders[0].name).toBe('project');
    expect(groups[1].count).toBe(1);
    const legacy = { ...conversation, location: undefined };
    expect(conversationLocation(legacy, workspace.fleet, installation)?.path).toBe('');
    expect(
      conversationLocation(
        { ...legacy, settings: { ...legacy.settings, connectionId: crypto.randomUUID() } },
        workspace.fleet,
        installation,
      ),
    ).toBeUndefined();
  });
  it('lists scratch chats first in their Active folder and in folders of their own afterwards', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [],
    };
    const scratches = [
      { id: 'same folder', computerId: location.environmentId, location },
      // Without a folder yet, a scratch chat waits in its computer's Standalone group.
      { id: 'no folder', computerId: installation.computerId },
      { id: 'unknown computer', computerId: crypto.randomUUID() },
    ];
    const [active, history] = groupConversations(
      [conversation, { ...conversation, id: crypto.randomUUID(), archived: true }],
      workspace.fleet,
      installation,
      scratches,
    );
    expect(
      active.sections.map((c) => [
        c.name,
        c.folders.map((f) => [f.name, f.scratches.map((s) => s.id), f.conversations.length]),
      ]),
    ).toEqual([
      ['WSL · Ubuntu', [['project', ['same folder'], 1]]],
      ['Desktop', [['Standalone', ['no folder'], 0]]],
      ['Unavailable computer', [['Standalone', ['unknown computer'], 0]]],
    ]);
    // Scratch chats are not conversations: they are not counted and never join History.
    expect(active.count).toBe(1);
    expect(history.sections.flatMap((c) => c.folders.flatMap((f) => f.scratches))).toEqual([]);
    expect(scratchLocation(workspace.fleet, scratches[1])).toEqual({
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    });
    expect(scratchLocation(workspace.fleet, scratches[0])).toBe(location);
    expect(scratchLocation(workspace.fleet, scratches[2])).toBeUndefined();
  });
  it('groups History by the app session each chat was last used in, else by day', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const laptop = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'Laptop',
      platform: 'linux' as const,
    };
    registerInstallation(workspace.fleet, laptop);
    const standalone = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    };
    const time = (day: number, hour: number, minute = 0) =>
      new Date(2026, 8, day, hour, minute).getTime();
    const chat = (title: string, used: number, place = location, archived = true) =>
      ({
        id: title,
        settings: settingsFor(workspace.preferences),
        location: place,
        title,
        createdAt: new Date(used - 60_000).toISOString(),
        updatedAt: new Date(used).toISOString(),
        messages: [{ createdAt: new Date(used).toISOString() }],
        ...(archived ? { archived } : {}),
      }) as unknown as Conversation;
    const session = (environmentId: string, startedAt: number) => ({
      id: crypto.randomUUID(),
      environmentId,
      startedAt: new Date(startedAt).toISOString(),
    });
    const morning = session(installation.id, time(24, 9));
    const evening = session(installation.id, time(24, 20));
    const away = session(laptop.id, time(25, 8));
    const conversations = [
      chat('laptop', time(25, 8, 30), {
        computerId: laptop.computerId,
        environmentId: laptop.id,
        path: '/srv/app',
      }),
      chat('open', time(25, 9), location, false),
      chat('late project', time(24, 21, 30)),
      chat('late question', time(24, 21), standalone),
      chat('morning', time(24, 9, 30)),
      chat('legacy', time(20, 10)),
    ];
    const now = time(25, 12);
    const [active, history] = groupConversations(
      conversations,
      workspace.fleet,
      installation,
      [],
      [away, evening, morning],
      now,
    );
    expect(active.sections.flatMap((s) => s.folders.flatMap((f) => f.conversations))).toEqual([
      conversations[1],
    ]);
    expect(history.count).toBe(5);
    const clock = (value: string) =>
      new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(
      history.sections.map((s) => [
        s.kind,
        s.name,
        s.folders.map((f) => [f.name, f.computerName, f.conversations.map((c) => c.id)]),
      ]),
    ).toEqual([
      ['session', `Today, ${clock(away.startedAt)} · Laptop`, [['app', 'Laptop', ['laptop']]]],
      [
        'session',
        `Yesterday, ${clock(evening.startedAt)} · Desktop`,
        [
          ['project', 'WSL · Ubuntu', ['late project']],
          ['Standalone', 'Desktop', ['late question']],
        ],
      ],
      [
        'session',
        `Yesterday, ${clock(morning.startedAt)} · Desktop`,
        [['project', 'WSL · Ubuntu', ['morning']]],
      ],
      // Chats last used before the first recorded start are listed by day.
      [
        'day',
        new Date(time(20, 10)).toLocaleDateString([], { weekday: 'long' }),
        [['project', 'WSL · Ubuntu', ['legacy']]],
      ],
    ]);
    const [, evenings, mornings, days] = history.sections;
    // Folders name their computer only in sessions with chats of several.
    expect([evenings, mornings, days].map((s) => s.kind !== 'computer' && s.computers)).toEqual([
      2, 1, 1,
    ]);
    expect(mornings.kind !== 'computer' && mornings.detail).toBe(
      `App session started ${new Date(morning.startedAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })} on Desktop`,
    );
    expect(days.kind !== 'computer' && days.detail).toMatch(/before app sessions were recorded$/);
    const timeline = sessionTimeline([away, evening, morning]);
    for (const section of history.sections)
      for (const folder of section.folders)
        for (const c of folder.conversations)
          expect(historySectionId(c, timeline)).toBe(section.id);
    // With starts of one computer only, headings name no computer.
    const [, alone] = groupConversations(
      conversations.slice(2),
      workspace.fleet,
      installation,
      [],
      [morning, evening],
      now,
    );
    expect(alone.sections.map((s) => s.name).slice(0, 2)).toEqual([
      `Yesterday, ${clock(evening.startedAt)}`,
      `Yesterday, ${clock(morning.startedAt)}`,
    ]);
  });
  it('moves on to the Active conversation listed below a chat leaving Active in its folder, else the one above', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const chat = (title: string, place = location, archived = false): Conversation => ({
      id: title,
      settings: settingsFor(workspace.preferences),
      location: place,
      title,
      createdAt: '',
      updatedAt: '',
      messages: [],
      ...(archived ? { archived } : {}),
    });
    const standalone = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    };
    const conversations = [
      chat('first'),
      chat('archived', location, true),
      chat('second'),
      chat('other project', { ...location, path: '/home/test/other' }),
      chat('standalone', standalone),
    ];
    const groups = groupConversations(conversations, workspace.fleet, installation, [
      { id: 'scratch', computerId: installation.computerId, location: standalone },
    ]);
    const next = (id: string) => nextActiveConversation(groups, id)?.id;
    // The next chat stays in the folder, never the folder or computer listed after it; History
    // and scratch chats are skipped.
    expect(next('first')).toBe('second');
    expect(next('second')).toBe('first');
    // A folder's last chat has none, so the page opens a new chat in that folder.
    expect(next('other project')).toBeUndefined();
    expect(next('standalone')).toBeUndefined();
    expect(next('archived')).toBeUndefined();
    expect(next('unknown')).toBeUndefined();
    const alone = groupConversations([chat('only')], workspace.fleet, installation);
    expect(nextActiveConversation(alone, 'only')).toBeUndefined();
  });
  it('lists pinned chats atop the tab they are in, the most recently pinned first', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const chat = (title: string, place = location, archived = false): Conversation => ({
      id: title,
      settings: settingsFor(workspace.preferences),
      location: place,
      title,
      createdAt: '',
      updatedAt: '',
      messages: [],
      ...(archived ? { archived } : {}),
    });
    const other = { ...location, path: '/home/test/other' };
    const conversations = [
      chat('first'),
      chat('pinned first'),
      chat('second'),
      chat('pinned other', other),
      chat('pinned second'),
      chat('pinned history', location, true),
      chat('history', location, true),
    ];
    const pins = new Map(
      [
        ['pinned first', '2026-11-01T09:00:00.000Z'],
        ['pinned other', '2026-11-01T10:00:00.000Z'],
        ['pinned second', '2026-11-01T08:00:00.000Z'],
        ['pinned history', '2026-11-01T11:00:00.000Z'],
        // A pin whose chat has not arrived here yet lists nothing.
        ['elsewhere', '2026-11-01T12:00:00.000Z'],
      ].map(([id, at]) => [id, { at }]),
    );
    const groups = groupConversations(
      conversations,
      workspace.fleet,
      installation,
      [],
      [],
      Date.now(),
      pins,
    );
    const [active, history] = groups;
    // Pinned chats stay in their tab, leave their folder and keep their own folder's place.
    expect(active.pinned.map((p) => [p.conversation.id, p.location?.path, p.folderId])).toEqual([
      ['pinned other', other.path, locationKey(other)],
      ['pinned first', location.path, locationKey(location)],
      ['pinned second', location.path, locationKey(location)],
    ]);
    expect(
      active.sections.flatMap((s) =>
        s.folders.map((f) => [f.name, f.conversations.map((c) => c.id)]),
      ),
    ).toEqual([['project', ['first', 'second']]]);
    expect(history.pinned.map((p) => p.conversation.id)).toEqual(['pinned history']);
    expect(
      history.sections.flatMap((s) => s.folders.flatMap((f) => f.conversations.map((c) => c.id))),
    ).toEqual(['history']);
    // Tabs still count every chat they hold.
    expect([active.count, history.count]).toEqual([5, 2]);
    // Leaving Active, a chat gives way to the next chat of its folder, the folder's pinned chats
    // first in their order, never another folder's chat.
    const next = (id: string) => nextActiveConversation(groups, id)?.id;
    expect(next('pinned first')).toBe('pinned second');
    expect(next('pinned second')).toBe('first');
    expect(next('first')).toBe('second');
    expect(next('second')).toBe('first');
    expect(next('pinned other')).toBeUndefined();
    expect(next('pinned history')).toBeUndefined();
    // Without pins, nothing is pinned.
    expect(groupConversations(conversations, workspace.fleet, installation)[0].pinned).toEqual([]);
  });

  it('syncs archiving and never loses a concurrent location or history edit during run reconciliation', () => {
    const { workspace, installation, location } = fixture();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [
        {
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          role: 'assistant',
          status: 'complete',
          blocks: [],
          createdAt: '',
        },
      ],
    };
    workspace.conversations.push(conversation);
    const base = sharedWorkspace(workspace);
    const archived = structuredClone(base);
    archived.conversations[0].archived = true;
    expect(mergeShared(base, archived, base).conversations[0].archived).toBe(true);
    const remote = structuredClone(base);
    remote.conversations[0].location!.path = '/another/project';
    const merged = mergeShared(base, archived, remote);
    expect(merged.conversations).toHaveLength(2);
    expect(merged.conversations.some((c) => c.archived)).toBe(true);
    expect(groupConversations(merged.conversations, workspace.fleet, installation)[1].count).toBe(
      1,
    );
    expect(mergeShared(emptyShared(), base, emptyShared()).conversations[0].location).toEqual(
      location,
    );
  });
});
