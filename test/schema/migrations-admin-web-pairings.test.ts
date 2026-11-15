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
const T = '2026-01-01T00:00:00.000Z';
const KEY = 'A'.repeat(43);

/**
 * 059 rebuilds `admin_pairings` with a purpose. Tickets stored by 058 are client
 * tickets and keep their ids, state and client link; the AUTOINCREMENT high-water
 * mark survives the rebuild, so a purged ticket's id is never handed out again;
 * and the new CHECKs keep each purpose to its own columns.
 */
test('migration 059 keeps 058 tickets as client tickets and fences the web purpose', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  await mkdir(dirname(loaded.config.paths.database), { recursive: true });

  const legacy = new Database(loaded.config.paths.database);
  legacy.defaultSafeIntegers(true);
  legacy.pragma('foreign_keys = ON');
  for (const name of (await readdir(MIGRATIONS))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 3)) < 59)
    .sort()) {
    legacy.exec(await readFile(join(MIGRATIONS, name), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(Number(name.slice(0, 3)), T);
  }
  legacy.exec(`
    INSERT INTO admin_users (id, username, password_hash, created_at, updated_at)
      VALUES (1, 'admin', NULL, '${T}', '${T}');
    INSERT INTO admin_clients (id, name, public_key, fingerprint, created_at, read_all, write_all, execute_paid_operations)
      VALUES (7, 'agent', '${KEY}', 'SHA256:x', '${T}', 1, 0, 0);
    INSERT INTO admin_pairings (id, name, code_hash, public_key, created_at, expires_at, consumed_at, client_id,
        read_all, write_all, execute_paid_operations)
      VALUES (1, 'agent', 'hash-1', NULL, '${T}', '${T}', '${T}', 7, 1, 0, 0),
             (2, 'pending', 'hash-2', '${KEY}', '${T}', '2999-01-01T00:00:00.000Z', NULL, NULL, 1, 1, 0),
             (3, 'purged', 'hash-3', NULL, '${T}', '${T}', NULL, NULL, 1, 0, 0);
    DELETE FROM admin_pairings WHERE id = 3;
  `);
  legacy.close();

  const store = await SqliteStore.open(loaded.config);
  try {
    expect(
      store.db
        .prepare<[], Record<string, unknown>>(
          'SELECT id, purpose, name, code_hash, public_key, user_id, consumed_at, client_id, read_all, write_all FROM admin_pairings ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 1n,
        purpose: 'client',
        name: 'agent',
        code_hash: 'hash-1',
        public_key: null,
        user_id: null,
        consumed_at: T,
        client_id: 7n,
        read_all: 1n,
        write_all: 0n,
      },
      {
        id: 2n,
        purpose: 'client',
        name: 'pending',
        code_hash: 'hash-2',
        public_key: KEY,
        user_id: null,
        consumed_at: null,
        client_id: null,
        read_all: 1n,
        write_all: 1n,
      },
    ]);

    let next = 10;
    const insert =
      (purpose: string, columns: { user?: number | null; client?: number | null; consumed?: boolean; bits?: number }) =>
      () => {
        next += 1;
        const bits = columns.bits ?? 1;
        return store.db
          .prepare(
            `INSERT INTO admin_pairings (purpose, name, code_hash, user_id, created_at, expires_at, consumed_at,
               client_id, read_all, write_all, execute_paid_operations)
             VALUES (?, 'n', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            purpose,
            `hash-${next}`,
            columns.user ?? null,
            T,
            T,
            columns.consumed === true ? T : null,
            columns.client ?? null,
            bits,
            bits,
            bits,
          );
      };
    expect(insert('admin', { user: 1 })).toThrow(/CHECK constraint failed/);
    expect(insert('web', {})).toThrow(/CHECK constraint failed/);
    expect(insert('web', { user: 1, bits: 0 })).toThrow(/CHECK constraint failed/);
    expect(insert('web', { user: 1, client: 7, consumed: true })).toThrow(/CHECK constraint failed/);
    expect(insert('client', { user: 1 })).toThrow(/CHECK constraint failed/);
    expect(insert('client', { consumed: true })).toThrow(/CHECK constraint failed/);
    expect(insert('web', { user: 99 })).toThrow(/FOREIGN KEY constraint failed/);

    const web = insert('web', { user: 1, consumed: true })();
    // id 3 was handed out before the rebuild; the next id continues past it.
    expect(BigInt(web.lastInsertRowid)).toBe(4n);
  } finally {
    store.close();
  }
});
