import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import type { FileConfig } from '../src/platform/config.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/** Temp directories created by the bucket-scheduler tests; cleaned once per test file. */
export const directories: string[] = [];

export async function cleanupSchedulerDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export async function setup(
  transform?: (config: FileConfig) => void,
  handler: ConstructorParameters<typeof BucketScheduler>[2] = async () => ({ state: 'completed', reason: 'done' }),
): Promise<{
  loaded: LoadedConfig;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-scheduler-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, transform);
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return {
    loaded,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, handler),
  };
}

export function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function topicUpdate(updateId: number, messageId: number, threadId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      is_topic_message: true,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}
