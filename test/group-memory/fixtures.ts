import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, type FauxProviderHandle } from '@earendil-works/pi-ai';
import { and, eq, sql } from 'drizzle-orm';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { conversations, messageRevisions, messages, senders } from '../../src/store/schema/index.ts';
import { type FixtureConfig, fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

export interface GroupMemoryFixture {
  readonly directory: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly groupMemory: GroupMemoryStore;
  readonly chatId: bigint;
  readonly telegramChatId: bigint;
  readonly conversationId: bigint;
  /** Further configured, group-memory-enabled Chats from `extraChatIds`, in order. */
  readonly extraChats: readonly SeededGroupChat[];
  readonly faux: FauxProviderHandle | undefined;
  close(): Promise<void>;
}

export interface SeededGroupChat {
  readonly chatId: bigint;
  readonly telegramChatId: bigint;
  readonly conversationId: bigint;
}

export interface SeedMessageInput {
  readonly telegramMessageId: number;
  readonly date: Date;
  readonly text: string;
  readonly senderName?: string;
  readonly senderTelegramId?: number;
  readonly sentByBot?: boolean;
  readonly threadId?: bigint;
  readonly kind?: string;
}

let nextSenderId = 700_000;

function ensureConversation(store: SqliteStore, chatId: bigint, threadId: bigint): bigint {
  const existing = store.orm
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
    .get();
  if (existing !== undefined) {
    return existing.id;
  }
  const inserted = store.orm
    .insert(conversations)
    .values({
      chatId,
      messageThreadId: threadId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .returning({ id: conversations.id })
    .get();
  if (inserted === undefined) {
    throw new Error('conversation insert returned no row');
  }
  return inserted.id;
}

/** Seeds one stored Telegram message and its first revision, like ingestion would. */
export function seedMessage(
  store: SqliteStore,
  seeded: { readonly chatId: bigint; readonly conversationId: bigint },
  input: SeedMessageInput,
): bigint {
  const senderTelegramId = BigInt(input.senderTelegramId ?? nextSenderId++);
  const existingSender = store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(eq(senders.telegramId, senderTelegramId))
    .get();
  const senderId =
    existingSender?.id ??
    store.orm
      .insert(senders)
      .values({
        telegramType: 'user',
        telegramId: senderTelegramId,
        displayName: input.senderName ?? 'Alice',
        username: null,
        isBot: input.sentByBot === true,
        updatedAt: input.date.toISOString(),
      })
      .returning({ id: senders.id })
      .get()?.id;
  if (senderId === undefined) {
    throw new Error('sender insert returned no row');
  }
  const conversationId = ensureConversation(store, seeded.chatId, input.threadId ?? 0n);
  const message = store.orm
    .insert(messages)
    .values({
      conversationId,
      chatId: seeded.chatId,
      telegramMessageId: BigInt(input.telegramMessageId),
      visible: true,
      sentByBot: input.sentByBot === true,
      telegramDate: input.date.toISOString(),
      receivedAt: input.date.toISOString(),
    })
    .returning({ id: messages.id })
    .get();
  if (message === undefined) {
    throw new Error('message insert returned no row');
  }
  const revision = store.orm
    .insert(messageRevisions)
    .values({
      messageId: message.id,
      revisionNo: 1n,
      senderId,
      kind: input.kind ?? 'text',
      text: input.text,
      createdAt: input.date.toISOString(),
      rawFragmentJson: '{}',
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (revision === undefined) {
    throw new Error('revision insert returned no row');
  }
  store.orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, message.id)).run();
  return message.id;
}

export async function groupMemoryFixture(
  options: { readonly faux?: boolean; readonly enabled?: boolean; readonly extraChatIds?: readonly number[] } = {},
): Promise<GroupMemoryFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-group-memory-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config: FixtureConfig) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        return;
      }
      if (options.enabled !== false) {
        chat.group_memory = { enabled: true, idle_minutes: 30 };
      }
      for (const id of options.extraChatIds ?? []) {
        config.telegram.chats.push({ ...structuredClone(chat), id, group_memory: { enabled: true, idle_minutes: 30 } });
      }
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux =
    options.faux === true
      ? fauxProvider({
          provider: 'agent',
          models: [{ id: 'agent-model', reasoning: true, input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
        })
      : undefined;
  const configStore = await testConfigStore(loaded, faux === undefined ? undefined : fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const seeded = {
    telegramChatId: 123_456_789n,
    chatId: 1n,
    conversationId: 1n,
  };
  // `chats` has no seeded row yet; insert it with an explicit id so tests can
  // reason about the Chat-scoped rows directly.
  store.orm.run(
    sql`INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, title, updated_at)
        VALUES (1, 'telegram', 123456789, 123456789, 'supergroup', 'Test group', '2026-01-01T00:00:00.000Z')`,
  );
  const conversation = store.orm
    .insert(conversations)
    .values({
      chatId: 1n,
      messageThreadId: 0n,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .returning({ id: conversations.id })
    .get();
  if (conversation === undefined) {
    throw new Error('conversation insert returned no row');
  }
  const extraChats = (options.extraChatIds ?? []).map((telegramChatId, index): SeededGroupChat => {
    const chatId = BigInt(index + 2);
    store.orm.run(
      sql`INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, title, updated_at)
          VALUES (${chatId}, 'telegram', ${telegramChatId}, ${telegramChatId}, 'supergroup', 'Extra group', '2026-01-01T00:00:00.000Z')`,
    );
    return {
      chatId,
      telegramChatId: BigInt(telegramChatId),
      conversationId: ensureConversation(store, chatId, 0n),
    };
  });
  const groupMemory = new GroupMemoryStore(store.orm);
  // The switch was on before any message arrived, so every seeded message is
  // new to the live lane. Activation-boundary tests seed history first and let
  // the worker reconcile instead.
  for (const chat of [...(options.enabled === false ? [] : [seeded]), ...extraChats]) {
    groupMemory.activate(chat.chatId, 0n, new Date('2026-01-01T00:00:00.000Z'));
  }
  return {
    directory,
    loaded,
    store,
    configStore,
    secrets: new SecretStore(keyJarPath(loaded.configPath)),
    groupMemory,
    chatId: seeded.chatId,
    telegramChatId: seeded.telegramChatId,
    conversationId: conversation.id,
    extraChats,
    faux,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
