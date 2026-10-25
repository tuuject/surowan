import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { appState, buckets, chats, conversations, invocations, taskReceipts } from '../../store/schema.ts';
import { asRunResult } from '../../store/store.ts';
import { materializeCatchUpBuckets, selectCatchUpMessages } from './catch-up.ts';
import { type InvocationQueueDeps, processConversations } from './shared.ts';

/** Crash recovery: close work a previous process left `running`/`queued`. */
export function recoverQueue(deps: InvocationQueueDeps, now = new Date()): void {
  const store = deps.store;
  store.transaction(() => {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - deps.recoveryMaxAgeMs).toISOString();
    store.orm.run(
      sql`UPDATE invocations SET state = CASE WHEN side_effect_started = 1 THEN 'outcome_unknown' ELSE 'aborted' END, completion_reason = 'process_restart', finished_at = ${nowIso}
          WHERE state = 'running' AND ${processConversations(deps, sql`conversation_id`)}`,
    );
    // Every attached bucket — the opening one included — decides its state
    // from the invocation it was attached to, not from `invocations.bucket_id`.
    store.orm.run(
      sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id WHERE ib.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
         WHERE state = 'running' AND ${processConversations(deps, sql`conversation_id`)}
           AND EXISTS (SELECT 1 FROM invocation_buckets ib WHERE ib.bucket_id = buckets.id)`,
    );
    store.orm.run(
      sql`UPDATE buckets SET state = CASE WHEN EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id AND i.state = 'outcome_unknown') THEN 'outcome_unknown' ELSE 'aborted' END, error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
          WHERE state = 'running' AND ${processConversations(deps, sql`conversation_id`)}`,
    );
    // A claim is never replayed: the send outcome can be unknown even when the
    // invocation link is missing or already terminal. Close queued work
    // before ordinary age-based recovery can overwrite its restart reason.
    store.orm.run(
      sql`UPDATE buckets SET state = 'aborted', error_code = 'process_restart', finished_at = ${nowIso}, updated_at = ${nowIso}
         WHERE ${processConversations(deps, sql`conversation_id`)}
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
         WHERE state = 'queued' AND ${processConversations(deps, sql`conversation_id`)}
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
          sql`${taskReceipts.taskId} IN (SELECT t.id FROM long_tasks t WHERE ${processConversations(deps, sql`t.conversation_id`)})`,
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
          processConversations(deps, sql`${buckets.conversationId}`),
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

/**
 * Startup catch-up: turn messages received while the process was down into
 * buckets. The marker makes the selection and the drain one unit of work, so a
 * crash mid-drain resumes against the same boundary; only this cold path owns
 * that marker.
 */
export function finishStartupCatchUpQueue(deps: InvocationQueueDeps, startedAt: Date, now = new Date()): bigint[] {
  const store = deps.store;
  return store.transaction(() => {
    const state = store.orm
      .select({ value: appState.value })
      .from(appState)
      .where(eq(appState.key, deps.startupCatchUpStateKey))
      .get();
    if (state?.value !== startedAt.toISOString()) {
      throw new Error('Startup catch-up state changed before scheduling');
    }
    const invocationIds = materializeCatchUpBuckets(
      deps,
      selectCatchUpMessages(deps, startedAt, false),
      startedAt,
      now,
    );
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
