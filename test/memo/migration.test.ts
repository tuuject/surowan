import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations');

test('migration 046 merges conversation memories of one Chat into Memo Pad entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-memo-migration-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  await mkdir(dirname(loaded.config.paths.database), { recursive: true });

  const legacy = new Database(loaded.config.paths.database);
  legacy.defaultSafeIntegers(true);
  legacy.pragma('foreign_keys = ON');
  for (const name of (await readdir(MIGRATIONS))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 3)) < 46)
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
      VALUES (100, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
             (101, 1, 5, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO memories (id, conversation_id, content, created_at, expires_at, updated_at)
      VALUES ('mem_${'1'.repeat(32)}', 100, 'general topic fact', '2026-01-01T00:00:00.000Z',
              '2026-01-04T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
             ('mem_${'2'.repeat(32)}', 101, 'side topic fact', '2026-01-02T00:00:00.000Z',
              '2026-01-05T00:00:00.000Z', '2026-01-03T12:00:00.000Z');
  `);
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    expect(
      store.orm.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`),
    ).toBeUndefined();
    expect(
      store.orm.all(
        sql`SELECT id, chat_id, summary, detail, created_at, expires_at, updated_at
            FROM memo_pad_entries ORDER BY id`,
      ),
    ).toEqual([
      {
        id: `mem_${'1'.repeat(32)}`,
        chat_id: 1n,
        summary: 'general topic fact',
        detail: 'general topic fact',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-04T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
      },
      {
        id: `mem_${'2'.repeat(32)}`,
        chat_id: 1n,
        summary: 'side topic fact',
        detail: 'side topic fact',
        created_at: '2026-01-02T00:00:00.000Z',
        expires_at: '2026-01-05T00:00:00.000Z',
        updated_at: '2026-01-03T12:00:00.000Z',
      },
    ]);
  } finally {
    store.close();
  }
});
