import { sql } from 'drizzle-orm';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config-resolve.ts';
import { isConversationActive } from '../../store/participation.ts';
import { bucketMessages, buckets } from '../../store/schema.ts';
import { isChatPaused, resolveChatConfig } from '../../store/store.ts';
import {
  enqueueBucketInvocation,
  type InvocationQueueDeps,
  logSleepingSkip,
  markBucketSkipped,
  proactiveAllows,
  sleepUntilFor,
} from './shared.ts';

interface CatchUpMessageRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
}

/**
 * One catch-up batch turn into buckets and queued invocations.
 *
 * Both catch-up paths share this step so their gates (chat removed, agent
 * unconfigured, paused, sleeping, participation, proactive reply) cannot
 * drift: the cold path selects messages by the drain marker, the runtime path
 * by the window of one live backlog pass.
 */
export function finishRuntimeCatchUpQueue(deps: InvocationQueueDeps, startedAt: Date, now = new Date()): bigint[] {
  return deps.store.transaction(() =>
    materializeCatchUpBuckets(deps, selectCatchUpMessages(deps, startedAt, true), startedAt, now),
  );
}

/**
 * Messages stored in Telegram conversations after `startedAt`, newest first
 * per Conversation and bounded by the configured history size. `unbucketedOnly`
 * keeps a runtime pass from re-materialising messages a later redelivery (or an
 * earlier pass) already put in a bucket.
 */
export function selectCatchUpMessages(
  deps: InvocationQueueDeps,
  startedAt: Date,
  unbucketedOnly: boolean,
): CatchUpMessageRow[] {
  const config = deps.configStore.current().config;
  const unbucketed = unbucketedOnly
    ? sql`AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = m.id)`
    : sql``;
  return deps.store.orm.all<CatchUpMessageRow>(
    sql`WITH session_messages AS (
       SELECT m.id, m.conversation_id, m.chat_id, c.telegram_chat_id, c.type AS chat_type,
              m.telegram_message_id, m.telegram_date,
              CASE WHEN r.kind <> 'service' AND COALESCE(s.is_bot, 0) = 0
                        AND (r.kind <> 'sticker' OR r.text IS NOT NULL OR r.caption IS NOT NULL
                             OR EXISTS (SELECT 1 FROM media WHERE revision_id = r.id AND kind <> 'sticker')
                             OR ${config.telegram.sticker_trigger_enabled === true ? 1n : 0n} = 1) THEN 1 ELSE 0 END AS eligible_human
       FROM messages m
       JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders s ON s.id = r.sender_id
       JOIN chats c ON c.id = m.chat_id
       WHERE m.received_at >= ${startedAt.toISOString()} AND m.visible = 1 AND m.sent_by_bot = 0
         -- Only Telegram catch-up: a room's inputs are released explicitly,
         -- never swept up by a startup or runtime pass.
         AND c.host_kind = 'telegram'
         ${unbucketed}
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY conversation_id ORDER BY telegram_date DESC, telegram_message_id DESC
       ) AS message_rank
       FROM session_messages
       WHERE conversation_id IN (SELECT conversation_id FROM session_messages WHERE eligible_human = 1)
     )
     SELECT id, conversation_id, chat_id, telegram_chat_id, chat_type, telegram_message_id, telegram_date
     FROM ranked
     WHERE message_rank <= ${BigInt(config.agent.history_messages)}
     ORDER BY conversation_id, telegram_date, telegram_message_id`,
  );
}

/** Turns selected messages into one catch-up bucket per Conversation. */
export function materializeCatchUpBuckets(
  deps: InvocationQueueDeps,
  selected: readonly CatchUpMessageRow[],
  startedAt: Date,
  now: Date,
): bigint[] {
  const store = deps.store;
  const configStore = deps.configStore;
  const sleepUntil = sleepUntilFor(deps, now);
  // One catch-up bucket per Conversation: forum topics are separate sessions
  // with their own participation state, and the bucket snapshot does not
  // filter its messages by conversation.
  const grouped = new Map<string, CatchUpMessageRow[]>();
  for (const message of selected) {
    const key = message.conversation_id.toString();
    const messages = grouped.get(key);
    if (messages === undefined) {
      grouped.set(key, [message]);
    } else {
      messages.push(message);
    }
  }
  const timestamp = now.toISOString();
  const invocationIds: bigint[] = [];
  for (const messages of grouped.values()) {
    const latest = messages.at(-1);
    if (latest === undefined) {
      continue;
    }
    const catchUpChat = resolveChatConfig(configStore.current().config, store.orm, latest.telegram_chat_id);
    let skipReason =
      catchUpChat === undefined
        ? 'chat_removed'
        : completeAgentSettings(resolveAgentSettings(configStore.current().config, catchUpChat)) === undefined
          ? 'agent_unconfigured'
          : isChatPaused(store.orm, latest.chat_id)
            ? 'chat_paused'
            : sleepUntil !== null
              ? 'sleeping'
              : participationBlocks(deps, latest, now)
                ? 'participation_gated'
                : undefined;
    const created =
      skipReason === undefined
        ? store.orm
            .insert(buckets)
            .values({
              conversationId: latest.conversation_id,
              state: 'queued',
              kind: 'startup_catch_up',
              // Recovery ages queued work from this clock. A slow/resumed
              // drain is fresh work, not an expired bucket; message selection
              // still uses the persisted drain start.
              firstReceivedAt: timestamp,
              deadlineAt: timestamp,
              queuedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning({ id: buckets.id })
            .get()
        : store.orm
            .insert(buckets)
            .values({
              conversationId: latest.conversation_id,
              state: 'skipped_budget',
              kind: 'startup_catch_up',
              firstReceivedAt: startedAt.toISOString(),
              deadlineAt: timestamp,
              finishedAt: timestamp,
              errorCode: skipReason,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning({ id: buckets.id })
            .get();
    if (created === undefined) {
      throw new Error('buckets insert returned no row');
    }
    const bucketId = created.id;
    if (skipReason === 'sleeping' && sleepUntil !== null) {
      logSleepingSkip(latest.telegram_chat_id, bucketId, null, sleepUntil);
    }
    for (const [sequence, message] of messages.entries()) {
      store.orm
        .insert(bucketMessages)
        .values({ bucketId, messageId: message.id, sequenceNo: BigInt(sequence + 1), sourceBucketId: bucketId })
        .run();
    }
    if (skipReason === undefined && catchUpChat !== undefined) {
      if (
        proactiveAllows(
          deps,
          bucketId,
          latest.chat_id,
          latest.telegram_chat_id,
          latest.chat_type,
          latest.conversation_id,
          catchUpChat,
          now,
        )
      ) {
        invocationIds.push(enqueueBucketInvocation(deps, bucketId, latest.conversation_id, now, false));
      } else {
        skipReason = 'proactive_reply_skipped';
        markBucketSkipped(deps, bucketId, now, skipReason);
      }
    }
  }
  return invocationIds;
}

// A chat outside its active periods only receives a catch-up bucket when a
// mention, reply, or keyword hit already refreshed its attention window.
function participationBlocks(deps: InvocationQueueDeps, message: CatchUpMessageRow, now: Date): boolean {
  const rule = deps.participation.ruleFor(deps.store.orm, message.telegram_chat_id, message.chat_type);
  return rule !== undefined && !isConversationActive(deps.store.orm, rule, message.conversation_id, now);
}
