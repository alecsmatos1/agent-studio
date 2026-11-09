import { expect, it } from 'vitest';
import {
  applyRunEvent,
  retainRunEvent,
  visibleActivityStatus,
  type ToolActivity,
} from './activity';
import { activityGroupSummary } from './activity-groups';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Message,
  type RunEvent,
} from './domain';
import { emptyShared, mergeShared } from './sync';

const hook = (revision: number, status: ToolActivity['status']): ToolActivity => ({
  id: 'codex:hook:thread:fixture',
  category: 'hook',
  name: 'PreToolUse hook',
  revision,
  status,
  facts: [{ label: 'Handler', value: 'Command' }],
  sources: [],
  agents: [],
});

it('retains hook revisions and blocked outcomes through checkpoint, sync and export without prompt replay', () => {
  const workspace = initialWorkspace();
  const message: Message = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant',
    status: 'running',
    createdAt: '',
    blocks: [],
  };
  const base = emptyShared();
  base.conversations.push({
    id: crypto.randomUUID(),
    title: 'Hooks',
    createdAt: '',
    updatedAt: '',
    settings: settingsFor(workspace.preferences),
    messages: [message],
  });
  const left = structuredClone(base),
    right = structuredClone(base);
  applyRunEvent(left.conversations[0].messages[0], { kind: 'tool', tool: hook(1, 'running') });
  applyRunEvent(right.conversations[0].messages[0], { kind: 'tool', tool: hook(3, 'blocked') });
  for (const merged of [mergeShared(base, left, right), mergeShared(base, right, left)]) {
    workspace.conversations = merged.conversations;
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0];
    expect(restored.messages[0].blocks[0]).toMatchObject({
      type: 'activity',
      tool: hook(3, 'blocked'),
    });
    expect(JSON.stringify(historyFor(restored))).not.toContain('PreToolUse');
  }
  const checkpoint: RunEvent[] = [];
  for (const value of [hook(1, 'running'), hook(3, 'blocked'), hook(2, 'running')])
    retainRunEvent(checkpoint, { kind: 'tool', tool: value });
  expect(checkpoint).toHaveLength(1);
  expect(checkpoint[0].tool?.status).toBe('blocked');
  expect(activityGroupSummary([hook(3, 'blocked')], 'complete')).toMatchObject({
    label: '1 hook',
    parts: [{ text: '1 hook', failed: 'blocked' }],
    issue: 'blocked',
    unfinished: undefined,
  });
  expect(activityGroupSummary([hook(1, 'running')], 'running').label).toBe('Running 1 hook');
  expect(activityGroupSummary([hook(2, 'complete')], 'complete').label).toBe('Ran 1 hook');
  expect(visibleActivityStatus('running', 'complete')).toBe('unknown');
  expect(visibleActivityStatus('running', 'cancelled')).toBe('cancelled');
});
