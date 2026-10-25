import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';

const stores: SqliteStore[] = [];
export const directories: string[] = [];

export async function cleanupTestDirectories(): Promise<void> {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of directories.splice(0)) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function initDb(): Promise<{ store: SqliteStore; conversationId: bigint; roomConversationId: bigint }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-lt-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const { config } = await loadConfig(configPath);
  const store = await SqliteStore.open(config);
  stores.push(store);

  const chatId = 1n;
  store.db
    .prepare(
      `INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at)
     VALUES (?, 123, 123, 'private', '2025-01-01T00:00:00.000Z')`,
    )
    .run(chatId);
  const conversationId = 200n;
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
     VALUES (?, ?, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    )
    .run(conversationId, chatId);

  // A room conversation, for the host-scoped timer path.
  const roomChatId = 2n;
  store.db
    .prepare(
      `INSERT INTO chats(id, host_kind, telegram_chat_id, canonical_chat_id, type, updated_at)
     VALUES (?, 'playground', NULL, NULL, 'group', '2025-01-01T00:00:00.000Z')`,
    )
    .run(roomChatId);
  const roomConversationId = 201n;
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
     VALUES (?, ?, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    )
    .run(roomConversationId, roomChatId);

  return { store, conversationId, roomConversationId };
}

export function seedInvocation(store: SqliteStore, invId: bigint, convId: bigint): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
     VALUES (?, ?, 'completed', 'realtime', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    )
    .run(invId, convId);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
     VALUES (?, ?, ?, 'completed', 'h', 1, '2025-01-01T00:00:00.000Z')`,
    )
    .run(invId, invId, convId);
}

export function ctx(convId: bigint, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    ...previewContext(),
    invocationId: 100n,
    conversationId: convId,
    callerUserId: 42n,
    ...overrides,
  };
}
