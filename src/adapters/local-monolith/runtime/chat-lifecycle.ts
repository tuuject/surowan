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
  fenceConversations(ids: readonly bigint[]): () => void;
  waitForInvocations(ids: readonly bigint[], timeoutMilliseconds?: number): Promise<boolean>;
  settleInvocations(ids: readonly bigint[]): Promise<void>;
}

export interface GroupMemoryCutover {
  readonly chats: number;
  readonly conversations: number;
  readonly invocations: number;
  /** Contexts rebuilt before this call returned; 0 while `settled` is false. */
  readonly rebuilt: number;
  /** False: a handler outlived the wait, and the rebuild runs in `completion`. */
  readonly settled: boolean;
  /** Resolves with the rebuilt count once the cutover has really finished. */
  readonly completion: Promise<number>;
}

/** How long a toggle waits in-line before handing the rebuild to `completion`. */
const CUTOVER_WAIT_MILLISECONDS = 30_000;

/**
 * Enforces a group-memory switch change: abort every running Invocation of the
 * Chat, drop its cached Agents, then rebuild every Conversation Context from
 * scratch. The config is published before this runs, so queued work starts with
 * the new tool set once the cutover ends.
 *
 * The Conversations are fenced first, so no queued run can start between the
 * abort and the rebuild. A Context is only rewritten after every handler that
 * held it has settled: a live handler keeps its own header and sequence
 * counters, and resetting under it would fork the canonical history. When a
 * handler outlives the in-line wait the fence stays up and the rebuild finishes
 * in `completion` instead of racing the stale writer.
 */
export async function applyGroupMemoryToggles(
  store: BusinessStore,
  stopper: InvocationStopper | undefined,
  forgetConversation: (conversationId: bigint) => void,
  previous: RawConfig,
  next: RawConfig,
  options: { readonly now?: Date; readonly waitMilliseconds?: number } = {},
): Promise<GroupMemoryCutover> {
  const toggles = toggledGroupMemoryChats(previous, next);
  const conversationIds =
    toggles.length === 0
      ? []
      : conversationIdsForTelegramChats(
          store,
          toggles.map((toggle) => toggle.chatId),
        );
  const reset = (): number => {
    for (const conversationId of conversationIds) {
      forgetConversation(conversationId);
    }
    return new ConversationContextStore(store).rebuildForConversations(conversationIds, options.now ?? new Date());
  };
  const finished = (invocationCount: number, rebuilt: number): GroupMemoryCutover => ({
    chats: toggles.length,
    conversations: conversationIds.length,
    invocations: invocationCount,
    rebuilt,
    settled: true,
    completion: Promise.resolve(rebuilt),
  });
  if (conversationIds.length === 0) {
    return finished(0, 0);
  }
  if (stopper === undefined) {
    // Without a scheduler this process runs no Invocation that could hold a Context.
    return finished(0, reset());
  }
  const release = stopper.fenceConversations(conversationIds);
  let handedOff = false;
  try {
    const running = store.orm
      .select({ id: invocations.id })
      .from(invocations)
      .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'running')))
      .all()
      .map((row) => row.id);
    const stopped = running.length === 0 ? 0 : stopper.abortInvocations(running, 'group_memory_toggled');
    const settled =
      running.length === 0 ||
      (await stopper.waitForInvocations(running, options.waitMilliseconds ?? CUTOVER_WAIT_MILLISECONDS));
    if (settled) {
      return finished(stopped, reset());
    }
    handedOff = true;
    const completion = stopper.settleInvocations(running).then(reset).finally(release);
    // The caller observes the outcome through `completion`; this guard only
    // keeps a rejection from becoming unhandled before it attaches.
    completion.catch(() => undefined);
    return {
      chats: toggles.length,
      conversations: conversationIds.length,
      invocations: stopped,
      rebuilt: 0,
      settled: false,
      completion,
    };
  } finally {
    if (!handedOff) {
      release();
    }
  }
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
