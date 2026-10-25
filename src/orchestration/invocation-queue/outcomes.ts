import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { buckets, invocationBuckets, invocations, taskReceipts } from '../../store/schema/index.ts';
import { asRunResult } from '../../store/store.ts';
import {
  enqueueBucketInvocation,
  type InvocationQueueDeps,
  logSleepingSkip,
  type ReceiptRow,
  receiptCancelReason,
  servedConversations,
} from './shared.ts';

interface SleepingInvocationRow {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
  readonly telegram_chat_id: bigint;
}

/**
 * Re-queues buckets that were attached mid-run but never injected, so a batch
 * that arrived while the model was working is not silently dropped. The
 * opening bucket is excluded: it is the trigger of the run, so its state
 * follows the invocation's terminal transition instead.
 */
export function releaseUninjectedBuckets(deps: InvocationQueueDeps, invocationId: bigint, now: Date): void {
  const store = deps.store;
  const rows = store.orm
    .select({
      bucketId: invocationBuckets.bucketId,
      conversationId: buckets.conversationId,
      errorCode: buckets.errorCode,
    })
    .from(invocationBuckets)
    .innerJoin(buckets, eq(buckets.id, invocationBuckets.bucketId))
    .innerJoin(invocations, eq(invocations.id, invocationBuckets.invocationId))
    .where(
      and(
        eq(invocationBuckets.invocationId, invocationId),
        isNull(invocationBuckets.injectedAt),
        ne(invocationBuckets.bucketId, invocations.bucketId),
      ),
    )
    .all();
  for (const row of rows) {
    const timestamp = now.toISOString();
    const released = store.orm
      .update(buckets)
      .set({ state: 'queued', queuedAt: timestamp, updatedAt: timestamp })
      .where(and(eq(buckets.id, row.bucketId), eq(buckets.state, 'running')))
      .run();
    // An admin cancel expires attached batches before aborting the run; those
    // must not come back as a new invocation.
    if (asRunResult(released).changes === 0) {
      store.orm
        .update(taskReceipts)
        .set({
          state: 'suppressed',
          cancelledAt: timestamp,
          cancelReason: row.errorCode ?? 'bucket_unavailable',
          adminCancelled: row.errorCode === 'admin_cancel',
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(taskReceipts.bucketId, row.bucketId),
            eq(taskReceipts.invocationId, invocationId),
            eq(taskReceipts.state, 'claimed'),
          ),
        )
        .run();
      continue;
    }
    const nextInvocationId = enqueueBucketInvocation(deps, row.bucketId, row.conversationId, now, false);
    store.orm
      .update(taskReceipts)
      .set({ invocationId: nextInvocationId, updatedAt: timestamp })
      .where(
        and(
          eq(taskReceipts.bucketId, row.bucketId),
          eq(taskReceipts.invocationId, invocationId),
          eq(taskReceipts.state, 'claimed'),
        ),
      )
      .run();
    console.log(
      JSON.stringify({
        event: 'bucket_requeued',
        invocation_id: invocationId.toString(),
        bucket_id: row.bucketId.toString(),
        conversation_id: row.conversationId.toString(),
        at: timestamp,
      }),
    );
  }
}

/** Recheck destinations immediately before launch, not just when claiming. */
export function suppressInvalidQueuedReceipts(deps: InvocationQueueDeps, now = new Date()): void {
  const store = deps.store;
  store.transaction(() => {
    const rows = store.orm.all<ReceiptRow & { invocation_id: bigint }>(
      sql`SELECT r.task_id, r.invocation_id, t.conversation_id, v.chat_id, c.telegram_chat_id,
                 v.message_thread_id, c.host_kind AS host_kind,
                 json_extract(t.delivery_json, '$.bypassDailyBudget') AS bypass_daily_budget
          FROM task_receipts r JOIN long_tasks t ON t.id = r.task_id
          JOIN invocations i ON i.id = r.invocation_id
          JOIN conversations v ON v.id = t.conversation_id JOIN chats c ON c.id = v.chat_id
          WHERE r.state = 'claimed' AND i.state = 'queued'
            AND ${servedConversations(deps, sql`t.conversation_id`)}`,
    );
    const timestamp = now.toISOString();
    for (const receipt of rows) {
      const reason = receiptCancelReason(deps, receipt);
      if (reason === undefined) {
        continue;
      }
      store.orm
        .update(taskReceipts)
        .set({
          state: 'suppressed',
          cancelledAt: timestamp,
          cancelReason: reason,
          updatedAt: timestamp,
        })
        .where(eq(taskReceipts.taskId, receipt.task_id))
        .run();
      store.orm
        .update(invocations)
        .set({
          state: 'aborted',
          completionReason: reason,
          finishedAt: timestamp,
        })
        .where(eq(invocations.id, receipt.invocation_id))
        .run();
      store.orm.run(sql`UPDATE buckets SET state = 'aborted', error_code = ${reason},
        finished_at = ${timestamp}, updated_at = ${timestamp}
        WHERE id IN (SELECT bucket_id FROM invocation_buckets WHERE invocation_id = ${receipt.invocation_id})
           OR id IN (SELECT bucket_id FROM invocations WHERE id = ${receipt.invocation_id})`);
    }
  });
}

/** Closes every queued invocation that ordinary sleep policy must not start. */
export function skipQueuedInvocations(deps: InvocationQueueDeps, sleepUntil: string, now: Date): void {
  const store = deps.store;
  const queued = store.transaction(() => {
    const rows = store.orm.all<SleepingInvocationRow>(
      sql`SELECT i.id, i.bucket_id, i.conversation_id, c.telegram_chat_id
       FROM invocations i
       JOIN conversations v ON v.id = i.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE i.state = 'queued'
         AND c.host_kind = 'telegram'
         AND ${servedConversations(deps, sql`i.conversation_id`)}
         AND NOT EXISTS (
           SELECT 1 FROM task_receipts r JOIN long_tasks t ON t.id = r.task_id
           WHERE r.invocation_id = i.id AND r.state = 'claimed'
             AND json_extract(t.delivery_json, '$.bypassDailyBudget') = 1
         )
       ORDER BY i.id`,
    );
    for (const invocation of rows) {
      const nowIso = now.toISOString();
      store.orm
        .update(invocations)
        .set({ state: 'skipped_budget', completionReason: 'sleeping', finishedAt: nowIso })
        .where(and(eq(invocations.id, invocation.id), eq(invocations.state, 'queued')))
        .run();
      store.orm.run(sql`UPDATE buckets SET state = 'skipped_budget', error_code = 'sleeping',
        finished_at = ${nowIso}, updated_at = ${nowIso}
        WHERE id = ${invocation.bucket_id}
           OR id IN (SELECT bucket_id FROM invocation_buckets WHERE invocation_id = ${invocation.id})`);
      store.orm
        .update(taskReceipts)
        .set({
          state: 'handled',
          handledAt: nowIso,
          updatedAt: nowIso,
          invocationOutcome: 'skipped_budget',
          completionReason: 'sleeping',
        })
        .where(and(eq(taskReceipts.invocationId, invocation.id), eq(taskReceipts.state, 'claimed')))
        .run();
    }
    return rows;
  });
  for (const invocation of queued) {
    logSleepingSkip(invocation.telegram_chat_id, invocation.bucket_id, invocation.id, sleepUntil);
  }
}
