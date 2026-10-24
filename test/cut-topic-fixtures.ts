import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/** Temp directories created by the cut_topic tests; cleaned once per test file. */
export const directories: string[] = [];
export const ALICE = { id: 42n, name: 'Alice', username: 'alice' };
export const FIRST_CHAT = 123456789n;
export const SECOND_CHAT = 987654321n;
export const BUCKET_WINDOW_MS = 15_000;

export async function cleanupCutTopicDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export function groupUpdate(updateId: number, messageId: number, text: string, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function commandUpdate(updateId: number, messageId: number, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/cut_topic',
      entities: [{ offset: 0, length: 10, type: 'bot_command' }],
    },
  };
}

export function forumUpdate(updateId: number, messageId: number, text: string, threadId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(FIRST_CHAT), type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      message_thread_id: threadId,
      is_topic_message: true,
      text,
    },
  } as Update;
}

export async function setup(): Promise<{
  loaded: LoadedConfig;
  configStore: RuntimeConfigurationStore;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  commands: BotCommandService;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-cut-topic-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.id = Number(FIRST_CHAT);
      config.telegram.chats.push({
        id: Number(SECOND_CHAT),
        instructions_file: 'chat-instructions.md',
      });
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  return {
    loaded,
    configStore,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999, username: 'surowan_test_bot' }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
  };
}

export function completeInvocation(store: SqliteStore, invocationId: bigint, at: Date): void {
  store.db
    .prepare("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
    .run(new Date(at.getTime() - 1_000).toISOString(), at.toISOString(), invocationId);
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
}

export function chatOfInvocation(store: SqliteStore, invocationId: bigint): bigint | undefined {
  return store.db
    .prepare<[bigint], { chat_id: bigint }>(
      'SELECT c.telegram_chat_id AS chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id WHERE i.id = ?',
    )
    .get(invocationId)?.chat_id;
}

/**
 * Queues and completes every due bucket (mirroring the runtime pacing), then
 * ingests the trigger message, runs its invocation to completion and returns
 * the frozen history texts of that invocation.
 */
export function invocationHistory(
  store: SqliteStore,
  ingestion: TelegramIngestion,
  scheduler: BucketScheduler,
  chatId: bigint,
  updateId: number,
  messageId: number,
  text: string,
  at: Date,
): string[] {
  const flushAt = new Date(at.getTime() - 1);
  for (const invocationId of scheduler.processDue(flushAt)) {
    completeInvocation(store, invocationId, flushAt);
  }
  ingestion.ingest(groupUpdate(updateId, messageId, text, chatId), at);
  const queued = scheduler.processDue(new Date(at.getTime() + BUCKET_WINDOW_MS + 1_000));
  if (queued.length === 0) {
    throw new Error(`Expected a queued invocation for chat ${chatId}`);
  }
  let invocationId: bigint | undefined;
  for (const id of queued) {
    completeInvocation(store, id, new Date(at.getTime() + BUCKET_WINDOW_MS + 2_000));
    if (chatOfInvocation(store, id) === chatId) {
      invocationId = id;
    }
  }
  if (invocationId === undefined) {
    throw new Error(`No queued invocation found for chat ${chatId}`);
  }
  return store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no",
    )
    .all(invocationId)
    .map((row) => (JSON.parse(row.snapshot_json) as { text: string | null }).text ?? '');
}
