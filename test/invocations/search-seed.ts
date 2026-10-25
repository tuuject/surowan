import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { seedCapInvocations } from './search-seed-caps.ts';
import { seedMatchingInvocations } from './search-seed-matching.ts';

/**
 * Seed corpus for the `invocation-search` suite: base chats/conversations and the
 * insert builders the per-invocation data modules share.
 */
export function createSeedContext(store: SqliteStore) {
  const run = (sql: string, ...params: Array<string | bigint | null>): void => {
    store.db.prepare(sql).run(...params);
  };

  run(
    "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (?, ?, ?, 'supergroup', 'Chat A', ?)",
    101n,
    -100111n,
    -100111n,
    '2025-01-01T00:00:00.000Z',
  );
  run(
    "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (?, ?, ?, 'supergroup', 'Chat B', ?)",
    102n,
    -100222n,
    -100222n,
    '2024-03-10T00:00:00.000Z',
  );
  for (const [id, chatId] of [
    [201n, 101n],
    [202n, 102n],
  ] as const) {
    run(
      'INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
      id,
      chatId,
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    );
  }
  run(
    "INSERT INTO senders(id, telegram_type, telegram_id, display_name, is_bot, updated_at) VALUES (501, 'user', 9001, '测试用户', 0, ?)",
    '2025-01-01T00:00:00.000Z',
  );

  for (const [id, conversationId] of [
    [301n, 201n],
    [302n, 201n],
    [303n, 202n],
  ] as const) {
    run(
      "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?)",
      id,
      conversationId,
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:01:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:02:00.000Z',
    );
  }

  for (const [id, bucketId, conversationId, createdAt] of [
    [401n, 301n, 201n, '2025-01-01T00:00:20.000Z'],
    [402n, 302n, 201n, '2025-01-01T01:10:00.000Z'],
    [403n, 303n, 202n, '2024-03-10T06:30:00.000Z'],
  ] as const) {
    run(
      "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (?, ?, ?, 'completed', 'test-hash', 1, ?, ?, ?)",
      id,
      bucketId,
      conversationId,
      createdAt,
      createdAt,
      createdAt,
    );
  }

  const insertMessage = (options: {
    readonly id: bigint;
    readonly chatId: bigint;
    readonly conversationId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly sentByBot: boolean;
    readonly kind: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): bigint => {
    const revisionId = options.id * 10n + 1n;
    run(
      'INSERT INTO messages(id, conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      options.id,
      options.conversationId,
      options.chatId,
      options.telegramMessageId,
      options.sentByBot ? 1n : 0n,
      options.telegramDate,
      options.telegramDate,
    );
    run(
      'INSERT INTO message_revisions(id, message_id, revision_no, sender_id, kind, text, caption, created_at, raw_fragment_json) VALUES (?, ?, 1, 501, ?, ?, ?, ?, ?)',
      revisionId,
      options.id,
      options.kind,
      options.text,
      options.caption,
      options.telegramDate,
      JSON.stringify({ message_id: options.telegramMessageId.toString() }),
    );
    run('UPDATE messages SET current_revision_id = ? WHERE id = ?', revisionId, options.id);
    return revisionId;
  };

  const snapshotJson = (input: {
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): string =>
    JSON.stringify({
      message_id: input.telegramMessageId.toString(),
      message_thread_id: '0',
      telegram_date: input.telegramDate,
      sent_by_bot: false,
      revision: '1',
      sender: { id: '9001', name: '测试用户', username: null },
      kind: input.text === null ? 'photo' : 'text',
      text: input.text,
      caption: input.caption,
      reply_to_message_id: null,
      reply_snapshot: null,
      forward_origin: null,
      media_group_id: null,
      media: [],
    });

  const insertSnapshot = (input: {
    readonly invocationId: bigint;
    readonly sequenceNo: bigint;
    readonly section: string;
    readonly messageId: bigint;
    readonly revisionId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string | null;
    readonly caption: string | null;
  }): void => {
    run(
      'INSERT INTO invocation_messages(invocation_id, message_id, revision_id, section, sequence_no, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)',
      input.invocationId,
      input.messageId,
      input.revisionId,
      input.section,
      input.sequenceNo,
      snapshotJson(input),
    );
  };

  const insertBotSend = (input: {
    readonly chatId: bigint;
    readonly conversationId: bigint;
    readonly invocationId: bigint;
    readonly toolCallId: bigint;
    readonly sendId: bigint;
    readonly messageId: bigint;
    readonly telegramMessageId: bigint;
    readonly telegramDate: string;
    readonly text: string;
  }): void => {
    insertMessage({
      id: input.messageId,
      chatId: input.chatId,
      conversationId: input.conversationId,
      telegramMessageId: input.telegramMessageId,
      telegramDate: input.telegramDate,
      sentByBot: true,
      kind: 'text',
      text: input.text,
      caption: null,
    });
    run(
      "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, ?, ?, 'send', ?, ?, 'success', 1, ?, ?)",
      input.toolCallId,
      input.invocationId,
      `call-send-${input.toolCallId}`,
      JSON.stringify({ kind: 'text', text: input.text }),
      `telegram_message_id=${input.telegramMessageId}`,
      input.telegramDate,
      input.telegramDate,
    );
    run(
      'INSERT INTO host_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (?, ?, ?, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', ?, ?, ?, ?)',
      input.sendId,
      input.toolCallId,
      input.conversationId,
      input.telegramMessageId,
      JSON.stringify({ message_id: input.telegramMessageId.toString() }),
      input.telegramDate,
      input.telegramDate,
    );
  };

  return { run, insertMessage, insertSnapshot, insertBotSend };
}

export type SeedContext = ReturnType<typeof createSeedContext>;

export function seed(store: SqliteStore): void {
  const context = createSeedContext(store);
  seedMatchingInvocations(context);
  seedCapInvocations(context);
}
