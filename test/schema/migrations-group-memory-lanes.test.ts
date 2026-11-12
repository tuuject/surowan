import { afterAll, expect, test } from 'vitest';

import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { cleanupSchemaDirectories, openStore } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

// --- Migration 054: group memory lanes, run audit and 200-character summaries ---

test('migration 054 turns each watermark into an idle live lane and keeps every summary', async () => {
  const fixture = await openStore();
  let store = fixture.store;
  try {
    // Put the database back in its 048 shape, with the rows a pre-054 process
    // leaves behind: one Chat mid-claim when it stopped, one in backoff.
    store.db.exec(`
      DROP TABLE group_memory_runs;
      DROP TABLE group_memory_lanes;
      DROP TABLE group_memories;
      CREATE TABLE group_memories (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        summary TEXT NOT NULL,
        first_message_id INTEGER NOT NULL,
        last_message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (length(summary) BETWEEN 1 AND 150),
        CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        CHECK (first_message_id > 0),
        CHECK (last_message_id >= first_message_id)
      ) STRICT;
      CREATE INDEX group_memories_chat_day_idx ON group_memories(chat_id, day, first_message_id);
      CREATE INDEX group_memories_chat_range_idx ON group_memories(chat_id, first_message_id, last_message_id);
      CREATE TABLE group_memory_state (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        consolidated_through_message_id INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle',
        claimed_at TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        next_attempt_at TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL,
        CHECK (state IN ('idle', 'running')),
        CHECK (consolidated_through_message_id >= 0)
      ) STRICT;
      DELETE FROM schema_migrations WHERE version = 54;

      INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES
        (1, 'telegram', -1001, -1001, 'supergroup', 'Group A', '2026-11-01T00:00:00.000Z'),
        (2, 'telegram', -1002, -1002, 'supergroup', 'Group B', '2026-11-01T00:00:00.000Z');
      INSERT INTO group_memories VALUES
        ('gmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, '2026-10-10', 'an old event', 34000, 34313, '2026-11-12T07:43:06.000Z');
      INSERT INTO group_memory_state VALUES
        (1, 34313, 'running', '2026-11-12T08:00:00.000Z', '2026-11-12T08:00:00.000Z', '2026-11-12T07:43:06.000Z',
         NULL, NULL, '2026-11-12T08:00:00.000Z'),
        (2, 133481, 'idle', NULL, '2026-11-12T08:10:00.000Z', '2026-11-12T05:20:00.000Z',
         '2026-11-12T08:40:00.000Z', 'group_memory_unavailable', '2026-11-12T08:10:00.000Z');
    `);
    store.close();
    store = await SqliteStore.open(fixture.loaded.config);

    expect(
      store.db
        .prepare(
          `SELECT chat_id, lane, through_message_id, until_message_id, state, claimed_at, last_success_at,
                  next_attempt_at, error_code, consecutive_failures
           FROM group_memory_lanes ORDER BY chat_id`,
        )
        .all(),
    ).toEqual([
      {
        chat_id: 1n,
        lane: 'live',
        through_message_id: 34313n,
        until_message_id: null,
        // The process was stopped to migrate, so the old claim cannot be live.
        state: 'idle',
        claimed_at: null,
        last_success_at: '2026-11-12T07:43:06.000Z',
        next_attempt_at: null,
        error_code: null,
        consecutive_failures: 0n,
      },
      {
        chat_id: 2n,
        lane: 'live',
        through_message_id: 133481n,
        until_message_id: null,
        state: 'idle',
        claimed_at: null,
        last_success_at: '2026-11-12T05:20:00.000Z',
        next_attempt_at: '2026-11-12T08:40:00.000Z',
        error_code: 'group_memory_unavailable',
        consecutive_failures: 0n,
      },
    ]);
    expect(store.db.prepare('SELECT id, summary, first_message_id FROM group_memories').all()).toEqual([
      { id: 'gmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', summary: 'an old event', first_message_id: 34000n },
    ]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'group_memory_state'").all()).toEqual([]);

    const insertSummary = store.db.prepare(
      `INSERT INTO group_memories VALUES (?, 1, '2026-10-11', ?, 34314, 34314, '2026-11-13T00:00:00.000Z')`,
    );
    insertSummary.run('gmem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '事'.repeat(200));
    expect(() => insertSummary.run('gmem_cccccccccccccccccccccccccccccccc', '事'.repeat(201))).toThrow();
    // A backfill lane must name where it ends, and that end cannot be behind it.
    expect(() =>
      store.db.exec(`INSERT INTO group_memory_lanes (chat_id, lane, through_message_id, created_at, updated_at)
                     VALUES (1, 'backfill', 10, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')`),
    ).toThrow();
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store.close();
  }
});
