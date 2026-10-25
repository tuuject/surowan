import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { buildSceneContext } from '../../src/context/scene/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { writeTestConfig } from '../helpers.ts';

test('migration 030 drops only legacy replay payloads; retention cascades public scene and audit rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-scene-retention-'));
  let store: SqliteStore | undefined;
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    store = await SqliteStore.open(config, false);
    const migrationDirectory = join(import.meta.dirname, '../../src/store/migrations');
    for (const file of (await readdir(migrationDirectory)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      const version = Number(file.slice(0, 3));
      // Build a database where the migrations under test (030, 031, 032, 034)
      // are still pending. Everything else - including 033 and 035..038 - is
      // applied here, in version order: the seed helper below writes the
      // current schema, which 037 and 038 shape, and 038 drops the index that
      // 033 created, so 033 cannot be left pending either.
      if (version >= 30 && version < 35 && version !== 33) {
        continue;
      }
      const text = await readFile(join(migrationDirectory, file), 'utf8');
      store.db.transaction(() => {
        store!.db.exec(text);
        store!.db
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(BigInt(version), new Date().toISOString());
      })();
    }
    const seed = seedAdminFixture(store);
    store.db.prepare('UPDATE model_calls SET replay_input_json = ?').run('{"version":2,"obsolete":true}');
    const preserved = () => ({
      calls: store!.db
        .prepare('SELECT * FROM model_calls ORDER BY id')
        .all()
        .map((row) => {
          const { replay_input_json: _removed, ...rest } = row as Record<string, unknown>;
          return rest;
        }),
      tools: store!.db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      sends: store!.db.prepare('SELECT * FROM host_sends ORDER BY id').all(),
      usage: store!.db.prepare('SELECT * FROM daily_usage ORDER BY utc_date, scope, resource, metric').all(),
      snapshots: store!.db.prepare('SELECT * FROM invocation_messages ORDER BY invocation_id, sequence_no').all(),
    });
    const before = preserved();
    expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 45n });
    store.close();
    store = undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      store = await SqliteStore.open(config);
      expect(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 45n });
      expect(store.db.prepare('PRAGMA table_info(model_calls)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'replay_input_json' })]),
      );
      expect(preserved()).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (attempt === 0) {
        const backups = (await readdir(config.paths.backups)).filter((name) => name.startsWith('pre-migration-'));
        expect(backups).toHaveLength(1);
        const backup = new Database(join(config.paths.backups, backups[0]!), { readonly: true, fileMustExist: true });
        try {
          backup.defaultSafeIntegers(true);
          expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
            version: 45n,
          });
          expect(backup.prepare('SELECT replay_input_json FROM model_calls LIMIT 1').get()).toEqual({
            replay_input_json: '{"version":2,"obsolete":true}',
          });
          expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
          backup.close();
        }
        store.close();
        store = undefined;
      }
    }
    purgeExpiredData(store!.orm, config, new Date('2026-12-31T00:00:00.000Z'));
    for (const table of [
      'invocations',
      'invocation_messages',
      'invocation_buckets',
      'model_calls',
      'tool_calls',
      'host_sends',
      'media',
      'message_revisions',
      'messages',
    ]) {
      expect(store!.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0n });
    }
    expect(() =>
      buildSceneContext(store!, config, seed.invocationA, {
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        toolDefinitionCharacters: 0,
      }),
    ).toThrow('does not exist');
    expect(store!.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('retention keeps a sender that is still a room participant, and releases local reply targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-retention-room-'));
  let store: SqliteStore | undefined;
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath);
    const { config } = await loadConfig(configPath);
    store = await SqliteStore.open(config);
    const db = store.db;

    // A virtual room whose only reason to exist after retention is membership.
    db.exec(`
      INSERT INTO chats (id, host_kind, type, title, updated_at)
        VALUES (50, 'playground', 'virtual', 'Playground', '2025-01-01T00:00:00.000Z');
      INSERT INTO senders (id, host_kind, display_name, is_bot, updated_at)
        VALUES (60, 'playground', 'Echo', 1, '2025-01-01T00:00:00.000Z'),
               (61, 'playground', 'Idle', 0, '2025-01-01T00:00:00.000Z'),
               (62, 'playground', 'Orphan', 0, '2025-01-01T00:00:00.000Z');
      INSERT INTO room_participants (chat_id, sender_id, joined_at)
        VALUES (50, 60, '2025-01-01T00:00:00.000Z'),
               (50, 61, '2025-01-01T00:00:00.000Z');
      INSERT INTO rooms (chat_id, created_at, updated_at)
        VALUES (50, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
        VALUES (150, 50, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, chat_id, host_kind, visible, sent_by_bot, telegram_date, received_at, local_sequence_no)
        VALUES (7000, 150, 50, 'playground', 1, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 1),
               (7001, 150, 50, 'playground', 1, 0, '2026-12-31T00:00:00.000Z', '2026-12-31T00:00:00.000Z', 2);
      INSERT INTO message_revisions (id, message_id, revision_no, sender_id, kind, text, created_at, raw_fragment_json)
        VALUES (8000, 7000, 1, 60, 'text', 'local', '2025-01-01T00:00:00.000Z', '{}'),
               (8001, 7001, 1, 60, 'text', 'reply', '2026-12-31T00:00:00.000Z', '{}');
      UPDATE messages SET current_revision_id = id + 1000;
      UPDATE messages SET local_reply_to_message_id = 7000 WHERE id = 7001;
    `);

    purgeExpiredData(store.orm, config, new Date('2026-12-31T00:00:00.000Z'));

    // The aged-out message goes, and surviving local replies are released
    // instead of blocking the delete.
    expect(db.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([{ id: 7001n }]);
    expect(db.prepare('SELECT local_reply_to_message_id AS r FROM messages WHERE id = 7001').get()).toEqual({
      r: null,
    });
    // A sender that only exists as a room participant survives the prune; one
    // with neither revisions nor membership still goes.
    expect(db.prepare('SELECT id FROM senders ORDER BY id').all()).toEqual([{ id: 60n }, { id: 61n }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM room_participants').get()).toEqual({ count: 2n });
    expect(db.prepare('SELECT COUNT(*) AS count FROM chats WHERE id = 50').get()).toEqual({ count: 1n });
    expect(db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE chat_id = 50').get()).toEqual({ count: 1n });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
