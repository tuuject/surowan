import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';
import { cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations');

/**
 * 057 gives every batch the collection timing it was opened with. A batch that
 * was still collecting at the upgrade had no recorded timing: it keeps the
 * deadline it already has and records 0/0/0, so nothing re-windows or extends
 * it — the same timing a batch that never collects records.
 */
test('migration 057 records 0/0/0 for batches stored before it and guards the new columns', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  await mkdir(dirname(loaded.config.paths.database), { recursive: true });

  const legacy = new Database(loaded.config.paths.database);
  legacy.defaultSafeIntegers(true);
  legacy.pragma('foreign_keys = ON');
  for (const name of (await readdir(MIGRATIONS))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 3)) < 57)
    .sort()) {
    legacy.exec(await readFile(join(MIGRATIONS, name), 'utf8'));
    legacy
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(Number(name.slice(0, 3)), '2026-01-01T00:00:00.000Z');
  }
  legacy.exec(`
    INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, title, username, updated_at)
      VALUES (1, -100123, -100123, 'supergroup', 'Group', NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
      VALUES (100, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO buckets (id, conversation_id, state, first_received_at, deadline_at, created_at, updated_at)
      VALUES (1, 100, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z'),
             (2, 100, 'collecting', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:15.000Z',
              '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z');
  `);
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    expect(
      store.db
        .prepare<
          [],
          { id: bigint; deadline_at: string; window_seconds: bigint; max_seconds: bigint; bump_seconds: bigint }
        >('SELECT id, deadline_at, window_seconds, max_seconds, bump_seconds FROM buckets ORDER BY id')
        .all(),
    ).toEqual([
      { id: 1n, deadline_at: '2026-01-01T00:00:15.000Z', window_seconds: 0n, max_seconds: 0n, bump_seconds: 0n },
      { id: 2n, deadline_at: '2026-01-01T00:01:15.000Z', window_seconds: 0n, max_seconds: 0n, bump_seconds: 0n },
    ]);
    const insert = (window: number, max: number, bump: number) => () =>
      store.db
        .prepare(
          `INSERT INTO buckets (conversation_id, state, first_received_at, deadline_at, created_at, updated_at,
             window_seconds, max_seconds, bump_seconds)
           VALUES (100, 'completed', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
             '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?, ?, ?)`,
        )
        .run(window, max, bump);
    expect(insert(-1, 0, 0)).toThrow(/CHECK constraint failed/);
    expect(insert(10, 5, 0)).toThrow(/CHECK constraint failed/);
    expect(insert(5, 10, -1)).toThrow(/CHECK constraint failed/);
    expect(insert(5, 10, 3)).not.toThrow();
  } finally {
    store.close();
  }
});
