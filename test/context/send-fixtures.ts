import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import type { RawConfig } from '../../src/platform/config/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import {
  renderInvocationContext,
  testConfigStore,
  writeTestConfig,
  type TestContextOptions,
  type TestInvocationContext,
} from '../helpers.ts';

const directories: string[] = [];

export async function cleanupFixtureDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export async function fixtureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export async function setup(): Promise<{
  store: SqliteStore;
  config: RawConfig;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  build: (invocationId: bigint, options?: TestContextOptions) => TestInvocationContext;
}> {
  const directory = await fixtureDirectory('surowan-context-');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    build: (invocationId: bigint, options: TestContextOptions = {}) =>
      renderInvocationContext(store, loaded.config, invocationId, options),
  };
}

export function update(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}
