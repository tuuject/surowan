import { afterAll, expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { decodeContextMessage } from '../../src/context/codec.ts';
import { contextMessages, playgroundAssets } from '../../src/store/schema/index.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { cleanupSchemaDirectories, openStore } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

test('migration 049 preserves version-048 text history, tool audit and local images', async () => {
  const { store, loaded } = await openStore();
  const seed = seedAdminFixture(store);
  const legacy = {
    role: 'toolResult',
    toolCallId: 'old_mcp',
    toolName: 'local__echo',
    content: [{ type: 'text', text: 'old MCP text' }],
    isError: false,
    timestamp: 1,
  };
  store.orm
    .insert(contextMessages)
    .values({
      contextId: seed.contextId,
      seq: 5n,
      role: 'toolResult',
      payloadJson: JSON.stringify(legacy),
      invocationId: seed.invocationA,
      isCheckpoint: false,
      estTokens: 10n,
      createdAt: '2026-01-01',
    })
    .run();
  store.orm
    .insert(playgroundAssets)
    .values({
      id: 'a'.repeat(32),
      chatId: seed.chatId,
      sha256: 'old-hash',
      mime: 'image/png',
      byteSize: 123n,
      width: 10n,
      height: 10n,
      storagePath: 'old.png',
      state: 'attached',
      createdAt: '2026-01-01',
    })
    .run();
  const before = store.db.prepare('SELECT tool_call_id, result_text FROM tool_calls ORDER BY id').all();
  store.db.exec(`
    ALTER TABLE tool_calls DROP COLUMN result_content_json;
    ALTER TABLE agent_messages DROP COLUMN tool_call_id;
    ALTER TABLE playground_assets DROP COLUMN last_used_at;
    DELETE FROM schema_migrations WHERE version = 49;
  `);
  store.close();
  const reopened = await SqliteStore.open(loaded.config);
  try {
    expect(reopened.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 49n,
    });
    expect(reopened.db.prepare('SELECT tool_call_id, result_text FROM tool_calls ORDER BY id').all()).toEqual(before);
    const row = reopened.db
      .prepare<[bigint, bigint], { payload_json: string }>(
        'SELECT payload_json FROM context_messages WHERE context_id = ? AND seq = ?',
      )
      .get(seed.contextId, 5n)!;
    expect(decodeContextMessage(row.payload_json)).toEqual(legacy);
    expect(reopened.db.prepare('SELECT storage_path, last_used_at FROM playground_assets').get()).toEqual({
      storage_path: 'old.png',
      last_used_at: null,
    });
    expect(reopened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    reopened.close();
  }
});
