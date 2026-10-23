import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from './helpers.ts';
import {
  canonicalSnapshot,
  createPre020Db,
  directories,
  loadMigrationFile,
  run020,
  seedBucketAndInvocation,
  seedCanonicalData,
  seedChat,
} from './long-tasks-migration-fixtures.ts';

test('migration 022 backfills receipt buckets, permits shared invocations and keeps bucket bindings unique', async () => {
  const { db } = await createPre020Db();
  try {
    seedChat(db);
    seedBucketAndInvocation(db);
    await run020(db);
    db.exec(`INSERT INTO long_tasks(id, plugin_id, conversation_id, payload_json, state, delivery_json, created_at, updated_at)
      VALUES (1, 'test', 1, '{}', 'completed', '{}', 'now', 'now'), (2, 'test', 1, '{}', 'completed', '{}', 'now', 'now');
      INSERT INTO task_receipts(task_id, status, state, created_at, updated_at, invocation_id)
      VALUES (1, 'completed', 'claimed', 'now', 'now', 1), (2, 'completed', 'pending', 'now', 'now', NULL);`);
    db.exec(await loadMigrationFile(22));
    expect(db.prepare('SELECT task_id, bucket_id FROM task_receipts ORDER BY task_id').all()).toEqual([
      { task_id: 1n, bucket_id: 1n },
      { task_id: 2n, bucket_id: null },
    ]);
    expect(() => db.prepare('UPDATE task_receipts SET invocation_id = 1 WHERE task_id = 2').run()).not.toThrow();
    expect(() => db.prepare('UPDATE task_receipts SET bucket_id = 1 WHERE task_id = 2').run()).toThrow(/UNIQUE/);
    expect(() => db.prepare('UPDATE task_receipts SET bucket_id = 999 WHERE task_id = 2').run()).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM invocations WHERE id = 1').run();
    db.prepare('DELETE FROM buckets WHERE id = 1').run();
    expect(db.prepare('SELECT invocation_id, bucket_id FROM task_receipts WHERE task_id = 1').get()).toEqual({
      invocation_id: null,
      bucket_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});

describe('migration 021', () => {
  test.each([19, 20])('upgrades version %i without changing canonical history, audit, or tasks', async (version) => {
    const { db, directory } = await createPre020Db();
    seedCanonicalData(db);
    const canonical = canonicalSnapshot(db);
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id, invocation_id,
        fired_at, invocation_outcome, completion_reason)
      VALUES (500, 1, 42, 'Alice', 'retained task',
        '2025-08-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', 'fired',
        '2025-08-01T00:00:00.000Z', 42, 1, '2025-08-01T00:00:00.000Z', 'completed', 'done')
    `).run();
    if (version === 20) {
      await run020(db);
      db.prepare(`UPDATE internal_contexts SET kind = 'observation', payload_json = ? WHERE id = 600`).run(
        JSON.stringify({ kind: 'observation', version: 1, observed_at: '2025-07-01T00:00:00.000Z', text: 'legacy' }),
      );
    }
    let tasks = version === 20 ? db.prepare('SELECT * FROM long_tasks ORDER BY id').all() : undefined;
    let receipts =
      version === 20 ? db.prepare('SELECT *, 1 AS bucket_id FROM task_receipts ORDER BY task_id').all() : undefined;
    db.close();
    const { config } = await loadConfig(join(directory, 'config.jsonc'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await SqliteStore.open(config);
      try {
        expect(canonicalSnapshot(store.db)).toEqual(canonical);
        const actualTasks = store.db.prepare('SELECT * FROM long_tasks ORDER BY id').all();
        const actualReceipts = store.db.prepare('SELECT * FROM task_receipts ORDER BY task_id').all();
        expect(actualTasks).toMatchObject([
          { id: 500n, plugin_id: 'alarm', state: 'completed', created_by_user_id: 42n },
        ]);
        expect(actualReceipts).toMatchObject([
          { task_id: 500n, status: 'completed', state: 'handled', invocation_id: 1n, completion_reason: 'done' },
        ]);
        tasks ??= actualTasks;
        receipts ??= actualReceipts;
        expect(actualTasks).toEqual(tasks);
        expect(actualReceipts).toEqual(receipts);
        expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
        expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
          version: 45n,
        });
        expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        store.close();
      }
    }
  });

  test('fresh and reopened stores have no sidecar table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-mig-021-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = await SqliteStore.open(config);
      try {
        expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
          version: 45n,
        });
        expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);
      } finally {
        store.close();
      }
    }
  });
});
