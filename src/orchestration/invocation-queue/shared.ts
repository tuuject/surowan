import { eq, type SQL, sql } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from '../../platform/agent-protocol.ts';
import type { RawConfig } from '../../platform/config.ts';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config-resolve.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { enqueueInvocation } from '../../store/invocation-enqueue.ts';
import { snapshotInvocation } from '../../store/invocation-snapshot.ts';
import type { LongTaskService } from '../../store/long-tasks.ts';
import type { ParticipationRegistry } from '../../store/participation.ts';
import { buckets, rooms } from '../../store/schema.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { type BusinessStore, isChatPaused, resolveChatConfig } from '../../store/store.ts';
import type { BucketAttachmentTarget } from '../invocation-queue.ts';
import type { ProactiveReplyGate } from '../proactive-reply.ts';

/**
 * Live dependencies of `InvocationQueueService`. Each field is the same object
 * the service was constructed with, so the split modules read and mutate the
 * one canonical in-memory state through these references and never hold a copy.
 */
export interface InvocationQueueDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly participation: ParticipationRegistry;
  readonly attachment: BucketAttachmentTarget | undefined;
  readonly tasks: LongTaskService;
  readonly proactive: ProactiveReplyGate | undefined;
  /**
   * Conversations this process serves, as a subquery. Undefined means every
   * host (a shared process).
   */
  readonly scope: SQL | undefined;
  /** The global sleep state is Telegram's; a process without it never reads or clears it. */
  readonly servesTelegram: boolean;
  /** `RECOVERY_MAX_AGE_MS`, owned by the service module. */
  readonly recoveryMaxAgeMs: number;
  /** `STARTUP_CATCH_UP_STATE_KEY`, owned by the service module. */
  readonly startupCatchUpStateKey: string;
  /** `MINIMUM_DEFER_MS`, owned by the service module. */
  readonly minimumDeferMs: number;
  /**
   * `attachBucketToInvocation` from the service module, passed in rather than
   * imported so this module graph stays acyclic.
   */
  attachBucketToInvocation(
    store: BusinessStore,
    historyMessages: number,
    invocationId: bigint,
    bucketId: bigint,
    conversationId: bigint,
    now: Date,
  ): void;
}

export interface ReceiptRow {
  readonly task_id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  /** Null for a Playground room, which has no Telegram identity. */
  readonly telegram_chat_id: bigint | null;
  readonly message_thread_id: bigint;
  readonly bypass_daily_budget: bigint;
  readonly host_kind: string;
}

/** `conversation_id`/`bucket_id` rows of this process's hosts; always true when unscoped. */
export function servedConversations(deps: InvocationQueueDeps, column: SQL): SQL {
  const scope = deps.scope;
  return scope === undefined ? sql`1 = 1` : sql`${column} IN (${scope})`;
}

/** `activeSleepUntil` for a process that serves Telegram; null otherwise, without touching the row. */
export function sleepUntilFor(deps: InvocationQueueDeps, now: Date): string | null {
  return deps.servesTelegram ? activeSleepUntil(deps.store.orm, now) : null;
}

export function runningInvocationId(deps: InvocationQueueDeps, conversationId: bigint): bigint | undefined {
  return deps.store.orm
    .all<{ id: bigint }>(
      sql`SELECT id FROM invocations WHERE conversation_id = ${conversationId} AND state = 'running' ORDER BY id DESC LIMIT 1`,
    )
    .at(0)?.id;
}

export function enqueueBucketInvocation(
  deps: InvocationQueueDeps,
  bucketId: bigint,
  conversationId: bigint,
  now: Date,
  includeHistory: boolean,
): bigint {
  const current = deps.configStore.current();
  const invocationId = enqueueInvocation(deps.store.orm, {
    bucketId,
    conversationId,
    configHash: current.hash,
    promptVersion: AGENT_PROMPT_VERSION,
    createdAt: now.toISOString(),
  });
  snapshotInvocation(
    deps.store,
    current.config.agent.history_messages,
    invocationId,
    bucketId,
    conversationId,
    includeHistory,
  );
  return invocationId;
}

/**
 * One probability decision for this aggregated bucket, after every gate that
 * could skip it has already run. A miss keeps the bucket's messages in the
 * database (and therefore in later history) but closes the bucket without an
 * Invocation, exactly like a participation-gated message.
 */
export function proactiveAllows(
  deps: InvocationQueueDeps,
  bucketId: bigint,
  chatId: bigint,
  telegramChatId: bigint,
  chatType: string,
  conversationId: bigint,
  chat: Pick<RawConfig['telegram']['chats'][number], 'proactive_reply'>,
  now: Date,
): boolean {
  const proactive = deps.proactive;
  if (proactive === undefined) {
    return true;
  }
  const rule = deps.participation.ruleFor(deps.store.orm, telegramChatId, chatType);
  return proactive.decide({
    bucketId,
    chatId,
    telegramChatId,
    chatType,
    conversationId,
    chat,
    keywords: rule?.keywords ?? [],
    now,
  }).allowed;
}

export function markBucketSkipped(deps: InvocationQueueDeps, bucketId: bigint, now: Date, reason: string): void {
  const timestamp = now.toISOString();
  deps.store.orm
    .update(buckets)
    .set({ state: 'skipped_budget', errorCode: reason, finishedAt: timestamp, updatedAt: timestamp })
    .where(eq(buckets.id, bucketId))
    .run();
}

export function logSleepingSkip(
  chatId: bigint,
  bucketId: bigint,
  invocationId: bigint | null,
  sleepUntil: string,
): void {
  console.log(
    JSON.stringify({
      event: 'agent_session_skipped_sleeping',
      chat_id: chatId.toString(),
      bucket_id: bucketId.toString(),
      invocation_id: invocationId?.toString() ?? null,
      sleep_until: sleepUntil,
      at: new Date().toISOString(),
    }),
  );
}

export function receiptCancelReason(deps: InvocationQueueDeps, receipt: ReceiptRow): string | undefined {
  // A room has no Telegram chat entry, pause or topic list; it is a valid
  // destination for as long as the room itself exists.
  if (receipt.host_kind === 'playground') {
    const room = deps.store.orm
      .select({ chatId: rooms.chatId })
      .from(rooms)
      .where(eq(rooms.chatId, receipt.chat_id))
      .get();
    return room === undefined ? 'chat_removed' : undefined;
  }
  if (receipt.telegram_chat_id === null) {
    return 'chat_removed';
  }
  const current = deps.configStore.current().config;
  const chatConfig = resolveChatConfig(current, deps.store.orm, receipt.telegram_chat_id);
  if (chatConfig === undefined) {
    return 'chat_removed';
  }
  // A completion receipt is delivered by an invocation, so it waits for the
  // same complete identity triple as a message bucket.
  if (completeAgentSettings(resolveAgentSettings(current, chatConfig)) === undefined) {
    return 'agent_unconfigured';
  }
  if (isChatPaused(deps.store.orm, receipt.chat_id)) {
    return 'chat_paused';
  }
  if (
    chatConfig.topic_ids !== undefined &&
    !chatConfig.topic_ids.some((topicId) => BigInt(topicId) === receipt.message_thread_id)
  ) {
    return 'topic_removed';
  }
  return undefined;
}
