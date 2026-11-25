/**
 * Ids the docs-only rows use, plus the two helpers that turn a `system:///`
 * document into the audit shape a real `read` call leaves behind. Shared by the
 * two run seeds so neither has to import the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ids the docs specs address; deterministic, and outside every shared-fixture range. */
export const DOCS_IDS = {
  /** The group Chat: store row 1_002, Telegram id -100555000111. */
  groupChat: 1_002n,
  groupChatHostId: -100_555_000_111n,
  /** Its Conversation (no newer run, so the failed run stays resumable). */
  groupConversation: 2_002n,
  groupContext: 11_500n,
  resumeBucket: 3_500n,
  resumeInvocation: 4_300n,
  /** The opening call that asked for the read, then the call that timed out. */
  resumeOpeningCall: 7_300n,
  resumeFailedCall: 7_301n,
  resumeToolCall: 8_300n,
  resumeMessage: 6_400n,
  resumeRevision: 6_410n,
  /** The completed run with a read, a send and a Telegram send row. */
  toolBucket: 3_501n,
  toolInvocation: 4_301n,
  toolModelCall: 7_302n,
  toolReadCall: 8_301n,
  toolSendCall: 8_302n,
  toolHostSend: 8_401n,
  /** The completed run's own messages: history and the batch it answered. */
  toolHistoryMessage: 6_402n,
  toolHistoryRevision: 6_412n,
  toolMessage: 6_403n,
  toolRevision: 6_413n,
} as const;

export const TOOL_REGISTRY = JSON.stringify([
  { name: 'send', label: 'Send message', description: 'Sends a message to Telegram.' },
  { name: 'read', label: 'Read document', description: 'Reads a system resource.' },
]);

/** The bundled document a `read` call actually loads, by its `system:///` URI. */
export function bundledDocument(uri: string): string {
  const relative = uri.replace(/^system:\/\/\//, '');
  return readFileSync(join(import.meta.dirname, '..', '..', '..', 'src', 'system-resources', relative), 'utf8');
}

export function snapshot(input: {
  readonly senderName: string;
  readonly text: string;
  readonly messageId: string;
  readonly date: string;
}): string {
  return JSON.stringify({
    sender: { username: null, name: input.senderName },
    kind: 'text',
    text: input.text,
    telegram_date: input.date,
    message_id: input.messageId,
  });
}
