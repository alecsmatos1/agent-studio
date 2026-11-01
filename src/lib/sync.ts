import {
  workspaceSchema,
  messageText,
  interruptedReplyError,
  copiedReplyError,
  type Conversation,
  type Message,
  type Workspace,
} from './domain.ts';
import { z } from 'zod';
import { emptyFleet } from './fleet.ts';
import { mergeActivityBlocks } from './activity.ts';
import { mergeVisualizations } from './visualizations.ts';
import { mergeArtifactRecords } from './artifact-records.ts';
import { mergeMessageFiles } from './sent-files.ts';
import { mergeScreenCards } from './screens.ts';
import { mergeQuestions } from './questions.ts';
import { mergeElicitations } from './elicitations.ts';
import { mergeSteering, mergeSteeringPlaces } from './steering.ts';
import { mergeCompactions } from './compaction.ts';
import { mergeProposedPlans } from './proposed-plans.ts';
import { latestFileChanges } from './file-changes.ts';
import { latestAccountUsage, latestTokenUsage } from './spend.ts';
import { latestUsageLimit, mergeAutoContinue } from './usage-limits.ts';
import { mergeClaudeInstructions } from './claude-instructions.ts';
import { mergeAppSessions } from './app-sessions.ts';
import { mergeFolderIcons, sameFolderIcons } from './folder-icons.ts';
import { mergeAccountColors, sameAccountColors } from './account-colors.ts';
import { mergeSnoozes, sameSnoozes } from './snoozes.ts';
import { mergePins, samePins } from './pins.ts';
import { jsonEqual } from './json-equal.ts';

export type SharedWorkspace = Pick<
  Workspace,
  | 'fleet'
  | 'conversations'
  | 'workflows'
  | 'inputTemplates'
  | 'claudeInstructions'
  | 'appSessions'
  | 'folderIcons'
  | 'accountColors'
  | 'snoozes'
  | 'pins'
>;
export const sharedSchema = workspaceSchema.pick({
  fleet: true,
  conversations: true,
  workflows: true,
  inputTemplates: true,
  claudeInstructions: true,
  appSessions: true,
  folderIcons: true,
  accountColors: true,
  snoozes: true,
  pins: true,
});
/** One conversation as replicated, so a sync can validate and compare it by itself. */
export const sharedChatSchema = sharedSchema.shape.conversations.element;
/** The replicated fields other than the conversations, which move together. */
export const sharedMetaSchema = sharedSchema.omit({ conversations: true });
export type SharedMeta = z.infer<typeof sharedMetaSchema>;
export const sharedMeta = (workspace: Workspace | SharedWorkspace): SharedMeta =>
  sharedMetaSchema.parse(workspace);
export const metaOf = (workspace: SharedWorkspace): SharedMeta => {
  const { conversations, ...meta } = workspace;
  return meta;
};
export type MergeOptions = {
  /**
   * Reports whether this device is the execution host of the run that produced `message`
   * and no longer executes it. Only then may a locally recorded restart interruption outrank
   * a running checkpoint from the relay; any other device's restart keeps following the run.
   */
  deadRun?: (conversation: Conversation, message: Message) => boolean;
  /**
   * Whether this device's copy of the conversation holds only what it received, every change it
   * made, its creation included, having reached the relay. Its copy then never counts as edited,
   * whatever the baseline holds: the relay's stands, with any later step of a reply this copy
   * holds, and a conversation the relay no longer has goes. Only the Viewer knows this
   * (src/lib/change-marks.ts).
   */
  received?: (id: string) => boolean;
};
export const emptyShared = (): SharedWorkspace => ({ fleet: emptyFleet(), conversations: [] });
/**
 * Gives an object another copy's fields while keeping the object itself, since views and running
 * replies hold on to live conversations. A field the copy no longer has is removed: `Object.assign`
 * alone kept a removed Undo rewind, which the device then published back to every other one.
 */
