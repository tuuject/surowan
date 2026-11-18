import { afterAll, expect, test } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';
import { buildDatabaseBelow, cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

/**
 * `message_no NOT NULL` is the designed gate of 064: a row with neither old
 * number must abort the copy, and because `chats` and `senders` were already
 * rebuilt inside the same transaction, the whole migration rolls back.
 */
test('a message with no host number aborts the upgrade and rolls the whole migration back', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);

  const legacy = await buildDatabaseBelow(loaded, 64);
  // At 063 a Playground message could legally carry neither number; the
  // NOT NULL on messages_new.message_no is the gate that must fail the copy
  // and roll back the chats/senders rebuilds that already ran in the same
  // transaction.
  legacy.exec(`
    INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, updated_at)
      VALUES (1, 'telegram', 123456789, 123456789, 'private', '2026-01-01T00:00:00.000Z'),
             (3, 'playground', NULL, NULL, 'virtual', '2026-01-01T00:00:00.000Z');
    INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
      VALUES (102, 3, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (id, conversation_id, chat_id, host_kind, telegram_message_id, visible, sent_by_bot, telegram_date, received_at, local_sequence_no)
      VALUES (1004, 102, 3, 'playground', NULL, 1, 0, '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z', NULL);
  `);
  legacy.close();

  await expect(SqliteStore.open(loaded.config)).rejects.toThrow();

  // Nothing was committed: version 064 is absent and every rebuilt table is
  // still the post-063 shape with its rows.
  const check = new Database(loaded.config.paths.database);
  try {
    check.defaultSafeIntegers(true);
    expect(check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 63n });
    const columns = (table: string) =>
      (check.pragma(`table_info(${table})`, { simple: false }) as { name: string }[]).map((row) => row.name);
    expect(columns('chats')).toContain('telegram_chat_id');
    expect(columns('senders')).toContain('telegram_type');
    expect(columns('messages')).toContain('telegram_message_id');
    expect(columns('messages')).not.toContain('message_no');
    expect(check.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1n });
    expect(check.prepare('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 2n });
    const indexes = check
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain('chats_telegram_chat_id_key');
    expect(indexes).not.toContain('chats_host_chat_id_key');
  } finally {
    check.close();
  }
});
