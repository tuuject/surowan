import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config-resolve.ts';
import { isConversationActive } from '../../store/participation.ts';
import {
  appState,
  bucketMessages,
  buckets,
  chats,
  conversations,
  invocations,
  taskReceipts,
} from '../../store/schema.ts';
import { asRunResult, isChatPaused, resolveChatConfig } from '../../store/store.ts';
import {
  enqueueBucketInvocation,
  type InvocationQueueDeps,
  logSleepingSkip,
  markBucketSkipped,
  proactiveAllows,
  servedConversations,
  sleepUntilFor,
} from './shared.ts';

interface StartupMessageRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
}

/** Crash recovery: close work a previous process left `running`/`queued`. */
export function recoverQueue(deps: InvocationQueueDeps, now = new Date()): void {
  const store = deps.store;
  store.transaction(() => {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - deps.recoveryMaxAgeMs).toISOString();
    store.orm.run(
      sql`UPDATE invocations SET state = CASE WHEN side_effect_started = 1 THEN 'outcome_unknown' ELSE 'aborted' END, completion_reason = 'process_restart', finished_at = ${nowIso}
          WHERE state = 'running' AND ${servedConversations(deps, sql`conversation_id`)}`,
    );
    // Every attached bucket — the opening one included — decides its state
    // from the invocation it was attached to, not from `invocations.bucket_id`.
    store.orm.run(
      sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id WHERE ib.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
         WHERE state = 'running' AND ${servedConversations(deps, sql`conversation_id`)}
           AND EXISTS (SELECT 1 FROM invocation_buckets ib WHERE ib.bucket_id = buckets.id)`,
    );
    store.orm.run(
      sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
          WHERE state = 'running' AND ${servedConversations(deps, sql`conversation_id`)}`,
    );
    // A claim is never replayed: the send outcome can be unknown even when
    // the invocation link is missing or already terminal. Close queued work
    // before ordinary age-based recovery can overwrite its restart reason.
    store.orm.run(
      sql`UPDATE buckets SET state = 'aborted', error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
         WHERE ${servedConversations(deps, sql`conversation_id`)}
           AND id IN (
           SELECT i.bucket_id FROM invocations i JOIN task_receipts r ON r.invocation_id = i.id
           WHERE r.state = 'claimed' AND i.state = 'queued'
           UNION
           SELECT ib.bucket_id FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id
           JOIN task_receipts r ON r.invocation_id = i.id WHERE r.state = 'claimed' AND i.state = 'queued'
         )`,
    );
    store.orm.run(
      sql`UPDATE invocations SET state = 'aborted', completion_reason = 'process_restart', finished_at = ${nowIso}
         WHERE state = 'queued' AND ${servedConversations(deps, sql`conversation_id`)}
           AND id IN (SELECT invocation_id FROM task_receipts WHERE state = 'claimed')`,
    );
    store.orm
      .update(taskReceipts)
      .set({
        state: 'handled',
        handledAt: nowIso,
        updatedAt: nowIso,
        invocationOutcome: 'outcome_unknown',
        completionReason: 'outcome_unknown',
      })
      .where(
        and(
          eq(taskReceipts.state, 'claimed'),
          sql`${taskReceipts.taskId} IN (SELECT t.id FROM long_tasks t WHERE ${servedConversations(deps, sql`t.conversation_id`)})`,
        ),
      )
      .run();
    const expiring = store.orm
      .select({ id: buckets.id, hostKind: chats.hostKind })
      .from(buckets)
      .innerJoin(conversations, eq(conversations.id, buckets.conversationId))
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(
        and(
          inArray(buckets.state, ['collecting', 'queued']),
          lt(buckets.firstReceivedAt, staleBefore),
          servedConversations(deps, sql`${buckets.conversationId}`),
        ),
      )
      .orderBy(buckets.id)
      .all();
    for (const bucket of expiring) {
      // A room's queue is not a Telegram collecting bucket: its expiry is
      // reported by the room store, not swept up by restart recovery.
      if (bucket.hostKind !== 'telegram') {
        continue;
      }
      store.orm
        .update(buckets)
        .set({ state: 'expired', errorCode: 'recovery_age', finishedAt: nowIso, updatedAt: nowIso })
        .where(eq(buckets.id, bucket.id))
        .run();
      store.orm
        .update(invocations)
        .set({ state: 'aborted', completionReason: 'recovery_age', finishedAt: nowIso })
        .where(and(eq(invocations.bucketId, bucket.id), eq(invocations.state, 'queued')))
        .run();
    }
  });
}

/** Startup catch-up: turn messages received while the process was down into buckets. */
export function finishStartupCatchUpQueue(deps: InvocationQueueDeps, startedAt: Date, now = new Date()): bigint[] {
  const store = deps.store;
  const configStore = deps.configStore;
  const sleepUntil = sleepUntilFor(deps, now);
  return store.transaction(() => {
    const state = store.orm
      .select({ value: appState.value })
      .from(appState)
      .where(eq(appState.key, deps.startupCatchUpStateKey))
      .get();
    if (state?.value !== startedAt.toISOString()) {
      throw new Error('Startup catch-up state changed before scheduling');
    }
    const selected = store.orm.all<StartupMessageRow>(
      sql`WITH session_messages AS (
         SELECT m.id, m.conversation_id, m.chat_id, c.telegram_chat_id, c.type AS chat_type,
                m.telegram_message_id, m.telegram_date,
                CASE WHEN r.kind <> 'service' AND COALESCE(s.is_bot, 0) = 0
                          AND (r.kind <> 'sticker' OR r.text IS NOT NULL OR r.caption IS NOT NULL
                               OR EXISTS (SELECT 1 FROM media WHERE revision_id = r.id AND kind <> 'sticker')
                               OR ${configStore.current().config.telegram.sticker_trigger_enabled === true ? 1n : 0n} = 1) THEN 1 ELSE 0 END AS eligible_human
         FROM messages m
         JOIN message_revisions r ON r.id = m.current_revision_id
         LEFT JOIN senders s ON s.id = r.sender_id
         JOIN chats c ON c.id = m.chat_id
         WHERE m.received_at >= ${startedAt.toISOString()} AND m.visible = 1 AND m.sent_by_bot = 0
           -- Only Telegram catch-up: a room's inputs are released explicitly,
           -- never swept up by a startup pass.
           AND c.host_kind = 'telegram'
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
       WHERE message_rank <= ${BigInt(configStore.current().config.agent.history_messages)}
       ORDER BY conversation_id, telegram_date, telegram_message_id`,
    );
    // One catch-up bucket per Conversation: forum topics are separate
    // sessions with their own participation state, and the bucket snapshot
    // does not filter its messages by conversation.
    const grouped = new Map<string, StartupMessageRow[]>();
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
                // still uses the persisted `startedAt`.
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
    const cleared = asRunResult(
      store.orm
        .delete(appState)
        .where(and(eq(appState.key, deps.startupCatchUpStateKey), eq(appState.value, startedAt.toISOString())))
        .run(),
    );
    if (cleared.changes !== 1) {
      throw new Error('Startup catch-up state was not cleared');
    }
    return invocationIds;
  });
}

// A chat outside its active periods only receives a catch-up bucket when a
// mention, reply, or keyword hit already refreshed its attention window.
function participationBlocks(deps: InvocationQueueDeps, message: StartupMessageRow, now: Date): boolean {
  const rule = deps.participation.ruleFor(deps.store.orm, message.telegram_chat_id, message.chat_type);
  return rule !== undefined && !isConversationActive(deps.store.orm, rule, message.conversation_id, now);
}
