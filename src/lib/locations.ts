import {
  providerIds,
  type ChatLocation,
  type Conversation,
  type ProviderId,
  type Workspace,
} from './domain';
import {
  computerViewId,
  computerViews,
  type Connection,
  type Fleet,
  type Installation,
} from './fleet';
import {
  dayLabel,
  lastUsed,
  sessionAt,
  sessionLabel,
  sessionTimeline,
  startOfDay,
  type AppSession,
  type SessionTimeline,
} from './app-sessions';

export const locationKey = (location: ChatLocation) =>
  `${location.computerId}/${locationExecutionId(location)}/${location.environmentId}/${location.path}`;
export const locationExecutionId = (location: ChatLocation) =>
  location.executionEnvironmentId ?? location.environmentId;
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function locationExecutionEnvironment(fleet: Fleet, location: ChatLocation) {
  const folder = fleet.environments.find(
    (e) => e.id === location.environmentId && e.computerId === location.computerId,
  );
  const execution = fleet.environments.find(
    (e) => e.id === locationExecutionId(location) && e.computerId === location.computerId,
  );
  return folder &&
    execution &&
    (folder.id === execution.id ||
      (execution.platform === 'windows' &&
        folder.platform === 'wsl' &&
        folder.discoveredOn === execution.id))
    ? execution
    : undefined;
}
/**
 * Where a new chat in this folder runs: a folder inside a WSL distribution runs inside it, with
 * that distribution's own CLI, as the Claude app runs one, so choosing it from the Windows
 * computer moves the chat there, and so does a `\\wsl.localhost\<distribution>\…` path chosen
 * there. Other folders run where they were chosen. Every new chat takes its folder through this;
 * chats saved with Desktop running a WSL folder keep doing so.
 */
export function insideDistribution(fleet: Fleet, location: ChatLocation): ChatLocation {
  const folder = fleet.environments.find((e) => e.id === location.environmentId);
  const share = folder?.platform === 'windows' ? wslShare(location.path) : undefined;
  if (share) {
    const inside = fleet.environments.find(
      (e) =>
        e.platform === 'wsl' &&
        e.discoveredOn === folder?.id &&
        e.distribution?.toLowerCase() === share.distribution.toLowerCase(),
    );
    return inside
      ? { computerId: inside.computerId, environmentId: inside.id, path: share.path }
      : location;
  }
  if (locationExecutionId(location) === location.environmentId) return location;
  if (folder?.platform !== 'wsl') return location;
  const inside = { ...location };
  delete inside.executionEnvironmentId;
  return inside;
}
/** The distribution and Linux path that a Windows path into a WSL distribution names. */
export function wslShare(path: string): { distribution: string; path: string } | undefined {
  const match = /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i.exec(path);
  if (!match) return;
  const rest = (match[2] ?? '').split(/[\\/]+/).filter(Boolean);
  return { distribution: match[1], path: `/${rest.join('/')}` };
}
export function computerFolderEnvironments(fleet: Fleet, computerId: string) {
  const computer = computerViews(fleet).find((c) => c.id === computerId);
  if (!computer) return [];
  return fleet.environments.filter((e) =>
    computer.environments.some(
      (execution) =>
        e.id === execution.id ||
        (execution.platform === 'windows' &&
          e.platform === 'wsl' &&
          e.discoveredOn === execution.id &&
          e.computerId === execution.computerId),
    ),
  );
}
// The signed-in identity a CLI reports for one login: `undefined` while it is still unchecked or
// could not be verified, `null` when it is signed out or the CLI reports no identity, otherwise
// the identity itself (Claude's account email).
export type LoginIdentity = string | null | undefined;
export type LoginIdentities = {
  login: (environmentId: string, provider: ProviderId) => LoginIdentity;
  connection: (connectionId: string) => LoginIdentity;
};
export function loginIdentity(
  status: { auth: string; account?: string | null } | undefined,
): LoginIdentity {
  if (!status || status.auth === 'unknown') return undefined;
  if (status.auth === 'login') return null;
  const account = status.account?.trim();
  return account ? account : null;
}
// Account connections belong to the selected execution computer, independently of the folder.
export function ensureLocationConnections(
  fleet: Fleet,
  location: ChatLocation,
  identities?: LoginIdentities,
) {
  const environment = locationExecutionEnvironment(fleet, location);
  if (!environment) throw new Error('This folder or execution computer is no longer available.');
  ensureEnvironmentConnections(fleet, environment.id, providerIds, identities);
}
const providerOf = (fleet: Fleet, connection: Connection) =>
  fleet.accounts.find((a) => a.id === connection.accountId)?.provider;
