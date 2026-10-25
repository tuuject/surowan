import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BotCommandService } from '../../src/orchestration/bot-commands/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { ProactiveReplyGateOptions } from '../../src/orchestration/proactive-reply.ts';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { StartupCatchUpApi } from '../../src/startup-catch-up.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  type FixtureConfig,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  type TestContextOptions,
  type TestInvocationContext,
} from '../helpers.ts';

const directories: string[] = [];

export const FIRST_CHAT_ID = 123456789;
export const SECOND_CHAT_ID = 987654321;

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export function topicUpdate(
  updateId: number,
  messageId: number,
  chatId: number,
  threadId: number,
  date: number,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      is_topic_message: true,
      date,
      chat: { id: chatId, type: 'supergroup', title: `Chat ${chatId}`, is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `chat-${chatId}-message-${messageId}`,
    },
  };
}

export function textUpdate(updateId: number, messageId: number, senderId: number, chatId = FIRST_CHAT_ID): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: `Chat ${chatId}` },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

export function commandUpdate(
  updateId: number,
  messageId: number,
  token: string,
  options: { readonly chatId?: number; readonly senderId?: number } = {},
): Update {
  // A bot_command entity spans only the command token, never trailing arguments.
  const entityLength = token.includes(' ') ? token.indexOf(' ') : token.length;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: options.chatId ?? FIRST_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: options.senderId ?? 42, is_bot: false, first_name: 'Alice' },
      text: token,
      entities: [{ offset: 0, length: entityLength, type: 'bot_command' }],
    },
  };
}

export function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: FIRST_CHAT_ID, type: 'private', first_name: 'Owner' },
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

export function fakeApi(updates: readonly Update[]): StartupCatchUpApi {
  return {
    getUpdates: async (options) =>
      updates
        .filter((update) => options.offset === undefined || update.update_id >= options.offset)
        .slice(0, options.limit),
  };
}

export async function setup(
  twoChats: boolean,
  transform?: (config: FixtureConfig) => void,
  proactive?: ProactiveReplyGateOptions,
): Promise<{
  readonly store: SqliteStore;
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly commands: BotCommandService;
  readonly build: (invocationId: bigint, options?: TestContextOptions) => TestInvocationContext;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-startup-catch-up-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.agent!.history_messages = 10;
    if (twoChats) {
      config.telegram.chats.push({
        id: SECOND_CHAT_ID,
        instructions_file: 'chat-instructions.md',
      });
    }
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(
    store,
    configStore,
    async () => ({
      state: 'completed',
      reason: 'done',
    }),
    undefined,
    undefined,
    proactive,
  );
  return {
    store,
    loaded,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
    build: (invocationId: bigint, options: TestContextOptions = {}) =>
      renderInvocationContext(store, loaded.config, invocationId, options),
  };
}

export function fixedClock(): () => Date {
  let milliseconds = Date.parse('2026-08-17T03:00:00.000Z');
  return () => new Date(milliseconds++);
}
