import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Update } from 'grammy/types';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';

import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

export const BOT_USERNAME = 'surowan_test_bot';
export const ALICE: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
export const FIXED_NOW = new Date('2026-08-15T12:00:00.000Z');

export type ConfigTransform = (config: FixtureConfig) => void;

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export async function setup(
  transform: ConfigTransform = (config) => {
    config.telegram.admins = [42];
  },
  handler: ConstructorParameters<typeof BucketScheduler>[2] = async () => ({ state: 'completed', reason: 'done' }),
): Promise<{
  loaded: LoadedConfig;
  configStore: RuntimeConfigurationStore;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  commands: BotCommandService;
  configPath: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-commands-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, handler);
  return {
    loaded,
    configStore,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999, username: BOT_USERNAME }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
    configPath,
    directory,
  };
}

export function commandUpdate(updateId: number, messageId: number, token: string, chatId = 123456789): Update {
  // A bot_command entity spans only the command token (mention included),
  // never the trailing argument text.
  const entityLength = token.includes(' ') ? token.indexOf(' ') : token.length;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: token,
      entities: [{ offset: 0, length: entityLength, type: 'bot_command' }],
    },
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

export function message(message: Update['message']): Message {
  return message!;
}
