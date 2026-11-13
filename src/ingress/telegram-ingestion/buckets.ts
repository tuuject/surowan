import { and, eq, sql } from 'drizzle-orm';
import { resolveBucketTiming } from '../../platform/config/resolve.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { bucketMessages, buckets, conversations } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import { isChatPaused } from '../../store/store.ts';
import type { StoredMessage } from './messages.ts';

/** What bucket handoff needs from ingestion. */
export interface TelegramBucketDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
}

export function appendToBucket(
  deps: TelegramBucketDeps,
  chatId: bigint,
  threadId: bigint,
  message: StoredMessage,
  receivedAt: Date,
  participationAllowed: boolean,
): bigint | undefined {
  if (isChatPaused(deps.store.orm, chatId)) {
    return undefined;
  }
  const conversation = deps.store.orm
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
    .get();
  if (conversation === undefined) {
    throw new Error('Conversation missing while assigning bucket');
  }
  const collecting = deps.store.orm
    .select({
      id: buckets.id,
      firstReceivedAt: buckets.firstReceivedAt,
      maxSeconds: buckets.maxSeconds,
      bumpSeconds: buckets.bumpSeconds,
    })
    .from(buckets)
    .where(and(eq(buckets.conversationId, conversation.id), eq(buckets.state, 'collecting')))
    .get();
  if (message.companionOnly && collecting === undefined) {
    return undefined;
  }
  if (collecting !== undefined && message.eligibleHuman) {
    bumpDeadline(deps, collecting, receivedAt);
  }
  let bucketId = collecting?.id;
  if (bucketId === undefined) {
    if (!message.eligibleHuman) {
      return undefined;
    }
    // Participation gate: outside the chat's active periods and attention
    // window a quiet conversation keeps storing messages but opens no bucket,
    // so they only reach the model as history of a later triggered session.
    if (!participationAllowed) {
      return undefined;
    }
    const now = receivedAt.toISOString();
    // Anchored to this bucket's own first message, never snapped to a chat-wide
    // grid: a grid anchor leaves a band right after every run start where a
    // bucket collects almost nothing (down to milliseconds when a message lands
    // on the grid point), which a long-lived invocation turns into an occasional
    // instant reply. Treating "an invocation is queued or running" as
    // immediately due would make every message its own zero-length bucket now
    // that attach exists, and anchoring here alone would hand over a
    // barely-collected batch the moment a long round ends —
    // `AgentRuntime#deferCollectingBucket` therefore only ever pushes this
    // deadline later, to `round end + window`.
    //
    // The timing is read once, here, and stored with the batch: a reload of
    // the `telegram.bucket_*` fields reaches the next batch, while this one
    // keeps extending and deferring by the timing it opened with.
    const timing = resolveBucketTiming(deps.configStore.current().config, 'telegram');
    const deadline = receivedAt.getTime() + timing.windowSeconds * 1_000;
    const created = deps.store.orm
      .insert(buckets)
      .values({
        conversationId: conversation.id,
        state: 'collecting',
        firstReceivedAt: now,
        deadlineAt: new Date(deadline).toISOString(),
        windowSeconds: BigInt(timing.windowSeconds),
        maxSeconds: BigInt(timing.maxSeconds),
        bumpSeconds: BigInt(timing.bumpSeconds),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: buckets.id })
      .get();
    if (created === undefined) {
      throw new Error('buckets insert returned no row');
    }
    bucketId = created.id;
    adoptPendingBotMessages(deps, conversation.id, bucketId);
  }
  const sequence = deps.store.orm
    .all<{ next_sequence: bigint }>(
      sql`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM bucket_messages WHERE bucket_id = ${bucketId}`,
    )
    .at(0);
  if (sequence === undefined) {
    throw new Error('Unable to allocate bucket sequence');
  }
  deps.store.orm
    .insert(bucketMessages)
    .values({
      bucketId,
      messageId: message.id,
      sequenceNo: sequence.next_sequence,
      sourceBucketId: bucketId,
    })
    .run();
  return bucketId;
}

/**
 * Holds a batch open while its conversation is still talking: a message joining
 * it pushes the deadline to the message's own arrival plus the batch's
 * `bucket_bump_seconds`, but never past the first message plus its
 * `bucket_max_seconds`, so a steady stream still settles. Both come from the
 * batch row, as it was opened, never from the live configuration.
 *
 * Extension-only, like every other deadline write: the window a round end
 * granted, or a deadline already further out, is never pulled in. Only messages
 * that could have opened the batch extend it; other bots, service notices and
 * untriggering stickers still join, but must not keep a batch open any more
 * than they may open one. The batch is still `collecting` inside this
 * transaction, and settling it is a transaction too, so a message either lands
 * here and extends the batch or arrives after it settled and opens the next.
 */
function bumpDeadline(
  deps: TelegramBucketDeps,
  bucket: {
    readonly id: bigint;
    readonly firstReceivedAt: string;
    readonly maxSeconds: bigint;
    readonly bumpSeconds: bigint;
  },
  receivedAt: Date,
): void {
  if (bucket.bumpSeconds === 0n) {
    return;
  }
  const bumped = new Date(
    Math.min(
      Date.parse(bucket.firstReceivedAt) + Number(bucket.maxSeconds) * 1_000,
      receivedAt.getTime() + Number(bucket.bumpSeconds) * 1_000,
    ),
  ).toISOString();
  deps.store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${bumped}, updated_at = ${receivedAt.toISOString()}
       WHERE id = ${bucket.id} AND state = 'collecting' AND deadline_at < ${bumped}`,
  );
}

/**
 * Other bots' messages never open a bucket, so two bots cannot keep each
 * other awake. The ones that arrived while nothing was collecting wait here
 * until a human opens the next bucket, which takes them in ahead of itself
 * so the model sees them as part of the same new batch.
 */
function adoptPendingBotMessages(deps: TelegramBucketDeps, conversationId: bigint, bucketId: bigint): void {
  const pending = deps.store.orm
    .all<{ id: bigint }>(
      sql`SELECT m.id
         FROM messages m
         JOIN message_revisions r ON r.id = m.current_revision_id
         JOIN senders s ON s.id = r.sender_id
         WHERE m.conversation_id = ${conversationId} AND m.visible = 1 AND m.sent_by_bot = 0 AND s.is_bot = 1
           AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = m.id)
           AND m.received_at >= COALESCE(
             (SELECT MAX(first_received_at) FROM buckets WHERE conversation_id = ${conversationId} AND id <> ${bucketId}),
             '')
           AND m.telegram_message_id > COALESCE(
             (SELECT telegram_message_id FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
         ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
         LIMIT ${BigInt(deps.configStore.current().config.agent.history_messages)}`,
    )
    .reverse();
  for (const [index, row] of pending.entries()) {
    deps.store.orm
      .insert(bucketMessages)
      .values({ bucketId, messageId: row.id, sequenceNo: BigInt(index + 1), sourceBucketId: bucketId })
      .run();
  }
}