// Whether an account of this agent is connected on the environment, in any profile.
export const environmentOffers = (fleet: Fleet, environmentId: string, provider: ProviderId) =>
  fleet.connections.some(
    (c) => c.environmentId === environmentId && providerOf(fleet, c) === provider,
  );
// Registers each detected CLI's existing login as a connection while the environment has no
// account of that agent yet. Once one is connected there (the login itself, a separate profile,
// or the login turned into one), the login is never added again: removing it keeps it removed,
// whether the terminal later signs out or into another account, and Add account connects more.
// A WSL distribution Windows manages takes that computer's accounts instead (`addHostAccounts`),
// and its own login only while Windows has no account of the agent.
export function ensureEnvironmentConnections(
  fleet: Fleet,
  environmentId: string,
  detectedProviders: readonly ProviderId[],
  identities?: LoginIdentities,
) {
  const environment = fleet.environments.find((e) => e.id === environmentId);
  if (!environment) return;
  for (const provider of detectedProviders) {
    if (environment.platform === 'wsl' && environment.discoveredOn && provider === 'gemini')
      continue;
    if (environmentOffers(fleet, environment.id, provider)) continue;
    if (environment.discoveredOn && environmentOffers(fleet, environment.discoveredOn, provider))
      continue;
    const login = identities?.login(environment.id, provider);
    const match = login
      ? fleet.connections.find(
          (c) =>
            c.environmentId !== environment.id &&
            providerOf(fleet, c) === provider &&
            identities!.connection(c.id) === login,
        )
      : undefined;
    const name = `${provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Gemini'} CLI login`;
    // A default label left behind by a removed login connection is reused rather than duplicated.
    let account =
      fleet.accounts.find((a) => a.id === match?.accountId) ??
      fleet.accounts.find(
        (a) =>
          a.provider === provider &&
          a.name === name &&
          !fleet.connections.some((c) => c.accountId === a.id),
      );
    if (!account) {
      account = { id: crypto.randomUUID(), name, provider, purpose: 'personal' as const };
      fleet.accounts.push(account);
    }
    fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId: environment.id,
      accountId: account.id,
      profile: 'existing',
    });
  }
}
// Adds the Windows computer's accounts of an agent to a WSL distribution it manages, its
// separate profiles and its terminal login while signed in, under the same names: each is a
// separate profile there and signs in once, since a login never moves between computers. While
// the distribution has no account of the agent, its terminal login joins as the account it
// reports instead, and an account another connection there already reports is left out. `known`
// holds every account the distribution has had and gains those connected now, so one removed
// there is never added again.
export function addHostAccounts(
  fleet: Fleet,
  environmentId: string,
  provider: ProviderId,
  known: Set<string>,
  signedIn: (connectionId: string) => boolean,
  identities?: LoginIdentities,
) {
  const host = fleet.environments.find((e) => e.id === environmentId)?.discoveredOn;
  if (!host || provider === 'gemini') return;
  const here = () => fleet.connections.filter((c) => c.environmentId === environmentId);
  for (const connection of here()) known.add(connection.accountId);
  const login = environmentOffers(fleet, environmentId, provider)
    ? undefined
    : identities?.login(environmentId, provider);
  const accounts = fleet.connections.filter(
    (c) =>
      c.environmentId === host &&
      providerOf(fleet, c) === provider &&
      (c.profile === 'isolated' || signedIn(c.id)),
  );
  for (const account of accounts) {
    if (known.has(account.accountId)) continue;
    const identity = identities?.connection(account.id);
    if (identity && here().some((c) => identities!.connection(c.id) === identity)) continue;
    const terminal = !!login && login === identity && !here().some((c) => c.profile === 'existing');
    fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId,
      accountId: account.accountId,
      profile: terminal ? 'existing' : 'isolated',
    });
    known.add(account.accountId);
  }
}
export function locationConnections(fleet: Fleet, location?: ChatLocation, provider?: ProviderId) {
  if (!location) return [];
  const environment = locationExecutionEnvironment(fleet, location);
  if (!environment) return [];
  return fleet.connections.filter(
    (c) =>
      c.environmentId === environment.id &&
      fleet.accounts.some((a) => a.id === c.accountId && (!provider || a.provider === provider)),
  );
}
export function rememberLocation(workspace: Workspace, location: ChatLocation) {
  workspace.preferences.recentLocations = [
    location,
    ...(workspace.preferences.recentLocations ?? []).filter(
      (l) => locationKey(l) !== locationKey(location),
    ),
  ].slice(0, 30);
}
export function knownLocations(workspace: Workspace, computerId: string) {
  const view = computerViews(workspace.fleet).find((c) => c.id === computerId);
  const values = [
    ...(workspace.preferences.recentLocations ?? []),
    ...workspace.conversations.flatMap((c) => (c.location?.path ? [c.location] : [])),
  ];
  return [
    ...new Map(
      values
        .filter(
          (l) =>
            view?.environments.some(
              (e) => e.id === locationExecutionId(l) && e.computerId === l.computerId,
            ) && locationConnections(workspace.fleet, l).length,
        )
        .map((l) => [locationKey(l), l]),
    ).values(),
  ];
}
export function conversationLocation(
  conversation: Conversation,
  fleet: Fleet,
  installation?: Installation,
): ChatLocation | undefined {
  if (conversation.location) return conversation.location;
  const connection = fleet.connections.find((c) => c.id === conversation.settings.connectionId);
  const environment = fleet.environments.find(
    (e) =>
      e.id ===
      (connection?.environmentId ??
        (!conversation.settings.connectionId ? installation?.id : undefined)),
  );
  return environment
    ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
    : undefined;
}
// A scratch chat's folder, or its computer's Standalone location while it has none.
export function scratchLocation(
  fleet: Fleet,
  scratch: { computerId: string; location?: ChatLocation },
): ChatLocation | undefined {
  // A scratch chat is a new chat: one saved on Desktop with a WSL folder runs inside it.
  if (scratch.location) return insideDistribution(fleet, scratch.location);
  const environment = computerViews(fleet).find((c) => c.id === scratch.computerId)
    ?.environments[0];
  return environment
    ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
    : undefined;
}
type FolderGroup<S> = {
  id: string;
  name: string;
  detail: string;
  computerId: string;
  computerName: string;
  location?: ChatLocation;
  conversations: Conversation[];
  scratches: S[];
};
export type ConversationSection<S> =
  | { kind: 'computer'; id: string; name: string; folders: FolderGroup<S>[] }
  // History: an app session, or a day for chats last used before sessions were recorded.
  | {
      kind: 'session' | 'day';
      id: string;
      name: string;
      detail: string;
      // Computers of its folders; the folders name theirs when there is more than one.
      computers: number;
      folders: FolderGroup<S>[];
    };
