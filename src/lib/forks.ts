import { type Conversation } from './domain';

// A fork ends at a finished reply. Never copy the user input or partial output
// belonging to an in-flight turn, even when later malformed history exists.
export function forkPoint(conversation: Conversation, messageId?: string): number {
  let last = -1;
  for (const [index, message] of conversation.messages.entries()) {
    if (message.status === 'running') break;
    if (message.role === 'assistant') {
      if (messageId === message.id) return index;
      last = index;
    }
  }
  return messageId ? -1 : last;
}

export function forkConversation(source: Conversation, messageId?: string): Conversation {
  const end = forkPoint(source, messageId);
  if (end < 0) throw new Error('A finished reply is needed to fork this conversation.');
  const messages = structuredClone(source.messages.slice(0, end + 1));
  const ids = new Map<string, string>();
  for (const message of messages) {
    const id = crypto.randomUUID();
    ids.set(message.id, id);
    message.id = id;
    // The reply a reply took over is one of the messages copied before it.
    if (message.tookOver) {
      const earlier = ids.get(message.tookOver);
      if (earlier) message.tookOver = earlier;
      else delete message.tookOver;
    }
    // A fork sends nothing by itself, also once a usage limit that stopped its source resets.
    delete message.autoContinue;
    for (const receipt of message.elicitations ?? [])
      if (receipt.status === 'pending') {
        receipt.status = 'cancelled';
        receipt.revision += 1;
      }
    // Run IDs describe historical evidence, not a live execution binding. Keep
    // them with their recorded usage/steering, but never revive answer channels.
    for (const question of message.questions ?? []) {
      if (question.status === 'pending') {
        question.status = 'cancelled';
        question.revision = 3;
        delete question.response;
      }
    }
  }
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    forked: true,
    // A fork without a reply of its own has no native session: its source's sources hold it.
    forkedFrom: [source.id, ...(source.forkedFrom ?? [])],
    title: `${source.title} (fork)`,
    titleStatus: 'generated',
    settings: structuredClone(
      messageId ? (source.messages[end].settings ?? source.settings) : source.settings,
    ),
    ...(source.location ? { location: structuredClone(source.location) } : {}),
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages,
  };
}
