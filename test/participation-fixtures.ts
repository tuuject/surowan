import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

export const directories: string[] = [];

export const GROUP_CHAT_ID = -1_001_234_567_890;
export const PRIVATE_CHAT_ID = 123_456_789;
export const BOT_ID = 999;
export const BOT_USERNAME = 'SurowanBot';
export const BOT_IDENTITY = { id: BigInt(BOT_ID), username: BOT_USERNAME };

// 2026-08-15 is a Saturday; 10:00 UTC is inside 09:00-12:00 and 13:00 is not.
export const INSIDE_PERIOD = new Date('2026-08-15T10:00:00.000Z');
export const OUTSIDE_PERIOD = new Date('2026-08-15T13:00:00.000Z');

export const DAY_WINDOW = { start: '09:00', end: '12:00' };

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

type ParticipationOptions = NonNullable<FileConfig['telegram']['participation']>;

export interface Harness {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly commands: BotCommandService;
}

export async function setup(
  options: {
    readonly global?: ParticipationOptions;
    readonly chat?: ParticipationOptions;
    readonly timezone?: string;
    readonly chatId?: number;
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-participation-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats = [
      {
        id: options.chatId ?? GROUP_CHAT_ID,
        instructions_file: 'chat-instructions.md',
        ...(options.chat === undefined ? {} : { participation: options.chat }),
      },
    ];
    if (options.global !== undefined) {
      config.telegram.participation = options.global;
    }
    if (options.timezone !== undefined) {
      config.timezone = options.timezone;
    }
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  return {
    store,
    config: loaded.config,
    configStore,
    ingestion: new TelegramIngestion(store, configStore, { id: BOT_ID, username: BOT_USERNAME }),
    scheduler,
    commands: new BotCommandService(store, configStore, scheduler),
  };
}

// Fixtures build only the subset of a Telegram message the ingestion boundary
// reads, so the message is widened once instead of restating the full union.
export type LooseFields = Record<string, unknown>;

export function groupMessage(updateId: number, messageId: number, fields: LooseFields = {}): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      ...fields,
    },
  } as unknown as Update;
}

export function privateMessage(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: PRIVATE_CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  } as unknown as Update;
}

export function mentionText(): LooseFields {
  return {
    text: `@${BOT_USERNAME} ping`,
    entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
  };
}

export function replyFields(fromId: number, isBot: boolean): LooseFields {
  return {
    text: 'replying',
    reply_to_message: {
      message_id: 900,
      date: 1_700_000_000,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: fromId, is_bot: isBot, first_name: 'Replied' },
      text: 'earlier',
    },
  };
}

export function editedGroupMessage(updateId: number, messageId: number, editDate: number, fields: LooseFields): Update {
  return {
    update_id: updateId,
    edited_message: {
      message_id: messageId,
      date: 1_700_000_000,
      edit_date: editDate,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      ...fields,
    },
  } as unknown as Update;
}

export function bucketCount(store: SqliteStore): bigint {
  return store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count ?? -1n;
}

export function bucketMessages(store: SqliteStore): bigint {
  return store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count ?? -1n;
}

export function attention(store: SqliteStore): { expiresAt: string; triggerKind: string } | null {
  const row = store.db
    .prepare<[], { expires_at: string; trigger_kind: string }>(
      'SELECT expires_at, trigger_kind FROM conversation_attention',
    )
    .get();
  return row === undefined ? null : { expiresAt: row.expires_at, triggerKind: row.trigger_kind };
}