export function replaceFields<T extends object>(target: T, source: T): T {
  for (const key of Object.keys(target))
    if (!(key in source)) delete (target as Record<string, unknown>)[key];
  return Object.assign(target, source);
}
// As comparing their JSON texts tells, without writing them: copies of a conversation share what
// did not change, and a merge compared megabytes of text several times a poll.
const equal = jsonEqual;
const byId = <T extends { id: string }>(items: T[] = []) =>
  [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
const same = <T extends { id: string }>(x?: T[], y?: T[]) => equal(byId(x), byId(y));
/**
 * Whether two shared workspaces hold the same data. Lists compare by item id: this device
 * adds new chats at the front, while a merge keeps its base order and appends them. App sessions,
 * folder icons, account colors, snoozes and pins compare only when `a`, the relay's copy, holds
 * them: an older relay drops them, and this device keeps its own.
 */
export function sameShared(a: SharedWorkspace, b: SharedWorkspace): boolean {
  return (
    same(a.conversations, b.conversations) &&
    same(a.fleet.computers, b.fleet.computers) &&
    same(a.fleet.environments, b.fleet.environments) &&
    same(a.fleet.accounts, b.fleet.accounts) &&
    same(a.fleet.connections, b.fleet.connections) &&
    same(a.workflows, b.workflows) &&
    same(a.inputTemplates, b.inputTemplates) &&
    a.claudeInstructions === b.claudeInstructions &&
    (!a.appSessions || same(a.appSessions, b.appSessions)) &&
    (!a.folderIcons || sameFolderIcons(a.folderIcons, b.folderIcons)) &&
    (!a.accountColors || sameAccountColors(a.accountColors, b.accountColors)) &&
    (!a.snoozes || sameSnoozes(a.snoozes, b.snoozes)) &&
    (!a.pins || samePins(a.pins, b.pins))
  );
}
/**
 * Whether two copies of the replicated settings hold the same data, lists compared by item id.
 * A merge keeps its own base's order, so a device that met the computers and accounts in
 * another order, such as a server host that added itself first, keeps another order for good:
 * compared in order, the desktop and the VPS host sent the fleet back and forth on every poll,
 * each saving the whole workspace each time (requested 2026-10-11).
 */
export function sameMeta(a: SharedMeta, b: SharedMeta): boolean {
  return (
    same(a.fleet.computers, b.fleet.computers) &&
    same(a.fleet.environments, b.fleet.environments) &&
    same(a.fleet.accounts, b.fleet.accounts) &&
    same(a.fleet.connections, b.fleet.connections) &&
    same(a.workflows, b.workflows) &&
    same(a.inputTemplates, b.inputTemplates) &&
    a.claudeInstructions === b.claudeInstructions &&
    same(a.appSessions, b.appSessions) &&
    sameFolderIcons(a.folderIcons, b.folderIcons) &&
    sameAccountColors(a.accountColors, b.accountColors) &&
    sameSnoozes(a.snoozes, b.snoozes) &&
    samePins(a.pins, b.pins)
  );
}

// Questions are revisioned run history, not deletable conversation settings.
// Older relays/clients can omit them even from a successful save response.
function retainQuestions(selected: Conversation, other?: Conversation): Conversation {
  if (
    !other ||
    selected.settings.provider !== other.settings.provider ||
    selected.settings.connectionId !== other.settings.connectionId ||
    !equal(selected.location, other.location)
  )
    return selected;
  // The other copy's messages by id, the first of each, so a long conversation is passed over once.
  const others = new Map<string, Message>();
  for (const message of other.messages)
    if (!others.has(message.id)) others.set(message.id, message);
  const messages = selected.messages.map((message) => {
    const previous = others.get(message.id);
    // A message both copies share has nothing to retain. Copies of a conversation share every
    // message that did not change, so only a reply that moved is merged here.
    if (message === previous) return message;
    if (
      message.role !== 'assistant' ||
      previous?.role !== 'assistant' ||
      !message.runId ||
      message.runId !== previous.runId ||
      !equal(message.settings, previous.settings) ||
      (!previous.blocks.some((b) => b.type === 'reasoning') &&
        !previous.questions?.length &&
        !previous.elicitations?.length &&
        !previous.steering?.length &&
        !previous.compactions?.length &&
        !previous.proposedPlans?.length &&
        !previous.fileChanges &&
        !previous.filesUndone &&
        !previous.accountUsage &&
        !previous.usageLimit &&
        !previous.autoContinue &&
        !previous.tookOver &&
        previous.usage?.revision == null)
    )
      return message;
    const merged = {
      ...message,
      ...(message.tookOver || previous.tookOver
        ? { tookOver: message.tookOver ?? previous.tookOver }
        : {}),
      ...(message.proposedPlans || previous.proposedPlans
        ? { proposedPlans: mergeProposedPlans(message.proposedPlans, previous.proposedPlans) }
        : {}),
      ...(message.compactions || previous.compactions
        ? { compactions: mergeCompactions(message.compactions, previous.compactions) }
        : {}),
      ...(message.filesUndone || previous.filesUndone ? { filesUndone: true } : {}),
      blocks: mergeActivityBlocks(
        message.blocks,
        previous.blocks.filter((b) => b.type === 'reasoning'),
      ),
      ...(message.usage || previous.usage
        ? { usage: latestTokenUsage(message.usage, previous.usage) }
        : {}),
      ...(message.accountUsage || previous.accountUsage
        ? { accountUsage: latestAccountUsage(message.accountUsage, previous.accountUsage) }
        : {}),
      ...(message.questions || previous.questions
        ? { questions: mergeQuestions(message.questions, previous.questions) }
        : {}),
      ...(message.elicitations || previous.elicitations
        ? { elicitations: mergeElicitations(message.elicitations, previous.elicitations) }
        : {}),
      ...(message.steering || previous.steering
        ? { steering: mergeSteering(message.steering, previous.steering) }
        : {}),
      ...(message.steeringPlaces || previous.steeringPlaces
        ? {
            steeringPlaces: mergeSteeringPlaces(message.steeringPlaces, previous.steeringPlaces),
          }
        : {}),
      ...(message.fileChanges || previous.fileChanges
        ? { fileChanges: latestFileChanges(message.fileChanges, previous.fileChanges) }
        : {}),
      ...(message.usageLimit || previous.usageLimit
        ? { usageLimit: latestUsageLimit(message.usageLimit, previous.usageLimit) }
        : {}),
      ...(message.autoContinue || previous.autoContinue
        ? { autoContinue: mergeAutoContinue(message.autoContinue, previous.autoContinue) }
        : {}),
    };
    // A message that gained nothing stays the object it is, so the copies made after this one
    // go on sharing it: its bytes are written already, and comparing it costs nothing.
    return equal(merged, message) ? message : merged;
  });
  // With nothing retained, the selected copy stays the object it is.
  return messages.every((message, index) => message === selected.messages[index])
    ? selected
    : { ...selected, messages };
}

const rank = { running: 0, cancelled: 1, error: 2, complete: 3 };
// A restarted device only saw its own copy stop; any other copy of the run knows better.
const interrupted = (message: Message) => message.error === interruptedReplyError;
const score = (message: Message) => (interrupted(message) ? -1 : rank[message.status]);
/**
 * The later of two copies of one reply, `left` this device's and `right` the relay's. Only the
 * computer running a reply writes it, so its copies differ in time, never in content. Its answer
 * is not one growing text: the text written before a call becomes a progress comment and the
 * answer starts again. So the status decides first, then the blocks and the usage revision the
 * reply recorded, then an answer a new turn emptied (a reply that waited for background work goes
 * on in another turn, which starts its answer again before it records anything), then an answer
 * extending the other; otherwise the relay's copy, which the running computer publishes, is the
 * later one. Requiring one answer to extend the other made a conflict copy of a chat whenever a
 * phone held its reply from an earlier step.
 */
function laterReply(left: Message, right: Message): Message {
  for (const difference of [
    score(left) - score(right),
    left.blocks.length - right.blocks.length,
    (left.usage?.revision ?? -1) - (right.usage?.revision ?? -1),
  ])
    if (difference) return difference > 0 ? left : right;
  const emptied = (message: Message) =>
    !messageText(message) && message.blocks.some((block) => block.type === 'markdown');
  if (emptied(left) !== emptied(right)) return emptied(left) ? left : right;
  return messageText(left).startsWith(messageText(right)) ? left : right;
}

/**
 * Whether `copy` holds nothing `other` lacks: its messages begin `other`'s, each the same or an
 * earlier step of the same reply.
 */
function earlierCopy(copy: Conversation, other: Conversation): boolean {
  return (
    copy.messages.length <= other.messages.length &&
    copy.messages.every((message, index) => {
      const later = other.messages[index];
      if (message.id !== later.id) return false;
      return (
        equal(message, later) ||
        (message.role === 'assistant' &&
          later.role === 'assistant' &&
          !!message.runId &&
          message.runId === later.runId &&
          equal(message.settings, later.settings) &&
          laterReply(later, message) === later)
      );
    })
  );
}

function sameRun(
  left: Conversation,
  right: Conversation,
  base?: Conversation,
  options?: MergeOptions,
): Conversation | undefined {
  let settings = left.settings;
  let archived = left.archived;
  if (
    (left.historyRevision ?? 0) !== (right.historyRevision ?? 0) ||
    !equal(left.rewind, right.rewind) ||
    left.settings.provider !== right.settings.provider ||
    !equal(left.location, right.location)
  )
    return;
  const archiveDiffers = !!left.archived !== !!right.archived;
  const settingsDiffer = !equal(left.settings, right.settings);
  // The base tells which side made a one-sided change. A device can hold a chat its baseline
  // lacks, as when a phone closed the Viewer after saving what a sync took in but before saving
  // the baseline that came with it (2026-10-15). A copy that holds nothing the other lacks is then
  // the earlier one, and the other's archive and settings are changes made since, such as a move
  // to History on another device, which made a conflict copy of the chat.
  const before =
    base ??
    (!archiveDiffers && !settingsDiffer
      ? undefined
      : earlierCopy(left, right)
        ? left
        : earlierCopy(right, left)
          ? right
          : undefined);
  if (archiveDiffers) {
    // Opening an app session can archive a chat while its owning host publishes a reply.
    // Keep the one-sided archive/restore change together with that response checkpoint.
    if (before && !!left.archived === !!before.archived) archived = right.archived;
    else if (!before || !!right.archived !== !!before.archived) return;
  }
  if (settingsDiffer) {
    // A response checkpoint and a one-sided edit for the next request, such as the account
    // switched to after a usage limit, are independent. Conflicting settings edits still
    // produce the existing conflict copy.
    if (before && equal(left.settings, before.settings)) settings = right.settings;
    else if (!before || !equal(right.settings, before.settings)) return;
  }
  const messages = [];
  let sharedRun = false;
  for (let i = 0; i < Math.max(left.messages.length, right.messages.length); i++) {
    const a = left.messages[i],
      b = right.messages[i];
    if (!a || !b) {
      messages.push(a ?? b);
      continue;
    }
    if (a.id !== b.id) return;
    if (a.runId && a.runId === b.runId) sharedRun = true;
    if (equal(a, b)) {
      messages.push(a);
      continue;
    }
    if (!a.runId || a.runId !== b.runId) return;
    if (!equal(a.settings, b.settings)) return;
    const chosen = laterReply(a, b);
    const other = chosen === a ? b : a;
    // Unless the execution host itself restarted without this run: keep the newest checkpoint
    // content, but nothing will finish it, so its interruption outranks the stale running copy.
    const selected =
      chosen.status === 'running' && interrupted(a) && options?.deadRun?.(left, a)
        ? { ...chosen, status: 'cancelled' as const, error: interruptedReplyError }
        : chosen;
    messages.push({
      ...selected,
      ...(a.tookOver || b.tookOver ? { tookOver: a.tookOver ?? b.tookOver } : {}),
      ...(a.filesUndone || b.filesUndone ? { filesUndone: true } : {}),
      ...(a.proposedPlans || b.proposedPlans
        ? { proposedPlans: mergeProposedPlans(a.proposedPlans, b.proposedPlans) }
        : {}),
      ...(a.compactions || b.compactions
        ? { compactions: mergeCompactions(a.compactions, b.compactions) }
        : {}),
      ...(a.usage || b.usage ? { usage: latestTokenUsage(selected.usage, other.usage) } : {}),
      ...(a.accountUsage || b.accountUsage
        ? { accountUsage: latestAccountUsage(a.accountUsage, b.accountUsage) }
        : {}),
      blocks: mergeActivityBlocks(selected.blocks, other.blocks),
      ...(a.fileChanges || b.fileChanges
        ? { fileChanges: latestFileChanges(a.fileChanges, b.fileChanges) }
        : {}),
      ...(a.usageLimit || b.usageLimit
        ? { usageLimit: latestUsageLimit(a.usageLimit, b.usageLimit) }
        : {}),
      ...(a.autoContinue || b.autoContinue
        ? { autoContinue: mergeAutoContinue(a.autoContinue, b.autoContinue) }
        : {}),
      ...(a.questions || b.questions
        ? { questions: mergeQuestions(a.questions, b.questions) }
        : {}),
      ...(a.elicitations || b.elicitations
        ? { elicitations: mergeElicitations(a.elicitations, b.elicitations) }
        : {}),
      ...(a.steering || b.steering ? { steering: mergeSteering(a.steering, b.steering) } : {}),
      ...(a.steeringPlaces || b.steeringPlaces
        ? { steeringPlaces: mergeSteeringPlaces(a.steeringPlaces, b.steeringPlaces) }
        : {}),
      plan: (a.plan?.revision ?? -1) >= (b.plan?.revision ?? -1) ? a.plan : b.plan,
      ...(a.visualizations || b.visualizations
        ? { visualizations: mergeVisualizations(a.visualizations, b.visualizations) }
        : {}),
      ...(a.artifacts || b.artifacts
        ? { artifacts: mergeArtifactRecords(a.artifacts, b.artifacts) }
        : {}),
      ...(a.sentFiles ||
      b.sentFiles ||
      a.extraSentFiles ||
      b.extraSentFiles ||
      a.laterSentFiles ||
      b.laterSentFiles
        ? mergeMessageFiles(a, b)
        : {}),
      ...(a.screens || b.screens ? { screens: mergeScreenCards(a.screens, b.screens) } : {}),
      workflow:
        (a.workflow?.revision ?? -1) >= (b.workflow?.revision ?? -1) ? a.workflow : b.workflow,
      nativeWorkflows:
        (a.nativeWorkflows?.revision ?? -1) >= (b.nativeWorkflows?.revision ?? -1)
          ? a.nativeWorkflows
          : b.nativeWorkflows,
      ...(a.durationMs != null || b.durationMs != null
        ? { durationMs: Math.max(a.durationMs ?? 0, b.durationMs ?? 0) }
        : {}),
    });
  }
  if (!sharedRun) return;
  const title =
    left.titleStatus === 'generated' ? left : right.titleStatus === 'generated' ? right : left;
  return {
    ...left,
    archived,
    settings,
    title: title.title,
    titleStatus: title.titleStatus,
    titleSource: title.titleSource,
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
    messages,
  };
}
export function sharedWorkspace(workspace: Workspace): SharedWorkspace {
  return sharedSchema.parse(workspace);
}

/**
 * Whether `after` is `before` with only its replies further along: the same messages in the same
 * order, the user's unchanged, and the chat itself the same apart from when it was updated. A
 * merge reconciles such copies by itself. Any other change (a message added or removed, a rewind,
 * an archive, settings, a title, a new chat) has to reach the sync checkpoint at once, because
 * after a reload a saved copy the checkpoint lags behind looks edited on that device.
 */
export function onlyRepliesMoved(before: Conversation | undefined, after: Conversation): boolean {
  if (!before || before.messages.length !== after.messages.length) return false;
  for (let i = 0; i < before.messages.length; i++) {
    const a = before.messages[i],
      b = after.messages[i];
    if (a.id !== b.id || a.role !== b.role || (a.role !== 'assistant' && !equal(a, b)))
      return false;
  }
  return equal(
    { ...after, updatedAt: before.updatedAt, messages: [] },
    { ...before, messages: [] },
  );
}

/**
 * The relay's copy of a conversation this device only received, with the later step of any reply
 * this device's copy holds: a device following a reply it started hears its steps from the
 * reply's request before the relay has them.
 */
function receivedChat(
  local: Conversation,
  relay: Conversation,
  options?: MergeOptions,
): Conversation {
  const merged = sameRun(local, relay, local, options);
  return merged ? { ...relay, messages: merged.messages } : retainQuestions(relay, local);
}

/**
 * A conversation kept beside its original as a copy, under an id of its own. A reply it holds as
 * running goes on in the original, which keeps the id its computer reports to, so the copy's ends
 * here: left running, it waited for an end that never came, and its chat could neither be steered
 * nor sent another message (2026-10-15).
 */
function conflictCopy(conversation: Conversation): Conversation {
  return {
    ...conversation,
    id: crypto.randomUUID(),
    title: `${conversation.title} (conflict copy)`,
    titleStatus: 'fallback',
    messages: conversation.messages.map((message) => {
      if (message.status !== 'running' && !message.autoContinue) return message;
      const copy: Message = { ...message };
      // The original goes on by itself after a usage limit, so the copy does not.
      delete copy.autoContinue;
      if (message.status !== 'running') return copy;
      copy.status = 'cancelled';
      copy.error = copiedReplyError;
      delete copy.backgroundWait;
      return copy;
    }),
  };
}

// A stopped host can publish its last checkpoint after another device deletes
// the chat. Only background reply/title updates yield to that deletion; retain
// conflict copies for new messages or deliberate settings/location/title edits.
function backgroundUpdate(before: Conversation, updated: Conversation): boolean {
  const metadata = { ...updated, updatedAt: before.updatedAt, messages: before.messages };
  if (
    before.titleStatus === 'pending' &&
    ((updated.titleStatus === 'generated' && updated.titleSource) ||
      (updated.titleStatus === 'fallback' && updated.title === before.title))
  ) {
    metadata.title = before.title;
    metadata.titleStatus = before.titleStatus;
    metadata.titleSource = before.titleSource;
  }
  if (!equal(metadata, before) || before.messages.length !== updated.messages.length) return false;
  if (equal(before.messages, updated.messages)) return true;
  return (
    !!sameRun(before, updated, before) &&
    before.messages.every(
      (message, index) =>
        equal(message, updated.messages[index]) ||
        (message.status === 'running' &&
          !!message.runId &&
          message.id === updated.messages[index].id),
    )
  );
}

// Preferences and credentials are not replicated. Retain divergent chat edits as a copy;
// stop on metadata conflicts instead of silently changing execution routing.
export function mergeShared(
  base: SharedWorkspace,
  local: SharedWorkspace,
  remote: SharedWorkspace,
  options?: MergeOptions,
): SharedWorkspace {
  const merge = <T extends { id: string }>(
    old: T[],
    ours: T[],
    theirs: T[],
    chats: boolean | 'named' = false,
  ): T[] => {
    const b = new Map(old.map((v) => [v.id, v])),
      l = new Map(ours.map((v) => [v.id, v])),
      r = new Map(theirs.map((v) => [v.id, v]));
    const result: T[] = [];
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const before = b.get(id),
        left = l.get(id),
        right = r.get(id);
      // A conversation this device only received follows the relay, whatever the baseline holds,
      // and goes once the relay no longer has it.
      if (chats === true && left && !equal(left, right) && options?.received?.(id)) {
        if (right)
          result.push(
            receivedChat(
              left as unknown as Conversation,
              right as unknown as Conversation,
              options,
            ) as unknown as T,
          );
        continue;
      }
      if (equal(left, right) || equal(before, right)) {
        if (left)
          result.push(
            chats === true
              ? (retainQuestions(
                  left as unknown as Conversation,
                  right as unknown as Conversation,
                ) as unknown as T)
              : left,
          );
      } else if (equal(before, left)) {
        if (right)
          result.push(
            chats === true
              ? (retainQuestions(
                  right as unknown as Conversation,
                  left as unknown as Conversation,
                ) as unknown as T)
              : right,
          );
      } else if (chats) {
        if (chats === 'named') {
          if (right) result.push(right);
          if (left)
            result.push({
              ...left,
              id: crypto.randomUUID(),
              name: `${(left as T & { name: string }).name} (conflict copy)`,
            });
          continue;
        }
        if (
          before &&
          (!left || !right) &&
          backgroundUpdate(
            before as unknown as Conversation,
            (left ?? right) as unknown as Conversation,
          )
        )
          continue;
        if (left && right) {
          const a = left as unknown as Conversation,
            b = right as unknown as Conversation;
          if ((a.historyRevision ?? 0) !== (b.historyRevision ?? 0)) {
            // Rewind and file Undo replace the history: an older copy yields unless it holds
            // deliberate edits. Its one-sided archive change still applies, as for replies.
            const newer = (a.historyRevision ?? 0) > (b.historyRevision ?? 0) ? a : b;
            const older = newer === a ? b : a;
            const original = before as unknown as Conversation | undefined;
            const archivedOlder =
              !!original &&
              !!older.archived !== !!original.archived &&
              !!newer.archived === !!original.archived;
            result.push(
              (archivedOlder ? { ...newer, archived: older.archived } : newer) as unknown as T,
            );
            if (!original || !backgroundUpdate(original, { ...older, archived: original.archived }))
              result.push(conflictCopy(older) as unknown as T);
            continue;
          }
          const response = sameRun(
            left as unknown as Conversation,
            right as unknown as Conversation,
            before as unknown as Conversation | undefined,
            options,
          );
          if (response) {
            result.push(response as unknown as T);
            continue;
          }
        }
        if (right) result.push(right);
        if (left) result.push(conflictCopy(left as unknown as Conversation) as unknown as T);
      } else
        throw new Error(
          'Computer or account settings changed on both devices. Export this workspace before resolving the conflicting settings.',
        );
    }
    return result;
  };
  const accounts = merge(base.fleet.accounts, local.fleet.accounts, remote.fleet.accounts);
  const connections = merge(
    base.fleet.connections,
    local.fleet.connections,
    remote.fleet.connections,
  );
  return {
    fleet: {
      computers: merge(base.fleet.computers, local.fleet.computers, remote.fleet.computers),
      environments: merge(
        base.fleet.environments,
        local.fleet.environments,
        remote.fleet.environments,
      ),
      accounts,
      connections,
    },
    conversations: merge(base.conversations, local.conversations, remote.conversations, true),
    ...(local.workflows || remote.workflows || base.workflows
      ? {
          workflows: merge(
            base.workflows ?? [],
            local.workflows ?? [],
            remote.workflows ?? [],
            'named',
          ),
        }
      : {}),
    ...(local.inputTemplates || remote.inputTemplates || base.inputTemplates
      ? {
          inputTemplates: merge(
            base.inputTemplates ?? [],
            local.inputTemplates ?? [],
            remote.inputTemplates ?? [],
            'named',
          ),
        }
      : {}),
    ...claudeInstructionsField(
      mergeClaudeInstructions(
        base.claudeInstructions,
        local.claudeInstructions,
        remote.claudeInstructions,
      ),
    ),
    ...appSessionsField(mergeAppSessions(base.appSessions, local.appSessions, remote.appSessions)),
    ...folderIconsField(mergeFolderIcons(base.folderIcons, local.folderIcons, remote.folderIcons)),
    ...accountColorsField(
      mergeAccountColors(base.accountColors, local.accountColors, remote.accountColors, {
        accounts,
        connections,
      }),
    ),
    ...snoozesField(mergeSnoozes(base.snoozes, local.snoozes, remote.snoozes)),
    ...pinsField(mergePins(base.pins, local.pins, remote.pins)),
  };
}
// An absent value follows the default text, so it stays absent rather than undefined.
const claudeInstructionsField = (value: string | undefined) =>
  value === undefined ? {} : { claudeInstructions: value };
