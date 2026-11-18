/**
 * Small SQLite seeds for the im/ contract tests: a real store, a Telegram chat
 * with one conversation row, and the escape hatch that writes a `host_kind` no
 * schema CHECK would allow, so strict parsing is exercised end to end.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { loadConfig, type LoadedConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { afterThisTest, trackTempDirectory, writeTestConfig } from '../helpers.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterAll(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

/** A fresh store plus the configuration it was opened with. */
export async function openTestStore(): Promise<{
  store: SqliteStore;
  config: LoadedConfig['config'];
  loaded: LoadedConfig;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-im-'));
  trackTempDirectory(directories, directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  afterThisTest(
    () => {
      store.close();
    },
    () => {
      stores.push(store);
    },
  );
  return { store, config: loaded.config, loaded };
}

const TIMESTAMP = '2025-01-01T00:00:00.000Z';

/**
 * One Telegram chat row plus one conversation row. `threadId` binds as a
 * bigint, so ids past 2^53 reach the stored column exactly.
 */
export function seedTelegramConversation(
  store: SqliteStore,
  input: {
    readonly chatId?: bigint;
    readonly conversationId?: bigint;
    readonly telegramChatId?: bigint;
    readonly threadId?: bigint;
    readonly type?: string;
  } = {},
): { chatId: bigint; conversationId: bigint } {
  const chatId = input.chatId ?? 1n;
  const telegramChatId = input.telegramChatId ?? 123456789n;
  store.db
    .prepare(
      `INSERT INTO chats(id, host_kind, host_chat_id, canonical_chat_id, type, updated_at)
       VALUES (?, 'telegram', ?, ?, ?, ?)`,
    )
    .run(chatId, telegramChatId, telegramChatId, input.type ?? 'supergroup', TIMESTAMP);
  const conversationId = input.conversationId ?? 200n;
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(conversationId, chatId, input.threadId ?? 0n, TIMESTAMP, TIMESTAMP);
  return { chatId, conversationId };
}

/**
 * One Playground chat row plus one conversation row. The chats CHECK demands
 * both Telegram identity columns be NULL for a room.
 */
export function seedPlaygroundConversation(
  store: SqliteStore,
  input: {
    readonly chatId?: bigint;
    readonly conversationId?: bigint;
  } = {},
): { chatId: bigint; conversationId: bigint } {
  const chatId = input.chatId ?? 1n;
  store.db
    .prepare(
      `INSERT INTO chats(id, host_kind, host_chat_id, canonical_chat_id, type, updated_at)
       VALUES (?, 'playground', NULL, NULL, 'group', ?)`,
    )
    .run(chatId, TIMESTAMP);
  const conversationId = input.conversationId ?? 300n;
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(conversationId, chatId, TIMESTAMP, TIMESTAMP);
  return { chatId, conversationId };
}

/** One completed bucket carrying one invocation row in `state`. */
export function seedInvocation(
  store: SqliteStore,
  invocationId: bigint,
  conversationId: bigint,
  state = 'running',
): void {
  store.db
    .prepare(
      `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?)`,
    )
    .run(invocationId, conversationId, TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP);
  store.db
    .prepare(
      `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
       VALUES (?, ?, ?, ?, 'h', 1, ?)`,
    )
    .run(invocationId, invocationId, conversationId, state, TIMESTAMP);
}

/**
 * Writes a `host_kind` the chats CHECK constraint normally forbids, then
 * restores enforcement. The row keeps its Telegram identity on purpose: the
 * defect this guards is an unknown kind being read as Telegram, not a missing
 * identity.
 */
export function corruptHostKind(store: SqliteStore, chatId: bigint, kind = 'discord'): void {
  store.db.exec('PRAGMA ignore_check_constraints = ON');
  try {
    store.db.prepare('UPDATE chats SET host_kind = ? WHERE id = ?').run(kind, chatId);
  } finally {
    store.db.exec('PRAGMA ignore_check_constraints = OFF');
  }
}

/**
 * One stored media row under `messageId`'s revision. `media.host_kind` carries
 * no CHECK constraint by design, so an unknown kind inserts directly.
 */
export function seedMedia(
  store: SqliteStore,
  input: {
    readonly mediaId: bigint;
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly hostKind?: string;
  },
): bigint {
  const message = store.db
    .prepare(
      `INSERT INTO messages(conversation_id, chat_id, host_kind, message_no, sent_at, received_at)
       VALUES (?, ?, 'telegram', 1, ?, ?)`,
    )
    .run(input.conversationId, input.chatId, TIMESTAMP, TIMESTAMP);
  const revision = store.db
    .prepare(
      `INSERT INTO message_revisions(message_id, revision_no, kind, created_at, raw_fragment_json)
       VALUES (?, 1, 'text', ?, '{}')`,
    )
    .run(message.lastInsertRowid, TIMESTAMP);
  store.db
    .prepare(
      `INSERT INTO media(id, revision_id, kind, file_id, file_unique_id, telegram_json, host_kind)
       VALUES (?, ?, 'photo', 'file-1', 'unique-1', '{}', ?)`,
    )
    .run(input.mediaId, revision.lastInsertRowid, input.hostKind ?? 'telegram');
  return input.mediaId;
}
