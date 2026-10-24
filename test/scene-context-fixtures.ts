import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { SceneContextOptions } from '../src/context/scene-context.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { messageRevisions, messages, senders } from '../src/store/schema.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

/** Removes every temp directory the fixture created in this module instance. */
export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export const GROUP_CHAT = 111000111n;
export const FORUM_CHAT = 222000222n;
export const TOPIC_A = 100n;
export const TOPIC_B = 200n;
const BOT_ID = 999n;
const BOT_USERNAME = 'surowan_test';
export const START = new Date('2026-08-15T00:00:00.000Z');
export const DEFAULT_OPTIONS: SceneContextOptions = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  toolDefinitionCharacters: 0,
};

export interface Person {
  readonly id: number;
  readonly name: string;
  readonly username: string;
}

export const ALICE: Person = { id: 42, name: 'Alice', username: 'alice' };
export const BOB: Person = { id: 77, name: 'Bob', username: 'bob' };

export const at = (seconds: number): Date => new Date(START.getTime() + seconds * 1_000);

export interface Fixture {
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
  readonly configStore: RuntimeConfigurationStore;
  readonly store: SqliteStore;
  readonly scheduler: BucketScheduler;
  readonly ingestion: TelegramIngestion;
}

export async function setup(tune?: (config: FixtureConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-scene-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('fixture: expected the default chat');
      }
      chat.id = Number(GROUP_CHAT);
      config.telegram.chats.push({
        id: Number(FORUM_CHAT),
        topic_ids: [Number(TOPIC_A), Number(TOPIC_B)],
        instructions_file: 'chat-instructions.md',
      });
      tune?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const ingestion = new TelegramIngestion(store, configStore, { id: Number(BOT_ID), username: BOT_USERNAME });
  return { loaded, configStore, store, scheduler, ingestion };
}

interface MessageOptions {
  readonly chatId?: bigint;
  readonly from?: Person;
  readonly replyTo?: { readonly messageId: number; readonly text: string; readonly from?: Person };
}

export function telegramMessage(
  chatId: bigint,
  messageId: number,
  seconds: number,
  from: Person,
): Record<string, unknown> {
  return {
    message_id: messageId,
    date: Math.floor(at(seconds).getTime() / 1_000),
    chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
    from: { id: from.id, is_bot: false, first_name: from.name, username: from.username },
  };
}

export function groupUpdate(
  updateId: number,
  messageId: number,
  text: string,
  seconds: number,
  options: MessageOptions = {},
): Update {
  const chatId = options.chatId ?? GROUP_CHAT;
  const from = options.from ?? ALICE;
  const message: Record<string, unknown> = { ...telegramMessage(chatId, messageId, seconds, from), text };
  if (options.replyTo !== undefined) {
    const replyFrom = options.replyTo.from ?? ALICE;
    message.reply_to_message = {
      ...telegramMessage(chatId, options.replyTo.messageId, seconds, replyFrom),
      text: options.replyTo.text,
    };
  }
  return { update_id: updateId, message } as unknown as Update;
}

export function editUpdate(
  updateId: number,
  messageId: number,
  text: string,
  seconds: number,
  options: MessageOptions = {},
): Update {
  const chatId = options.chatId ?? GROUP_CHAT;
  const from = options.from ?? ALICE;
  return {
    update_id: updateId,
    edited_message: { ...telegramMessage(chatId, messageId, seconds, from), text },
  } as unknown as Update;
}

export function forumUpdate(
  updateId: number,
  messageId: number,
  text: string,
  threadId: bigint,
  seconds: number,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(at(seconds).getTime() / 1_000),
      chat: { id: Number(FORUM_CHAT), type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: ALICE.id, is_bot: false, first_name: ALICE.name, username: ALICE.username },
      message_thread_id: Number(threadId),
      is_topic_message: true,
      text,
    },
  } as Update;
}

export function photoUpdate(updateId: number, messageId: number, caption: string, seconds: number): Update {
  return {
    update_id: updateId,
    message: {
      ...telegramMessage(GROUP_CHAT, messageId, seconds, ALICE),
      caption,
      photo: [{ file_id: `file-${messageId}`, file_unique_id: `unique-${messageId}`, width: 800, height: 600 }],
    },
  } as unknown as Update;
}

export function conversationIdOf(store: SqliteStore, chatId: bigint, threadId: bigint): bigint {
  const row = store.orm
    .all<{ id: bigint }>(
      sql`SELECT v.id FROM conversations v JOIN chats c ON c.id = v.chat_id
          WHERE c.telegram_chat_id = ${chatId} AND v.message_thread_id = ${threadId}`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error(`fixture: no conversation for chat ${chatId} thread ${threadId}`);
  }
  return row.id;
}