const appSessionsField = (value: SharedWorkspace['appSessions']) =>
  value === undefined ? {} : { appSessions: value };
const folderIconsField = (value: SharedWorkspace['folderIcons']) =>
  value === undefined ? {} : { folderIcons: value };
const accountColorsField = (value: SharedWorkspace['accountColors']) =>
  value === undefined ? {} : { accountColors: value };
const snoozesField = (value: SharedWorkspace['snoozes']) =>
  value === undefined ? {} : { snoozes: value };
const pinsField = (value: SharedWorkspace['pins']) => (value === undefined ? {} : { pins: value });
export type Presence = {
  accountUpdates?: import('./live-usage').AccountUpdate[];
  /**
   * What this computer's app takes from other devices beyond chats: `signIn` (its accounts sign
   * in from elsewhere) and `server` (a server no one sits at). Older apps and relays report none.
   */
  features?: string[];
  environmentId: string;
  seenAt: number;
  online: boolean;
  connections: {
    connectionId: string;
    installed: boolean;
    auth: string;
    detail: string;
    version: string | null;
  }[];
  running: string[];
};
export type RelayJob = {
  id: string;
  source: string;
  target: string;
  method:
    | 'run'
    | 'usage'
    | 'account'
    | 'models'
    | 'title'
    | 'folderIcon'
    | 'folders'
    | 'context'
    | 'mentions'
    | 'nativeInstructions'
    | 'toolOutput'
    | 'toolOutputImage'
    | 'toolOutputModel'
    | 'toolOutputModelViews'
    | 'toolOutputTable'
    | 'toolOutputDocument'
    | 'toolOutputFile'
    | 'mcp'
    | 'plugins'
    | 'undoFiles'
    | 'answer'
    | 'elicitation'
    | 'steer'
    | 'release'
    | 'screens'
    | 'signIn'
    | 'signInCode';
  args: Record<string, unknown>;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  events: unknown[];
  result?: unknown;
  error?: string;
  cancel: boolean;
};
