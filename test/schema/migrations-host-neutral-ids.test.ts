import { afterAll, expect, test } from 'vitest';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { chats, messages, senders } from '../../src/store/schema/index.ts';
import { testConfigStore, writeTestConfig } from '../helpers.ts';
import { buildDatabaseBelow, cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

/**
 * Seeds a database that is still on the post-063 schema: Telegram messages
 * with several revisions, a Playground room with numbered messages, a
 * `/cut_topic` cutoff, an attention window, host sends in two outcome states
 * and a group-memory event that references a message-id range.
 */
const SEED_063 = `
INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, title, username, updated_at)
  VALUES (1, 'telegram', -100123, -100123, 'supergroup', 'Group', 'grp', '2026-01-01T00:00:00.000Z'),
         (2, 'telegram', 123456789, 123456789, 'private', NULL, NULL, '2026-01-01T00:00:00.000Z'),
         (3, 'playground', NULL, NULL, 'group', 'Room', NULL, '2026-01-01T00:00:00.000Z');
INSERT INTO senders (id, host_kind, telegram_type, telegram_id, display_name, username, is_bot, updated_at)
  VALUES (10, 'telegram', 'user', 777, 'Alice', 'alice', 0, '2026-01-01T00:00:00.000Z'),
         (11, 'telegram', 'user', 778, 'Bot', 'bot', 1, '2026-01-01T00:00:00.000Z'),
         (12, 'telegram', 'sender_chat', -100999, 'Channel', 'chan', 0, '2026-01-01T00:00:00.000Z'),
         (13, 'playground', NULL, NULL, 'Echo', NULL, 0, '2026-01-01T00:00:00.000Z');
INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
  VALUES (100, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (101, 2, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (102, 3, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO rooms (chat_id, revision, next_seq, hold, created_at, updated_at)
  VALUES (3, 2, 4, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO room_participants (chat_id, sender_id, role, joined_at)
  VALUES (3, 13, 'member', '2026-01-01T00:00:00.000Z');
INSERT INTO messages (id, conversation_id, chat_id, host_kind, telegram_message_id, visible, sent_by_bot, telegram_date, received_at, local_reply_to_message_id, local_sequence_no)
  VALUES (1000, 100, 1, 'telegram', 5000, 1, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', NULL, NULL),
         (1001, 100, 1, 'telegram', 5001, 0, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', NULL, NULL),
         (1002, 101, 2, 'telegram', 6000, 1, 1, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z', NULL, NULL),
         (1003, 100, 1, 'telegram', 5002, 1, 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z', NULL, NULL),
         (1004, 102, 3, 'playground', NULL, 1, 0, '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z', NULL, 1),
         (1005, 102, 3, 'playground', NULL, 1, 1, '2026-01-01T00:00:06.000Z', '2026-01-01T00:00:06.000Z', 1004, 2);
INSERT INTO message_revisions (id, message_id, revision_no, sender_id, kind, text, created_at, raw_fragment_json)
  VALUES (2000, 1000, 1, 10, 'text', 'hi', '2026-01-01T00:00:01.000Z', '{}'),
         (2001, 1000, 2, 10, 'text', 'hi again', '2026-01-01T00:00:01.500Z', '{}'),
         (2002, 1001, 1, 11, 'text', 'yo', '2026-01-01T00:00:02.000Z', '{}'),
         (2003, 1002, 1, 11, 'text', 'out', '2026-01-01T00:00:03.000Z', '{}'),
         (2004, 1003, 1, 12, 'text', 'channel post', '2026-01-01T00:00:04.000Z', '{}'),
         (2005, 1004, 1, 13, 'text', 'room one', '2026-01-01T00:00:05.000Z', '{}'),
         (2006, 1005, 1, 11, 'text', 'room two', '2026-01-01T00:00:06.000Z', '{}');
UPDATE messages SET current_revision_id = CASE id
  WHEN 1000 THEN 2001 WHEN 1001 THEN 2002 WHEN 1002 THEN 2003
  WHEN 1003 THEN 2004 WHEN 1004 THEN 2005 WHEN 1005 THEN 2006 END;
INSERT INTO media (id, revision_id, kind, file_id, file_unique_id, mime_type, telegram_json, host_kind)
  VALUES (4000, 2000, 'photo', 'file-1', 'uniq-1', 'image/jpeg', '{}', 'telegram');
INSERT INTO conversation_context_cutoffs (conversation_id, telegram_message_id, created_at, updated_at)
  VALUES (100, 5000, '2026-01-01T00:00:10.000Z', '2026-01-01T00:00:10.000Z');
INSERT INTO conversation_attention (conversation_id, expires_at, triggered_at, trigger_kind, trigger_telegram_message_id, updated_at)
  VALUES (100, '2026-01-02T00:00:00.000Z', '2026-01-01T00:30:00.000Z', 'mention', 5001, '2026-01-01T00:30:00.000Z');
INSERT INTO buckets (id, conversation_id, state, first_received_at, deadline_at, created_at, updated_at)
  VALUES (3000, 100, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z');
INSERT INTO bucket_messages (bucket_id, message_id, sequence_no) VALUES (3000, 1000, 1), (3000, 1001, 2);
INSERT INTO invocations (id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
  VALUES (5000, 3000, 100, 'completed', 'hash', 1, '2026-01-01T00:00:16.000Z');
INSERT INTO invocation_messages (invocation_id, message_id, revision_id, section, sequence_no, omitted_before, snapshot_json)
  VALUES (5000, 1000, 2001, 'new', 1, 0, '{"message_id":"5000"}');
INSERT INTO tool_calls (id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at)
  VALUES (8000, 5000, 'call-a', 'send', '{}', 'success', 1, '2026-01-01T00:00:17.000Z'),
         (8001, 5000, 'call-b', 'send', '{}', 'error', 1, '2026-01-01T00:00:18.000Z');
INSERT INTO host_sends (id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at)
  VALUES (9000, 8000, 100, 'text', '{"text":"sent"}', 'success', 9001, '2026-01-01T00:00:17.000Z', '2026-01-01T00:00:17.500Z'),
         (9001, 8001, 100, 'text', '{"text":"lost"}', 'outcome_unknown', NULL, '2026-01-01T00:00:18.000Z', '2026-01-01T00:00:18.500Z');
INSERT INTO group_memories (id, chat_id, day, summary, first_message_id, last_message_id, created_at)
  VALUES ('mem_a', 1, '2026-01-01', 'they talked', 5000, 5002, '2026-01-02T00:00:00.000Z');
`;

/** The tables the migration touches, in dependency order, for row-count checks. */
const SEEDED_TABLES = [
  'chats',
  'senders',
  'conversations',
  'rooms',
  'room_participants',
  'messages',
  'message_revisions',
  'media',
  'conversation_context_cutoffs',
  'conversation_attention',
  'buckets',
  'bucket_messages',
  'invocations',
  'invocation_messages',
  'tool_calls',
  'host_sends',
  'group_memories',
] as const;

test('migration 064 renames the identity columns without disturbing a mixed-host database', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);

  const legacy = await buildDatabaseBelow(loaded, 64);
  legacy.exec(SEED_063);
  expect(legacy.pragma('foreign_key_check')).toEqual([]);
  const before = {
    chats: legacy.prepare('SELECT * FROM chats ORDER BY id').all(),
    senders: legacy.prepare('SELECT * FROM senders ORDER BY id').all(),
    // (id -> the number the model saw), the merge rule written out by hand.
    messageNumbers: legacy
      .prepare('SELECT id, COALESCE(telegram_message_id, local_sequence_no) AS expected FROM messages ORDER BY id')
      .all() as { id: bigint; expected: bigint }[],
    messageDates: legacy.prepare('SELECT id, telegram_date FROM messages ORDER BY id').all(),
    messageReplies: legacy.prepare('SELECT id, local_reply_to_message_id FROM messages ORDER BY id').all(),
    revisionCounts: legacy
      .prepare(
        'SELECT message_id, COUNT(*) AS revisions FROM message_revisions GROUP BY message_id ORDER BY message_id',
      )
      .all(),
    cutoffs: legacy.prepare('SELECT * FROM conversation_context_cutoffs ORDER BY conversation_id').all(),
    attention: legacy.prepare('SELECT * FROM conversation_attention ORDER BY conversation_id').all(),
    sends: legacy.prepare('SELECT * FROM host_sends ORDER BY id').all(),
    groupMemories: legacy.prepare('SELECT * FROM group_memories ORDER BY id').all(),
    rowCounts: Object.fromEntries(
      SEEDED_TABLES.map((table) => [
        table,
        (legacy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n,
      ]),
    ),
  };
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    const orm = store.orm;
    expect(Number(store.db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(store.db.pragma('foreign_key_check')).toEqual([]);

    // No CASCADE delete fired anywhere: every seeded table kept its row count.
    for (const table of SEEDED_TABLES) {
      expect(
        (orm.get<{ n: bigint }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0n).toString(),
        `row count of ${table}`,
      ).toBe((before.rowCounts[table] ?? 0n).toString());
    }

    // Internal ids survived, and each message carries exactly the number the
    // model saw before: the Telegram wire id or the room sequence.
    const upgradedMessages = orm.all<{ id: bigint; host_kind: string; message_no: bigint; sent_at: string }>(
      sql`SELECT id, host_kind, message_no, sent_at FROM messages ORDER BY id`,
    );
    expect(upgradedMessages.map((row) => row.id)).toEqual(before.messageNumbers.map((row) => row.id));
    for (const row of upgradedMessages) {
      const expected = before.messageNumbers.find((entry) => entry.id === row.id)?.expected;
      expect(row.message_no, `message_no of message ${row.id}`).toBe(expected);
    }
    expect(orm.all(sql`SELECT id, sent_at FROM messages ORDER BY id`)).toEqual(
      before.messageDates.map((row) => ({
        id: (row as { id: bigint }).id,
        sent_at: (row as { telegram_date: string }).telegram_date,
      })),
    );
    expect(orm.all(sql`SELECT id, local_reply_to_message_id FROM messages ORDER BY id`)).toEqual(before.messageReplies);
    expect(
      orm.all(
        sql`SELECT message_id, COUNT(*) AS revisions FROM message_revisions GROUP BY message_id ORDER BY message_id`,
      ),
    ).toEqual(before.revisionCounts);

    // Renamed columns in the satellite tables kept their values.
    expect(
      orm.all<{ conversation_id: bigint; message_no: bigint }>(
        sql`SELECT conversation_id, message_no FROM conversation_context_cutoffs ORDER BY conversation_id`,
      ),
    ).toEqual([{ conversation_id: 100n, message_no: 5000n }]);
    expect(
      orm.all<{ trigger_message_no: bigint | null }>(
        sql`SELECT trigger_message_no FROM conversation_attention ORDER BY conversation_id`,
      ),
    ).toEqual([{ trigger_message_no: 5001n }]);
    expect(
      orm.all<{ id: bigint; message_no: bigint | null; state: string }>(
        sql`SELECT id, message_no, state FROM host_sends ORDER BY id`,
      ),
    ).toEqual([
      { id: 9000n, message_no: 9001n, state: 'success' },
      { id: 9001n, message_no: null, state: 'outcome_unknown' },
    ]);
    expect(orm.all(sql`SELECT * FROM group_memories ORDER BY id`)).toEqual(before.groupMemories);

    // The renamed identity columns kept their values under their new names.
    expect(
      orm.all<{ id: bigint; host_kind: string; host_chat_id: bigint | null; canonical_chat_id: bigint | null }>(
        sql`SELECT id, host_kind, host_chat_id, canonical_chat_id FROM chats ORDER BY id`,
      ),
    ).toEqual([
      { id: 1n, host_kind: 'telegram', host_chat_id: -100123n, canonical_chat_id: -100123n },
      { id: 2n, host_kind: 'telegram', host_chat_id: 123456789n, canonical_chat_id: 123456789n },
      { id: 3n, host_kind: 'playground', host_chat_id: null, canonical_chat_id: null },
    ]);
    expect(
      orm.all<{ id: bigint; host_kind: string; host_sender_type: string | null; host_sender_id: bigint | null }>(
        sql`SELECT id, host_kind, host_sender_type, host_sender_id FROM senders ORDER BY id`,
      ),
    ).toEqual([
      { id: 10n, host_kind: 'telegram', host_sender_type: 'user', host_sender_id: 777n },
      { id: 11n, host_kind: 'telegram', host_sender_type: 'user', host_sender_id: 778n },
      { id: 12n, host_kind: 'telegram', host_sender_type: 'sender_chat', host_sender_id: -100999n },
      { id: 13n, host_kind: 'playground', host_sender_type: null, host_sender_id: null },
    ]);

    // The new uniques allow one native id per host and reject a duplicate
    // inside a single host.
    orm
      .insert(chats)
      .values({
        id: 50n,
        hostKind: 'playground',
        hostChatId: -100123n,
        type: 'virtual',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm.delete(chats).where(sql`${chats.id} = 50`).run();
    expect(() =>
      orm
        .insert(chats)
        .values({
          id: 51n,
          hostKind: 'telegram',
          hostChatId: -100123n,
          canonicalChatId: -100123n,
          type: 'group',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    orm
      .insert(senders)
      .values({
        id: 60n,
        hostKind: 'playground',
        hostSenderType: 'user',
        hostSenderId: 777n,
        displayName: 'Not Alice',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm.delete(senders).where(sql`${senders.id} = 60`).run();
    expect(() =>
      orm
        .insert(senders)
        .values({
          id: 61n,
          hostKind: 'telegram',
          hostSenderType: 'user',
          hostSenderId: 777n,
          displayName: 'Also Alice',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      orm
        .insert(messages)
        .values({
          id: 7000n,
          conversationId: 100n,
          chatId: 1n,
          hostKind: 'telegram',
          messageNo: 5000n,
          sentAt: '2026-01-02T00:00:00.000Z',
          receivedAt: '2026-01-02T00:00:00.000Z',
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    // A write that forgets host_kind fails now; it used to become Telegram.
    expect(() => {
      orm.run(sql`INSERT INTO chats (id, type, updated_at) VALUES (70, 'group', '2026-01-02T00:00:00.000Z')`);
    }).toThrow();
    expect(() => {
      orm.run(sql`INSERT INTO senders (id, display_name, updated_at) VALUES (70, 'x', '2026-01-02T00:00:00.000Z')`);
    }).toThrow();
    expect(() => {
      orm.run(sql`INSERT INTO messages (id, conversation_id, chat_id, message_no, sent_at, received_at)
        VALUES (7001, 100, 1, 7000, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`);
    }).toThrow();
    expect(() => {
      orm.run(sql`INSERT INTO media (id, revision_id, kind, file_id, file_unique_id, telegram_json)
        VALUES (4001, 2000, 'photo', 'f', 'u', '{}')`);
    }).toThrow();

    // The rebuilt indexes exist under their new columns, and the history
    // index rides the new ordering columns.
    const indexNames = new Set(
      orm.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index'`).map((row) => row.name),
    );
    for (const name of [
      'chats_host_chat_id_key',
      'senders_host_identity_key',
      'messages_chat_message_no_key',
      'messages_conversation_history_idx',
      'media_revision_idx',
      'media_unique_idx',
      'conversation_attention_expiry_idx',
    ]) {
      expect(indexNames.has(name), `index ${name}`).toBe(true);
    }
    for (const name of [
      'chats_telegram_chat_id_key',
      'senders_telegram_identity_key',
      'messages_chat_telegram_message_id_key',
      'messages_local_sequence_key',
    ]) {
      expect(indexNames.has(name), `old index ${name} dropped`).toBe(false);
    }

    // Telegram ingestion still works on the upgraded schema: the upserts find
    // their new conflict targets, a repeated update dedups and an edit appends
    // a revision instead of inserting a second message.
    const configStore = await testConfigStore(loaded);
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const update = (updateId: number, messageId: number, text: string): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 777, is_bot: false, first_name: 'Alice' },
        text,
      },
    });
    ingestion.ingest(update(1, 7000, 'arrived'), new Date('2026-01-03T00:00:00.000Z'));
    const stored = orm
      .all<{ id: bigint; message_no: bigint; host_kind: string }>(
        sql`SELECT id, message_no, host_kind FROM messages WHERE chat_id = 2 AND message_no = 7000`,
      )
      .at(0);
    expect(stored).toMatchObject({ message_no: 7000n, host_kind: 'telegram' });
    const before2 = orm.get<{ n: bigint }>(sql`SELECT COUNT(*) AS n FROM messages`)?.n;
    ingestion.ingest(update(2, 7000, 'arrived'), new Date('2026-01-03T00:00:01.000Z'));
    expect(orm.get<{ n: bigint }>(sql`SELECT COUNT(*) AS n FROM messages`)?.n).toBe(before2);
    const edited: Update = {
      update_id: 3,
      edited_message: {
        message_id: 7000,
        date: 1_700_000_000,
        edit_date: 1_700_000_005,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 777, is_bot: false, first_name: 'Alice' },
        text: 'edited',
      },
    };
    ingestion.ingest(edited, new Date('2026-01-03T00:00:02.000Z'));
    expect(
      orm.all<{ revision_no: bigint; text: string | null }>(
        sql`SELECT revision_no, text FROM message_revisions WHERE message_id = ${stored?.id ?? 0n} ORDER BY revision_no`,
      ),
    ).toEqual([
      { revision_no: 1n, text: 'arrived' },
      { revision_no: 2n, text: 'edited' },
    ]);
    // The sender upsert hit the (host_kind, host_sender_type, host_sender_id)
    // target: still exactly one Alice row, now with her latest name.
    expect(
      orm.all<{ n: bigint }>(
        sql`SELECT COUNT(*) AS n FROM senders WHERE host_kind = 'telegram' AND host_sender_type = 'user' AND host_sender_id = 777`,
      ),
    ).toEqual([{ n: 1n }]);
    // Media inserts carry their host explicitly now.
    expect(orm.get<{ host_kind: string }>(sql`SELECT host_kind FROM media WHERE id = 4000`)).toEqual({
      host_kind: 'telegram',
    });
  } finally {
    store.close();
  }
});
