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

/** A Chat whose group-memory switch changed between two published configurations. */
export interface GroupMemoryToggle {
  readonly chatId: bigint;
  readonly enabled: boolean;
}

/** Chats present in both configurations whose `group_memory.enabled` changed. */
export function toggledGroupMemoryChats(previous: RawConfig, next: RawConfig): GroupMemoryToggle[] {
  const before = new Map(previous.telegram.chats.map((chat) => [String(chat.id), chat.group_memory?.enabled === true]));
  return next.telegram.chats
    .filter(
      (chat) => before.has(String(chat.id)) && before.get(String(chat.id)) !== (chat.group_memory?.enabled === true),
    )
    .map((chat) => ({ chatId: BigInt(chat.id), enabled: chat.group_memory?.enabled === true }));
}

/** The scheduler surface a group-memory toggle needs; tests pass a stub. */
export interface InvocationStopper {
  abortInvocations(ids: readonly bigint[], reason: string): number;
  waitForInvocations(ids: readonly bigint[], timeoutMilliseconds?: number): Promise<boolean>;
}

/**
 * Enforces a group-memory switch change: abort every running Invocation of the
 * Chat, drop its cached Agents, then rebuild every Conversation Context from
 * scratch. The config is published before this runs, so queued work starts with
 * the new tool set; aborting running work closes the window where an old run
 * could finish with the previous capability set. The abort/check loop is bounded
 * so a queued run that starts during the cutover is caught in the next round.
 */
export async function applyGroupMemoryToggles(
  store: BusinessStore,
  stopper: InvocationStopper | undefined,
  forgetConversation: (conversationId: bigint) => void,
  previous: RawConfig,
  next: RawConfig,
  now = new Date(),
): Promise<{
  readonly chats: number;
  readonly conversations: number;
  readonly invocations: number;
  readonly rebuilt: number;
  readonly settled: boolean;
}> {
  const toggles = toggledGroupMemoryChats(previous, next);
  if (toggles.length === 0) {
    return { chats: 0, conversations: 0, invocations: 0, rebuilt: 0, settled: true };
  }
  const conversationIds = conversationIdsForTelegramChats(
    store,
    toggles.map((toggle) => toggle.chatId),
  );
  if (conversationIds.length === 0) {
    return { chats: toggles.length, conversations: 0, invocations: 0, rebuilt: 0, settled: true };
  }
  let stoppedInvocations = 0;
  let settled = true;
  for (let round = 0; round < 3; round += 1) {
    const running = store.orm
      .select({ id: invocations.id })
      .from(invocations)
      .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'running')))
      .all()
      .map((row) => row.id);
    if (running.length === 0) {
      break;
    }
    stoppedInvocations += stopper?.abortInvocations(running, 'group_memory_toggled') ?? 0;
    if (stopper === undefined) {
      break;
    }
    settled = await stopper.waitForInvocations(running, 30_000);
    if (!settled) {
      break;
    }
  }
  for (const conversationId of conversationIds) {
    forgetConversation(conversationId);
  }
  const rebuilt = new ConversationContextStore(store).rebuildForConversations(conversationIds, now);
  return {
    chats: toggles.length,
    conversations: conversationIds.length,
    invocations: stoppedInvocations,
    rebuilt,
    settled,
  };
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
