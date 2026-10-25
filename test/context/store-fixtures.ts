import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';

/** Temp directories created by the context store tests; cleaned once per test file. */
export const directories: string[] = [];

export async function cleanupContextStoreDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export async function fixture(): Promise<{ store: SqliteStore; loaded: Awaited<ReturnType<typeof loadConfig>> }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-context-store-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  store.db
    .prepare(
      "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, 1, 'private', '2026-08-15T00:00:00.000Z')",
    )
    .run();
  store.db
    .prepare(
      "INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES ((SELECT id FROM chats LIMIT 1), 0, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO messages(conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at)
       VALUES ((SELECT id FROM conversations LIMIT 1), (SELECT id FROM chats LIMIT 1), 1, 1, 0, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`,
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO message_revisions(message_id, revision_no, kind, created_at, raw_fragment_json)
       VALUES ((SELECT id FROM messages LIMIT 1), 1, 'photo', '2026-08-15T00:00:00.000Z', '{}')`,
    )
    .run();
  for (const [fileId, fileUniqueId] of [
    ['file-1', 'unique-1'],
    ['file-2', 'unique-2'],
  ] as const) {
    store.db
      .prepare(
        `INSERT INTO media(revision_id, kind, file_id, file_unique_id, mime_type, telegram_json)
         VALUES ((SELECT id FROM message_revisions LIMIT 1), 'photo', ?, ?, 'image/jpeg', '{}')`,
      )
      .run(fileId, fileUniqueId);
  }
  return { store, loaded };
}

export function mediaId(store: SqliteStore, index: number): bigint {
  const rows = store.db.prepare<[], { id: bigint }>('SELECT id FROM media ORDER BY id').all();
  const row = rows[index];
  if (row === undefined) {
    throw new Error('Fixture has no media row');
  }
  return row.id;
}

export function conversationId(store: SqliteStore): bigint {
  const row = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1').get();
  if (row === undefined) {
    throw new Error('Fixture has no conversation');
  }
  return row.id;
}

export function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'agent',
    model: 'agent-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  };
}
