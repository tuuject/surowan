import { vi, type Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';

import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

export const GROUP_A = -1_001_234_567_890;
export const GROUP_B = -1_001_234_567_891;
export const PRIVATE = 123_456_789;
export const BOT_ID = 999;
export const BOT_USERNAME = 'SurowanBot';
export const WINDOW_MS = 15_000;
export const START = new Date('2026-08-15T00:00:00.000Z');

/** Restore spies and delete every temp directory created by {@link setup}. */
export async function resetHarness(): Promise<void> {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export type LooseFields = Record<string, unknown>;

export interface Harness {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly random: Mock<() => number>;
}

export async function setup(
  options: {
    readonly transform?: (config: FixtureConfig) => void;
    readonly random?: () => number;
    readonly twoGroups?: boolean;
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-proactive-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.bucket_window_seconds = 15;
    config.telegram.chats = [
      { id: GROUP_A, instructions_file: 'chat-instructions.md' },
      ...(options.twoGroups === true ? [{ id: GROUP_B, instructions_file: 'chat-instructions.md' }] : []),
    ];
    options.transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const random = vi.fn(options.random ?? (() => 0.99));
  const scheduler = new BucketScheduler(
    store,
    configStore,
    async () => ({ state: 'completed', reason: 'done' }),
    undefined,
    undefined,
    { bot: { id: BigInt(BOT_ID), username: BOT_USERNAME }, random },
  );
  return {
    store,
    loaded,
    configStore,
    ingestion: new TelegramIngestion(store, configStore, { id: BOT_ID, username: BOT_USERNAME }),
    scheduler,
    random,
  };
}

export function groupMessage(updateId: number, messageId: number, fields: LooseFields = {}, chatId = GROUP_A): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `message ${messageId}`,
      ...fields,
    },
  } as unknown as Update;
}

export function privateMessage(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: PRIVATE, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `private ${messageId}`,
    },
  } as unknown as Update;
}

export function commandUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/status',
      entities: [{ offset: 0, length: 7, type: 'bot_command' }],
    },
  } as unknown as Update;
}

export function mentionFields(): LooseFields {
  return {
    text: `@${BOT_USERNAME} ping`,
    entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
  };
}

export function replyFields(): LooseFields {
  return {
    text: 'replying to you',
    reply_to_message: {
      message_id: 900,
      date: 1_700_000_000,
      chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
      from: { id: BOT_ID, is_bot: true, first_name: 'Surowan' },
      text: 'earlier',
    },
  };
}

export type ProactiveReplyFixture = {
  enabled: boolean;
  base_probability: number;
  increment: number;
  hard_pity: number;
};

export function enabled(overrides: Partial<ProactiveReplyFixture> = {}): ProactiveReplyFixture {
  return {
    enabled: true,
    base_probability: 0.2,
    increment: 0.1,
    hard_pity: 8,
    ...overrides,
  };
}

export function invocationCount(store: SqliteStore): number {
  return Number(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count ?? 0n,
  );
}

export function state(store: SqliteStore): { misses: bigint; fingerprint: string } | undefined {
  return store.db
    .prepare<[], { misses: bigint; fingerprint: string }>(
      'SELECT consecutive_misses AS misses, settings_fingerprint AS fingerprint FROM proactive_reply_state',
    )
    .get();
}

function logEvents(
  log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  eventName: string,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const call of log.mock.calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(call[0]));
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const event = parsed as Record<string, unknown>;
      if (event.event === eventName) {
        events.push(event);
      }
    }
  }
  return events;
}

export function sampledEvents(log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  return logEvents(log, 'agent_proactive_reply_sampled');
}

export function bypassedEvents(log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  return logEvents(log, 'agent_proactive_reply_bypassed');
}

/** Ingest one message and run the due pass for its window. */
export function attempt(
  harness: Harness,
  update: Update,
  receivedAt: Date,
): { bucketId: bigint | undefined; invocations: readonly bigint[] } {
  const { bucketId } = harness.ingestion.ingest(update, receivedAt);
  return {
    bucketId,
    invocations: harness.scheduler.processDue(new Date(receivedAt.getTime() + WINDOW_MS)),
  };
}
