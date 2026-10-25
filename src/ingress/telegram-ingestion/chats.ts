import { eq } from 'drizzle-orm';
import type { Message } from 'grammy/types';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { chatMigrations, chats } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';

/**
 * The allowlist cache `TelegramIngestion` owns and this module rebuilds and
 * reads. The object is handed over by reference, so every assignment here is
 * visible to the entry point's next update.
 */
export type AllowedChatsState = {
  allowedChats: Map<string, ReadonlySet<bigint> | undefined>;
  generation: number;
};

/** What allowlist routing and chat bookkeeping need from ingestion. */
export interface TelegramChatDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly state: AllowedChatsState;
}

// Chat additions are hot-applied configuration changes: rebuild the
// allowlist whenever the published configuration generation moved on.
export function syncAllowedChats(deps: TelegramChatDeps): void {
  const snapshot = deps.configStore.current();
  if (snapshot.generation === deps.state.generation) {
    return;
  }
  deps.state.generation = snapshot.generation;
  deps.state.allowedChats = new Map(
    snapshot.config.telegram.chats.map((chat) => [
      String(chat.id),
      chat.topic_ids === undefined ? undefined : new Set(chat.topic_ids.map((topicId) => BigInt(topicId))),
    ]),
  );
}

/** `null` when the chat is not allowed; `undefined` when allowed for all topics. */
export function topicsFor(deps: TelegramChatDeps, chatId: bigint): ReadonlySet<bigint> | undefined | null {
  if (deps.state.allowedChats.has(chatId.toString())) {
    return deps.state.allowedChats.get(chatId.toString());
  }
  const migration = deps.store.orm
    .select({ oldChatId: chatMigrations.oldChatId })
    .from(chatMigrations)
    .where(eq(chatMigrations.newChatId, chatId))
    .get();
  if (migration === undefined) {
    return null;
  }
  const migrated = migration.oldChatId.toString();
  return deps.state.allowedChats.has(migrated) ? deps.state.allowedChats.get(migrated) : null;
}

export function recordMigration(deps: TelegramChatDeps, message: Message | undefined, receivedAt: Date): void {
  if (message === undefined) {
    return;
  }
  let oldChatId: bigint | undefined;
  let newChatId: bigint | undefined;
  if ('migrate_to_chat_id' in message) {
    oldChatId = BigInt(message.chat.id);
    newChatId = BigInt(message.migrate_to_chat_id);
  } else if ('migrate_from_chat_id' in message) {
    oldChatId = BigInt(message.migrate_from_chat_id);
    newChatId = BigInt(message.chat.id);
  }
  // Only a chat that is itself allowed can hand its allowlist entry on.
  if (oldChatId === undefined || newChatId === undefined || topicsFor(deps, oldChatId) === null) {
    return;
  }
  deps.store.orm
    .insert(chatMigrations)
    .values({
      oldChatId,
      newChatId,
      receivedAt: receivedAt.toISOString(),
    })
    .onConflictDoUpdate({
      target: chatMigrations.oldChatId,
      set: { newChatId, receivedAt: receivedAt.toISOString() },
    })
    .run();
}

export function upsertChat(deps: TelegramChatDeps, chat: Message['chat'], chatId: bigint, receivedAt: Date): bigint {
  const title = 'title' in chat ? (chat.title ?? null) : null;
  const username = 'username' in chat ? (chat.username ?? null) : null;
  deps.store.orm
    .insert(chats)
    .values({
      telegramChatId: chatId,
      canonicalChatId: chatId,
      type: chat.type,
      title,
      username,
      updatedAt: receivedAt.toISOString(),
    })
    .onConflictDoUpdate({
      target: chats.telegramChatId,
      set: { type: chat.type, title, username, updatedAt: receivedAt.toISOString() },
    })
    .run();
  const row = deps.store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, chatId)).get();
  if (row === undefined) {
    throw new Error('Chat upsert did not return a row');
  }
  return row.id;
}
