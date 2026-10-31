import { and, eq, inArray } from 'drizzle-orm';
import { ConversationContextStore } from '../../../context/store.ts';
import type { RawConfig } from '../../../platform/config/index.ts';
import { telegramChatIdentity } from '../../../store/chat-identity.ts';
import type { LongTaskService } from '../../../store/long-tasks/index.ts';
import { buckets, chats, conversations, invocations, taskReceipts } from '../../../store/schema/index.ts';
import { type BusinessStore, resolveChatConfig } from '../../../store/store.ts';

/**
 * Telegram Chat ids that the published configuration no longer contains. The
 * file may remove several at once; the stored rows stay untouched here.
 */
export function removedTelegramChatIds(previous: RawConfig, next: RawConfig): bigint[] {
  const nextIds = new Set(next.telegram.chats.map((chat) => String(chat.id)));
  return previous.telegram.chats.filter((chat) => !nextIds.has(String(chat.id))).map((chat) => BigInt(chat.id));
}

/** Telegram Chat ids that appeared in the published configuration. */
export function addedTelegramChatIds(previous: RawConfig, next: RawConfig): bigint[] {
  const previousIds = new Set(previous.telegram.chats.map((chat) => String(chat.id)));
  return next.telegram.chats.filter((chat) => !previousIds.has(String(chat.id))).map((chat) => BigInt(chat.id));
}

export function conversationIdsForTelegramChats(
  store: BusinessStore,
  telegramChatIds: readonly bigint[],
  unauthorizedIn?: RawConfig,
): bigint[] {
  if (telegramChatIds.length === 0) {
    return [];
  }
  const runtimeIds = telegramChatIdentity(store, telegramChatIds).filter(
    (id) => unauthorizedIn === undefined || resolveChatConfig(unauthorizedIn, store.orm, id) === undefined,
  );
  if (runtimeIds.length === 0) {
    return [];
  }
  const chatRows = store.orm
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.hostKind, 'telegram'), inArray(chats.telegramChatId, runtimeIds)))
    .all();
  if (chatRows.length === 0) {
    return [];
  }
  return store.orm
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      inArray(
        conversations.chatId,
        chatRows.map((row) => row.id),
      ),
    )
    .all()
    .map((row) => row.id);
}

/**
 * Stops everything a Chat still owns after it left the published configuration.
 * The stored history, Memo Pad and blobs are deliberately left in place: only an
 * explicit Admin deletion removes them.
 */
export function stopRemovedChats(
  store: BusinessStore,
  tasks: LongTaskService,
  abortInvocations: (ids: readonly bigint[], reason: string) => number,
  forgetConversation: (conversationId: bigint) => void,
  telegramChatIds: readonly bigint[],
  nextConfig: RawConfig,
): { readonly invocations: number; readonly tasks: number } {
  if (telegramChatIds.length === 0) {
    return { invocations: 0, tasks: 0 };
  }
  const conversationIds = conversationIdsForTelegramChats(store, telegramChatIds, nextConfig);
  if (conversationIds.length === 0) {
    return { invocations: 0, tasks: 0 };
  }
  const running = store.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'running')))
    .all()
    .map((row) => row.id);
  const now = new Date().toISOString();
  store.orm.transaction(() => {
    store.orm
      .update(taskReceipts)
      .set({ state: 'suppressed', cancelReason: 'chat_removed', cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(taskReceipts.state, 'claimed'),
          inArray(
            taskReceipts.invocationId,
            store.orm
              .select({ id: invocations.id })
              .from(invocations)
              .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'queued'))),
          ),
        ),
      )
      .run();
    store.orm
      .update(invocations)
      .set({ state: 'aborted', completionReason: 'chat_removed', finishedAt: now })
      .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'queued')))
      .run();
    store.orm
      .update(buckets)
      .set({ state: 'aborted', errorCode: 'chat_removed', finishedAt: now, updatedAt: now })
      .where(and(inArray(buckets.conversationId, conversationIds), inArray(buckets.state, ['collecting', 'queued'])))
      .run();
  });
  for (const conversationId of conversationIds) {
    forgetConversation(conversationId);
  }
  new ConversationContextStore(store).requestMemoRefreshForConversations(conversationIds);
  return {
    invocations: abortInvocations(running, 'chat_removed'),
    tasks: tasks.cancelForConversations(conversationIds),
  };
}
