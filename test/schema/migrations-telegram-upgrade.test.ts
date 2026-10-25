import { afterAll, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { getConversationContext, listConversationContexts } from '../../src/ingress/admin/audit/conversations.ts';
import { getInvocation } from '../../src/ingress/admin/audit/invocation-detail.ts';
import { getMessage, listMessages } from '../../src/ingress/admin/audit/messages.ts';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { overview } from '../../src/ingress/admin/audit/overview.ts';
import { listMemories, listMemoryChats } from '../../src/ingress/admin/memory.ts';
import { listDictionaryChatOptions } from '../../src/plugins/dictionary/admin.ts';
import {
  buckets,
  chats,
  conversations,
  invocations,
  messageRevisions,
  messages,
  roomParticipants,
  rooms,
  senders,
} from '../../src/store/schema/index.ts';
import { writeTestConfig } from '../helpers.ts';
import { cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

/** Seeds a database that is still on the pre-037 schema. */
const SEED_037 = `
INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, title, username, updated_at)
  VALUES (1, -100123, -100123, 'supergroup', 'Group', 'grp', '2026-01-01T00:00:00.000Z'),
         (2, 555, 555, 'private', NULL, NULL, '2026-01-01T00:00:00.000Z');
INSERT INTO senders (id, telegram_type, telegram_id, display_name, username, is_bot, updated_at)
  VALUES (10, 'user', 777, 'Alice', 'alice', 0, '2026-01-01T00:00:00.000Z'),
         (11, 'user', 778, 'Bot', 'bot', 1, '2026-01-01T00:00:00.000Z');
INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
  VALUES (100, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (101, 2, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO messages (id, conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at)
  VALUES (1000, 100, 1, 5000, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (1001, 100, 1, 5001, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
         (1002, 101, 2, 6000, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO message_revisions (id, message_id, revision_no, sender_id, kind, text, created_at, raw_fragment_json)
  VALUES (2000, 1000, 1, 10, 'text', 'hi', '2026-01-01T00:00:00.000Z', '{}'),
         (2001, 1001, 1, 11, 'text', 'yo', '2026-01-01T00:00:00.000Z', '{}'),
         (2002, 1002, 1, 11, 'text', 'out', '2026-01-01T00:00:00.000Z', '{}');
UPDATE messages SET current_revision_id = id + 1000;
INSERT INTO buckets (id, conversation_id, state, first_received_at, deadline_at, created_at, updated_at)
  VALUES (3000, 100, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO bucket_messages (bucket_id, message_id, sequence_no) VALUES (3000, 1000, 1), (3000, 1001, 2);
INSERT INTO invocations (id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
  VALUES (5000, 3000, 100, 'completed', 'hash', 1, '2026-01-01T00:00:00.000Z');
INSERT INTO invocation_messages (invocation_id, message_id, revision_id, section, sequence_no, omitted_before, snapshot_json)
  VALUES (5000, 1000, 2000, 'new', 1, 0, '{"text":"hi"}');
`;

test('migration 037 upgrades a live Telegram database without disturbing it', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);

  const legacy = new Database(loaded.config.paths.database);
  legacy.pragma('foreign_keys = ON');
  // Match the store's integer handling so the before/after snapshots compare.
  legacy.defaultSafeIntegers(true);
  const migrations = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations');
  for (const name of (await readdir(migrations))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) < 37)
    .sort()) {
    legacy.exec(await readFile(join(migrations, name), 'utf8'));
    // 001 creates schema_migrations, so recording starts from the first file.
    legacy
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(Number(name.slice(0, 3)), '2026-01-01T00:00:00.000Z');
  }
  legacy.exec(SEED_037);
  const before = {
    messages: legacy.prepare('SELECT id, telegram_message_id, current_revision_id FROM messages ORDER BY id').all(),
    revisions: legacy.prepare('SELECT id, message_id, sender_id, text FROM message_revisions ORDER BY id').all(),
    invocations: legacy.prepare('SELECT id, state, config_hash FROM invocations ORDER BY id').all(),
    snapshot: legacy.prepare('SELECT snapshot_json FROM invocation_messages').get() as { snapshot_json: string },
  };
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    const orm = store.orm;
    expect(Number(store.db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(store.db.pragma('foreign_key_check')).toEqual([]);

    // Every row kept its id, its Telegram identity and its place in the tree.
    expect(orm.all(sql`SELECT id, telegram_message_id, current_revision_id FROM messages ORDER BY id`)).toEqual(
      before.messages,
    );
    expect(orm.all(sql`SELECT id, message_id, sender_id, text FROM message_revisions ORDER BY id`)).toEqual(
      before.revisions,
    );
    expect(orm.all(sql`SELECT id, state, config_hash FROM invocations ORDER BY id`)).toEqual(before.invocations);
    expect(orm.get(sql`SELECT snapshot_json FROM invocation_messages`)).toEqual(before.snapshot);
    expect(orm.all(sql`SELECT DISTINCT host_kind FROM chats`)).toEqual([{ host_kind: 'telegram' }]);
    expect(orm.all(sql`SELECT DISTINCT host_kind FROM senders`)).toEqual([{ host_kind: 'telegram' }]);
    expect(orm.all(sql`SELECT DISTINCT snapshot_format FROM invocation_messages`)).toEqual([
      { snapshot_format: 'plasticwan.invocation-snapshot.v1' },
    ]);

    // The Telegram-shaped admin surface is unchanged for Telegram data.
    expect(listInvocations(orm, {}).items).toHaveLength(1);
    expect(listMessages(orm, {}).items).toHaveLength(3);
    expect(getInvocation(orm, 5000n)).not.toBeNull();
    expect(getMessage(orm, 1000n)).not.toBeNull();
    expect(listMemoryChats(orm).map((chat) => chat.telegram_chat_id)).toEqual(['-100123', '555']);
    expect(listDictionaryChatOptions(orm)).toHaveLength(2);

    // A virtual room, identity and message fit in the same tables, with no
    // Telegram id anywhere, and never leak into a Telegram-scoped reader.
    orm
      .insert(chats)
      .values({
        id: 50n,
        hostKind: 'playground',
        type: 'virtual',
        title: 'Playground',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm
      .insert(senders)
      .values({
        id: 60n,
        hostKind: 'playground',
        displayName: 'Echo',
        isBot: true,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm
      .insert(conversations)
      .values({
        id: 150n,
        chatId: 50n,
        messageThreadId: 0n,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm
      .insert(rooms)
      .values({ chatId: 50n, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
      .run();
    orm.insert(roomParticipants).values({ chatId: 50n, senderId: 60n, joinedAt: '2026-01-02T00:00:00.000Z' }).run();
    orm
      .insert(messages)
      .values({
        id: 7000n,
        conversationId: 150n,
        chatId: 50n,
        hostKind: 'playground',
        visible: true,
        sentByBot: false,
        telegramDate: '2026-01-02T00:00:00.000Z',
        receivedAt: '2026-01-02T00:00:00.000Z',
        localReplyToMessageId: 1002n,
        localSequenceNo: 1n,
      })
      .run();
    orm
      .insert(messageRevisions)
      .values({
        id: 8000n,
        messageId: 7000n,
        revisionNo: 1n,
        senderId: 60n,
        kind: 'text',
        text: 'local',
        createdAt: '2026-01-02T00:00:00.000Z',
        rawFragmentJson: '{}',
      })
      .run();
    orm
      .insert(buckets)
      .values({
        id: 4000n,
        conversationId: 150n,
        state: 'completed',
        firstReceivedAt: '2026-01-02T00:00:00.000Z',
        deadlineAt: '2026-01-02T00:00:00.000Z',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    orm
      .insert(invocations)
      .values({
        id: 6000n,
        bucketId: 4000n,
        conversationId: 150n,
        state: 'completed',
        configHash: 'hash',
        promptVersion: 1n,
        createdAt: '2026-01-02T00:00:00.000Z',
      })
      .run();
    expect(orm.get(sql`SELECT host_kind FROM chats WHERE id = 50`)).toEqual({ host_kind: 'playground' });

    // Read-only surfaces tolerate the mix instead of throwing on a NULL
    // Telegram identity. The invocation audit is host-neutral and names the
    // room by its own id; virtual rows stay out of Telegram-scoped views.
    expect(listInvocations(orm, {}).items).toHaveLength(2);
    expect(orm.get(sql`SELECT count(*) AS c FROM invocations`)).toEqual({ c: 2n });
    expect(listMessages(orm, {}).items).toHaveLength(3);
    expect(listConversationContexts(orm, {}).items).toHaveLength(0);
    expect(getInvocation(orm, 6000n)?.chat).toMatchObject({
      host_kind: 'playground',
      telegram_chat_id: null,
      room_id: '50',
    });
    expect(getMessage(orm, 7000n)).toBeNull();
    expect(getConversationContext(orm, 150n)).toBeNull();
    expect(() => overview(orm)).not.toThrow();
    expect(() => listMemories(orm, {}, 30)).not.toThrow();
    expect(listMemoryChats(orm)).toHaveLength(2);
    expect(listDictionaryChatOptions(orm)).toHaveLength(2);

    // The conditional identity constraints still bite in both directions.
    expect(() =>
      orm
        .insert(chats)
        .values({ id: 51n, hostKind: 'telegram', canonicalChatId: -1n, type: 'group', updatedAt: 'x' })
        .run(),
    ).toThrow(/CHECK constraint failed|chats_host_identity_check/);
    expect(() =>
      orm
        .insert(chats)
        .values({
          id: 52n,
          hostKind: 'playground',
          telegramChatId: -1n,
          canonicalChatId: -1n,
          type: 'virtual',
          updatedAt: 'x',
        })
        .run(),
    ).toThrow();
    expect(() =>
      orm
        .insert(chats)
        .values({ id: 53n, telegramChatId: -100123n, canonicalChatId: -100123n, type: 'group', updatedAt: 'x' })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      orm
        .insert(messages)
        .values({
          id: 7001n,
          conversationId: 100n,
          chatId: 1n,
          visible: true,
          sentByBot: false,
          telegramDate: 'x',
          receivedAt: 'x',
        })
        .run(),
    ).toThrow();
  } finally {
    store.close();
  }
});
