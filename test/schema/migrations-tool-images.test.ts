import { afterAll, expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { decodeContextMessage } from '../../src/context/codec.ts';
import { contextMessages, toolCalls } from '../../src/store/schema/index.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { cleanupSchemaDirectories, openStore } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

const ASSET = 'b'.repeat(32);
const MARKER = `[image ${ASSET}]`;

/**
 * 051 renames the MCP-only reference key and marker to the tool-wide ones. A
 * row written by 050 must keep projecting its pixels after the upgrade: if the
 * key or the marker were left alone, the image would silently disappear from
 * every replayed context and its asset would look unreferenced to the sweep.
 */
test('migration 051 keeps version-050 MCP image references projectable', async () => {
  const { store, loaded } = await openStore();
  const seed = seedAdminFixture(store);
  const legacyDetails = {
    server: 'local',
    tool: 'images',
    mcpImages: {
      version: 1,
      items: [{ contentIndex: 1, assetId: ASSET, mimeType: 'image/png', byteSize: 10, width: 2, height: 2 }],
    },
  };
  const legacyContent = {
    content: [
      { type: 'text', text: 'before' },
      { type: 'text', text: `[MCP image ${ASSET}]` },
    ],
  };
  const legacy = {
    role: 'toolResult',
    toolCallId: 'old_mcp_image',
    toolName: 'local__images',
    ...legacyContent,
    details: legacyDetails,
    isError: false,
    timestamp: 1,
  };
  store.orm
    .insert(contextMessages)
    .values({
      contextId: seed.contextId,
      seq: 6n,
      role: 'toolResult',
      payloadJson: JSON.stringify(legacy),
      invocationId: seed.invocationA,
      isCheckpoint: false,
      estTokens: 10n,
      createdAt: '2026-01-01',
    })
    .run();
  store.orm
    .insert(toolCalls)
    .values({
      invocationId: seed.invocationA,
      toolCallId: 'old_mcp_image',
      toolName: 'local__images',
      argumentsJson: '{}',
      state: 'success',
      sideEffect: false,
      resultContentJson: JSON.stringify({ ...legacyContent, details: legacyDetails }),
      createdAt: '2026-01-01',
    })
    .run();
  store.db.exec('DELETE FROM schema_migrations WHERE version = 51');
  store.close();

  const reopened = await SqliteStore.open(loaded.config);
  try {
    const row = reopened.db
      .prepare<[bigint, bigint], { payload_json: string }>(
        'SELECT payload_json FROM context_messages WHERE context_id = ? AND seq = ?',
      )
      .get(seed.contextId, 6n);
    if (row === undefined) {
      throw new Error('Missing context message row');
    }
    const decoded = decodeContextMessage(row.payload_json);
    expect(decoded).toEqual({
      ...legacy,
      content: [
        { type: 'text', text: 'before' },
        { type: 'text', text: MARKER },
      ],
      details: { server: 'local', tool: 'images', toolImages: legacyDetails.mcpImages },
    });
    const audit = reopened.db
      .prepare<[string], { result_content_json: string }>(
        'SELECT result_content_json FROM tool_calls WHERE tool_call_id = ?',
      )
      .get('old_mcp_image');
    if (audit === undefined) {
      throw new Error('Missing tool audit row');
    }
    expect(JSON.parse(audit.result_content_json)).toEqual({
      ...legacyContent,
      content: [
        { type: 'text', text: 'before' },
        { type: 'text', text: MARKER },
      ],
      details: { server: 'local', tool: 'images', toolImages: legacyDetails.mcpImages },
    });
    expect(reopened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    reopened.close();
  }
});