export function latestInvocation(store: SqliteStore, conversationId: bigint): bigint {
  const row = store.orm
    .all<{ id: bigint }>(
      sql`SELECT id FROM invocations WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 1`,
    )
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: no invocation was queued');
  }
  return row.id;
}

/**
 * Queues every due bucket and completes its invocation immediately, so the
 * next batch of the same chat can open its own invocation (a queued invocation
 * blocks further queuing by design).
 */
export function flush(fixture: Fixture, seconds: number): void {
  const { store, scheduler } = fixture;
  for (const invocationId of scheduler.processDue(at(seconds))) {
    store.db
      .prepare("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
      .run(at(seconds - 1).toISOString(), at(seconds).toISOString(), invocationId);
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(invocationId);
  }
}

export function invocationBucket(store: SqliteStore, invocationId: bigint): bigint {
  const row = store.orm
    .all<{ bucket_id: bigint }>(sql`SELECT bucket_id FROM invocations WHERE id = ${invocationId}`)
    .at(0);
  if (row === undefined) {
    throw new Error('fixture: invocation has no bucket');
  }
  return row.bucket_id;
}

/** The chat's internal row ID, as `messages` references it. */
export function chatRowId(store: SqliteStore, chatId: bigint): bigint {
  const row = store.orm.all<{ id: bigint }>(sql`SELECT id FROM chats WHERE telegram_chat_id = ${chatId}`).at(0);
  if (row === undefined) {
    throw new Error(`fixture: chat ${chatId} was never stored`);
  }
  return row.id;
}

/** Inserts a stored message the way a send or a fixture would; no bucket, no snapshot. */
export function insertRawMessage(
  fixture: Fixture,
  input: {
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly telegramMessageId: bigint;
    readonly seconds: number;
    readonly text: string | null;
    readonly sentByBot?: boolean;
    /** `null` creates no revision at all; a later date puts the only revision past the cutoff. */
    readonly revisionSeconds?: number | null;
  },
): bigint {
  const { store } = fixture;
  const senderId = input.sentByBot === true ? botSenderId(fixture) : null;
  const receivedAt = at(input.seconds).toISOString();
  const created = store.orm
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      chatId: input.chatId,
      telegramMessageId: input.telegramMessageId,
      visible: true,
      sentByBot: input.sentByBot ?? false,
      telegramDate: receivedAt,
      receivedAt,
    })
    .returning({ id: messages.id })
    .get();
  if (created === undefined) {
    throw new Error('fixture: messages insert returned no row');
  }
  const revisionSeconds = input.revisionSeconds === undefined ? input.seconds : input.revisionSeconds;
  if (revisionSeconds !== null) {
    const revision = store.orm
      .insert(messageRevisions)
      .values({
        messageId: created.id,
        revisionNo: 1n,
        senderId,
        kind: 'text',
        text: input.text,
        caption: null,
        replyToMessageId: null,
        createdAt: at(revisionSeconds).toISOString(),
        rawFragmentJson: '{}',
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('fixture: revision insert returned no row');
    }
    store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, created.id)).run();
  }
  return created.id;
}

function botSenderId(fixture: Fixture): bigint {
  const { store } = fixture;
  store.orm
    .insert(senders)
    .values({
      telegramType: 'user',
      telegramId: BOT_ID,
      displayName: 'Surowan',
      username: BOT_USERNAME,
      isBot: true,
      updatedAt: at(0).toISOString(),
    })
    .onConflictDoNothing()
    .run();
  const row = store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(and(eq(senders.telegramType, 'user'), eq(senders.telegramId, BOT_ID)))
    .get();
  if (row === undefined) {
    throw new Error('fixture: bot sender row is missing');
  }
  return row.id;
}

/** The scene configuration: current `config.jsonc` with an optional test-only mutation. */
export function sceneConfig(fixture: Fixture, mutate?: (config: RawConfig) => void): RawConfig {
  const config = structuredClone(fixture.loaded.config);
  mutate?.(config);
  return config;
}

export function chatConfigOf(config: RawConfig, chatId: bigint): RawConfig['telegram']['chats'][number] {
  const chat = config.telegram.chats.find((entry) => BigInt(entry.id) === chatId);
  if (chat === undefined) {
    throw new Error(`fixture: chat ${chatId} is not in the configuration`);
  }
  return chat;
}

export function invocationMessagesJson(store: SqliteStore, invocationId: bigint): string[] {
  return store.orm
    .all<{ snapshot_json: string }>(
      sql`SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ${invocationId} ORDER BY sequence_no`,
    )
    .map((row) => row.snapshot_json);
}
