import { afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';

import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export async function setup(
  transform?: (config: FixtureConfig) => void,
  botUsername?: string,
): Promise<{ store: SqliteStore; ingestion: TelegramIngestion }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-ingest-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const { config } = loaded;
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(config);
  return {
    store,
    ingestion: new TelegramIngestion(store, configStore, {
      id: 999,
      ...(botUsername === undefined ? {} : { username: botUsername }),
    }),
  };
}

export function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function groupTextUpdate(updateId: number, messageId: number, senderId: number, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'supergroup', title: 'Group' },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

export function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      sticker: {
        file_id: `sticker-${messageId}`,
        file_unique_id: `sticker-unique-${messageId}`,
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
}
