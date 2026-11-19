/**
 * IMH-05(e): the catch-up queue drains whichever host the caller names, and
 * the host is only swept when its `intake` trait is `bucket` — a `release`
 * host like the Playground is never picked up by a catch-up pass, and a
 * Telegram pass must not touch another host's rows.
 */
import { afterAll, describe, expect, test } from 'vitest';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { STARTUP_CATCH_UP_STATE_KEY } from '../../src/orchestration/scheduler/index.ts';
import { SLEEP_STATE_KEY } from '../../src/store/sleep.ts';
import { seedPlaygroundConversation, seedTelegramConversation } from '../im/fixtures.ts';
import { cleanupSchedulerDirectories, setup } from './fixtures.ts';

afterAll(cleanupSchedulerDirectories);

/** One stored message row, like ingestion would have written for its host. */
function seedMessage(
  store: SqliteStore,
  input: {
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly hostKind: string;
    readonly messageNo: bigint;
    readonly text: string;
    readonly receivedAt: string;
  },
): bigint {
  const sender = store.db
    .prepare(
      `INSERT INTO senders(host_kind, host_sender_type, host_sender_id, display_name, is_bot, updated_at)
       VALUES (?, 'user', 42, 'Alice', 0, ?)`,
    )
    .run(input.hostKind, input.receivedAt);
  const message = store.db
    .prepare(
      `INSERT INTO messages(conversation_id, chat_id, host_kind, message_no, sent_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.conversationId, input.chatId, input.hostKind, input.messageNo, input.receivedAt, input.receivedAt);
  const revision = store.db
    .prepare(
      `INSERT INTO message_revisions(message_id, revision_no, sender_id, kind, text, created_at, raw_fragment_json)
       VALUES (?, 1, ?, 'text', ?, ?, '{}')`,
    )
    .run(message.lastInsertRowid, sender.lastInsertRowid, input.text, input.receivedAt);
  store.db
    .prepare('UPDATE messages SET current_revision_id = ? WHERE id = ?')
    .run(revision.lastInsertRowid, message.lastInsertRowid);
  return BigInt(message.lastInsertRowid);
}

describe('catch-up host scope', () => {
  test('a pass only sweeps the caller host, and only when its intake is bucket', async () => {
    const { store, scheduler } = await setup();
    try {
      seedTelegramConversation(store, {
        chatId: 7n,
        conversationId: 70n,
        telegramChatId: 123456789n,
        type: 'private',
      });
      seedPlaygroundConversation(store, { chatId: 8n, conversationId: 80n });
      const startedAt = new Date('2026-08-15T13:00:00.000Z');
      const telegramMessageId = seedMessage(store, {
        conversationId: 70n,
        chatId: 7n,
        hostKind: 'telegram',
        messageNo: 1n,
        text: 'while the bot was down',
        receivedAt: '2026-08-15T13:00:01.000Z',
      });
      const roomMessageId = seedMessage(store, {
        conversationId: 80n,
        chatId: 8n,
        hostKind: 'playground',
        messageNo: 1n,
        text: 'room input',
        receivedAt: '2026-08-15T13:00:02.000Z',
      });

      // The room host's intake is `release`: it has no backlog the queue may
      // sweep, even though its rows sit in the same tables.
      expect(scheduler.finishRuntimeCatchUp('playground', startedAt)).toEqual([]);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM buckets').get()).toEqual({ n: 0n });

      // The Telegram pass materializes only its own rows.
      const invocationIds = scheduler.finishRuntimeCatchUp('telegram', startedAt, new Date('2026-08-15T13:00:03.000Z'));
      expect(invocationIds).toHaveLength(1);
      expect(store.db.prepare('SELECT message_id FROM bucket_messages').all()).toEqual([
        { message_id: telegramMessageId },
      ]);
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM bucket_messages WHERE message_id = ?').get(roomMessageId),
      ).toEqual({ n: 0n });
    } finally {
      store.close();
    }
  });

  test('a release host cannot finish the startup drain, so its marker survives', async () => {
    const { store, scheduler } = await setup();
    try {
      seedTelegramConversation(store, {
        chatId: 7n,
        conversationId: 70n,
        telegramChatId: 123456789n,
        type: 'private',
      });
      const startedAt = new Date('2026-08-15T13:00:00.000Z');
      store.db
        .prepare('INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)')
        .run(STARTUP_CATCH_UP_STATE_KEY, startedAt.toISOString(), startedAt.toISOString());
      seedMessage(store, {
        conversationId: 70n,
        chatId: 7n,
        hostKind: 'telegram',
        messageNo: 1n,
        text: 'while the bot was down',
        receivedAt: '2026-08-15T13:00:01.000Z',
      });

      // The marker is Telegram's resume boundary: a pass over a host whose
      // intake is `release` must refuse, not delete it and call it a drain.
      expect(() => scheduler.finishStartupCatchUp('playground', startedAt)).toThrow();
      expect(store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(STARTUP_CATCH_UP_STATE_KEY)).toEqual({
        value: startedAt.toISOString(),
      });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM buckets').get()).toEqual({ n: 0n });
    } finally {
      store.close();
    }
  });

  test('a runtime pass over a release host never touches the shared sleep state', async () => {
    const { store, scheduler } = await setup();
    try {
      const startedAt = new Date('2026-08-15T13:00:00.000Z');
      // An already-expired sleep marker: reading it through the queue would
      // clear it and log the wake. Nothing about the Playground may do that.
      store.db
        .prepare('INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)')
        .run(SLEEP_STATE_KEY, '2026-08-15T12:00:00.000Z', '2026-08-15T12:00:00.000Z');

      expect(scheduler.finishRuntimeCatchUp('playground', startedAt)).toEqual([]);
      expect(store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(SLEEP_STATE_KEY)).toEqual({
        value: '2026-08-15T12:00:00.000Z',
      });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM buckets').get()).toEqual({ n: 0n });
    } finally {
      store.close();
    }
  });
});
