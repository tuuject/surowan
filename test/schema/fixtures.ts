import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';

const directories: string[] = [];

/** Creates an isolated config/database directory and registers it for cleanup. */
export async function makeSchemaDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-schema-'));
  directories.push(directory);
  return directory;
}

/** Opens a migrated store inside a fresh directory, next to the config that produced it. */
export async function openStore(): Promise<{ store: SqliteStore; loaded: LoadedConfig }> {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded };
}

/** Removes every directory this module handed out; register it from the suite's `afterAll`. */
export async function cleanupSchemaDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

/**
 * Builds a database that stopped just below `belowVersion`: every earlier
 * migration file applied by hand and recorded, the way the runner applies
 * them. Rebuild migrations only run with foreign keys suspended; the runner
 * restores enforcement and verifies the check before commit, so the synthetic
 * build mirrors the same order. Seed it with the column names of that schema,
 * then let `SqliteStore.open` run the migrations under test for real.
 */
export async function buildDatabaseBelow(loaded: LoadedConfig, belowVersion: number): Promise<Database.Database> {
  const legacy = new Database(loaded.config.paths.database);
  legacy.defaultSafeIntegers(true);
  legacy.pragma('foreign_keys = OFF');
  const migrations = join(import.meta.dirname, '..', '..', 'src', 'store', 'migrations');
  for (const name of (await readdir(migrations))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) < belowVersion)
    .sort()) {
    legacy.exec(await readFile(join(migrations, name), 'utf8'));
    legacy
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(Number(name.slice(0, 3)), '2026-01-01T00:00:00.000Z');
  }
  legacy.pragma('foreign_keys = ON');
  return legacy;
}

/**
 * Undoes migration 038 exactly - the ledger back under its Telegram name without
 * the virtual-message link, the pre-038 indexes back under their old names -
 * so a test can put a live database one migration below where it started and
 * let the real chain run it again.
 */
export function rollbackHostSendsRename(db: Database.Database): void {
  db.exec(`
    DROP INDEX host_sends_reply_delivery_idx;
    DROP INDEX host_sends_image_delivery_idx;
    DROP INDEX host_sends_message_idx;
    ALTER TABLE host_sends DROP COLUMN message_id;
    ALTER TABLE host_sends RENAME TO telegram_sends;
    CREATE INDEX telegram_sends_reply_delivery_idx
      ON telegram_sends(conversation_id, json_extract(request_json, '$.reply_to_message_id'))
      WHERE state IN ('success', 'pending', 'outcome_unknown');
    CREATE INDEX telegram_sends_image_delivery_idx
      ON telegram_sends(conversation_id, json_extract(request_json, '$.generation_id'))
      WHERE kind = 'image';
    DELETE FROM schema_migrations WHERE version = 38;
  `);
}