// The History section of a chat: the app session it was last used in, else the day.
export function historySectionId(conversation: Conversation, timeline: SessionTimeline) {
  const used = lastUsed(conversation);
  const session = sessionAt(timeline, used);
  if (session) return session.id;
  if (!Number.isFinite(used)) return 'earlier';
  const day = new Date(used);
  return `day:${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
}
// A pinned chat, listed at the top of its tab with the folder it belongs to.
export type PinnedChat = {
  conversation: Conversation;
  location?: ChatLocation;
  // Its folder group's id, so the chat opened after it leaves Active stays in that folder.
  folderId: string;
};
// Active conversations by computer and folder, and History ones by app session and folder.
// Scratch chats, new conversations not sent yet, are listed in Active only: first in their
// folder, and in folders of their own after the folders that hold conversations. Pinned chats
// lead the tab they are in, the most recently pinned first, instead of their folder.
export function groupConversations<S extends { computerId: string; location?: ChatLocation }>(
  conversations: Conversation[],
  fleet: Fleet,
  installation?: Installation,
  scratches: S[] = [],
  appSessions: AppSession[] = [],
  now = Date.now(),
  pins: ReadonlyMap<string, { at: string }> = new Map(),
) {
  const views = computerViews(fleet);
  const computerName = (id: string) =>
    views.find((c) => c.id === id)?.name ?? 'Unavailable computer';
  const computerOf = (location: ChatLocation | undefined) => {
    const execution = location ? locationExecutionEnvironment(fleet, location) : undefined;
    return execution ? computerViewId(execution) : (location?.computerId ?? 'unassigned');
  };
  const folderIn = (folders: Map<string, FolderGroup<S>>, location: ChatLocation | undefined) => {
    const key = location ? locationKey(location) : 'unassigned';
    let folder = folders.get(key);
    if (!folder) {
      const environment = fleet.environments.find(
        (e) => e.id === location?.environmentId && e.computerId === location?.computerId,
      );
      const computerId = computerOf(location);
      folder = {
        id: key,
        name: location?.path ? folderName(location.path) : 'Standalone',
        detail: `${environment?.name ?? 'Unavailable environment'} · ${location?.path || 'Standalone chats without a project folder'}`,
        computerId,
        computerName: computerName(computerId),
        location: location ? { ...location } : undefined,
        conversations: [],
        scratches: [],
      };
      folders.set(key, folder);
    }
    return folder;
  };
  const computers = new Map<
    string,
    { id: string; name: string; folders: Map<string, FolderGroup<S>> }
  >();
  const activeFolder = (location: ChatLocation | undefined) => {
    const id = computerOf(location);
    let computer = computers.get(id);
    if (!computer)
      computers.set(id, (computer = { id, name: computerName(id), folders: new Map() }));
    return folderIn(computer.folders, location);
  };
  const pinnedIn = (listed: Conversation[]): PinnedChat[] =>
    listed
      .filter((c) => pins.has(c.id))
      .map((conversation) => {
        const location = conversationLocation(conversation, fleet, installation);
        return {
          conversation,
          location,
          folderId: location ? locationKey(location) : 'unassigned',
        };
      })
      .sort(
        (a, b) =>
          Date.parse(pins.get(b.conversation.id)!.at) - Date.parse(pins.get(a.conversation.id)!.at),
      );
  const active = conversations.filter((c) => !c.archived);
  for (const conversation of active)
    if (!pins.has(conversation.id))
      activeFolder(conversationLocation(conversation, fleet, installation)).conversations.push(
        conversation,
      );
  for (const scratch of scratches)
    activeFolder(scratchLocation(fleet, scratch)).scratches.push(scratch);
  const timeline = sessionTimeline(appSessions);
  const recorders = new Set(appSessions.map((s) => s.environmentId));
  const sections = new Map<
    string,
    {
      kind: 'session' | 'day';
      id: string;
      name: string;
      detail: string;
      at: number;
      folders: Map<string, FolderGroup<S>>;
    }
  >();
  const sectionOf = (conversation: Conversation) => {
    const id = historySectionId(conversation, timeline);
    let section = sections.get(id);
    if (section) return section;
    const session = timeline.find((entry) => entry.session.id === id);
    if (session) {
      const environment = fleet.environments.find((e) => e.id === session.session.environmentId);
      const computer = environment && computerName(computerViewId(environment));
      section = {
        kind: 'session',
        id,
        name: `${sessionLabel(session.at, now)}${computer && recorders.size > 1 ? ` · ${computer}` : ''}`,
        detail: `App session started ${new Date(session.at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}${computer ? ` on ${computer}` : ''}`,
        at: session.at,
        folders: new Map(),
      };
    } else {
      const used = lastUsed(conversation);
      const day = Number.isFinite(used) ? startOfDay(used) : -Infinity;
      section = {
        kind: 'day',
        id,
        name: Number.isFinite(day) ? dayLabel(day, now) : 'Earlier',
        detail: Number.isFinite(day)
          ? `Last used ${new Date(day).toLocaleDateString([], { dateStyle: 'full' })}, before app sessions were recorded`
          : 'Chats without a recorded time',
        at: day,
        folders: new Map(),
      };
    }
    sections.set(id, section);
    return section;
  };
  const archived = conversations.filter((c) => c.archived);
  for (const conversation of archived)
    if (!pins.has(conversation.id))
      folderIn(
        sectionOf(conversation).folders,
        conversationLocation(conversation, fleet, installation),
      ).conversations.push(conversation);
  return [
    {
      id: 'active',
      name: 'Active',
      count: active.length,
      pinned: pinnedIn(active),
      sections: [...computers.values()].map((c): ConversationSection<S> => ({
        kind: 'computer',
        id: c.id,
        name: c.name,
        folders: [...c.folders.values()],
      })),
    },
    {
      id: 'history',
      name: 'History',
      count: archived.length,
      pinned: pinnedIn(archived),
      sections: [...sections.values()]
        .sort((a, b) => b.at - a.at)
        .map(({ at, folders, ...section }): ConversationSection<S> => {
          const listed = [...folders.values()];
          return {
            ...section,
            computers: new Set(listed.map((f) => f.computerId)).size,
            folders: listed,
          };
        }),
    },
  ];
}
// The Active conversation listed below `id` in its folder, else the one above it there, to open
// when `id` leaves Active. A folder's pinned chats come first, in their order at the top of the
// tab. Without one, its folder gets a new chat rather than another folder's chat. Scratch chats
// are unsent drafts, not conversations, and are skipped.
export function nextActiveConversation(
  groups: ReturnType<typeof groupConversations>,
  id: string,
): Conversation | undefined {
  const active = groups.find((group) => group.id === 'active');
  if (!active) return;
  const folders = active.sections.flatMap((section) => section.folders);
  const folderId =
    active.pinned.find((pinned) => pinned.conversation.id === id)?.folderId ??
    folders.find((folder) => folder.conversations.some((c) => c.id === id))?.id;
  if (folderId === undefined) return;
  const listed = [
    ...active.pinned.filter((pinned) => pinned.folderId === folderId).map((p) => p.conversation),
    ...folders.filter((folder) => folder.id === folderId).flatMap((folder) => folder.conversations),
  ];
  const index = listed.findIndex((c) => c.id === id);
  return listed[index + 1] ?? listed[index - 1];
}
