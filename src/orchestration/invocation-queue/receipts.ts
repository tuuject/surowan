import { and, eq, sql } from 'drizzle-orm';
import { buckets, invocationBuckets, taskReceipts } from '../../store/schema/index.ts';
import {
  enqueueBucketInvocation,
  type InvocationQueueDeps,
  type ReceiptRow,
  receiptCancelReason,
  runningInvocationId,
  servedConversations,
  sleepUntilFor,
} from './shared.ts';

/** Claims pending task receipts and opens (or joins) the invocation that delivers them. */
export function processReceiptsDue(deps: InvocationQueueDeps, now = new Date()): bigint[] {
  const store = deps.store;
  // Completion is independent of chat availability; only receipt delivery
  // waits for a running chat or ordinary sleep policy.
  deps.tasks.processDue(now);
  const nowIso = now.toISOString();
  const sleepUntil = sleepUntilFor(deps, now);
  return store.transaction(() => {
    const pending = store.orm.all<ReceiptRow>(
      sql`SELECT r.task_id, t.conversation_id, v.chat_id, c.telegram_chat_id, v.message_thread_id,
                 c.host_kind AS host_kind,
                 json_extract(t.delivery_json, '$.bypassDailyBudget') AS bypass_daily_budget
       FROM task_receipts r JOIN long_tasks t ON t.id = r.task_id
       JOIN conversations v ON v.id = t.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE r.state = 'pending' AND ${servedConversations(deps, sql`t.conversation_id`)}
       ORDER BY r.created_at, r.task_id`,
    );
    const invocationIds: bigint[] = [];
    for (const receipt of pending) {
      const cancelReason = receiptCancelReason(deps, receipt);
      if (cancelReason !== undefined) {
        store.orm
          .update(taskReceipts)
          .set({
            state: 'suppressed',
            cancelledAt: nowIso,
            cancelReason,
            adminCancelled: false,
            updatedAt: nowIso,
          })
          .where(and(eq(taskReceipts.taskId, receipt.task_id), eq(taskReceipts.state, 'pending')))
          .run();
        continue;
      }
      // Only the Telegram host has a global sleep window; a Playground room
      // never waits out a chat sleep, and never inherits its bypass either.
      if (receipt.host_kind === 'telegram' && sleepUntil !== null && receipt.bypass_daily_budget !== 1n) {
        continue;
      }
      const running = runningInvocationId(deps, receipt.conversation_id);
      if (running !== undefined) {
        if (deps.attachment === undefined || deps.attachment.isClosing(receipt.conversation_id)) {
          continue;
        }
      } else if (chatRunning(deps, receipt.chat_id)) {
        continue;
      }
      const claimed = store.orm
        .update(taskReceipts)
        .set({ state: 'claimed', claimedAt: nowIso, updatedAt: nowIso })
        .where(and(eq(taskReceipts.taskId, receipt.task_id), eq(taskReceipts.state, 'pending')))
        .run();
      if (claimed.changes !== 1) {
        continue;
      }
      const invocationId = insertReceiptInvocation(deps, receipt, now, running);
      if (running === undefined) {
        invocationIds.push(invocationId);
      }
    }
    return invocationIds;
  });
}

function chatRunning(deps: InvocationQueueDeps, chatId: bigint): boolean {
  return (
    deps.store.orm
      .all<{ present: bigint }>(
        sql`SELECT 1 AS present FROM invocations i
         JOIN conversations v ON v.id = i.conversation_id
         WHERE v.chat_id = ${chatId} AND i.state = 'running'
         LIMIT 1`,
      )
      .at(0) !== undefined
  );
}

function insertReceiptInvocation(deps: InvocationQueueDeps, receipt: ReceiptRow, now: Date, running?: bigint): bigint {
  const store = deps.store;
  const timestamp = now.toISOString();
  const created = store.orm
    .insert(buckets)
    .values({
      conversationId: receipt.conversation_id,
      state: running === undefined ? 'queued' : 'running',
      kind: 'realtime',
      firstReceivedAt: timestamp,
      deadlineAt: timestamp,
      queuedAt: timestamp,
      startedAt: running === undefined ? null : timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning({ id: buckets.id })
    .get();
  if (created === undefined) {
    throw new Error('buckets insert returned no row');
  }
  const bucketId = created.id;
  const invocationId = running ?? enqueueBucketInvocation(deps, bucketId, receipt.conversation_id, now, true);
  if (running !== undefined) {
    store.orm.insert(invocationBuckets).values({ invocationId, bucketId, attachedAt: timestamp }).run();
  }
  store.orm.update(taskReceipts).set({ invocationId, bucketId }).where(eq(taskReceipts.taskId, receipt.task_id)).run();
  if (running !== undefined) {
    deps.attachment?.queueInjection(receipt.conversation_id, bucketId, 'completion');
  }
  return invocationId;
}
