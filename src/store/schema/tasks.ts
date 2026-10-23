import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { conversations } from './core.ts';
import { buckets, invocations } from './invocation.ts';

export const longTasks = sqliteTable(
  'long_tasks',
  {
    id: sqliteBigIntId('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    createdByInvocationId: sqliteBigInt('created_by_invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    createdByUserId: sqliteBigInt('created_by_user_id'),
    payloadJson: text('payload_json').notNull(),
    state: text('state').notNull(),
    scheduledAt: text('scheduled_at'),
    timerResultJson: text('timer_result_json'),
    deliveryJson: text('delivery_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    check('long_tasks_state_check', sql`state IN ('waiting', 'completed', 'failed', 'cancelled')`),
    check(
      'long_tasks_payload_json_check',
      sql`json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384`,
    ),
    check(
      'long_tasks_timer_result_json_check',
      sql`timer_result_json IS NULL OR (json_valid(timer_result_json) AND length(CAST(timer_result_json AS BLOB)) <= 16384)`,
    ),
    check(
      'long_tasks_delivery_json_check',
      sql`json_valid(delivery_json) AND length(CAST(delivery_json AS BLOB)) <= 4096`,
    ),
    check('long_tasks_timer_pair_check', sql`(scheduled_at IS NULL) = (timer_result_json IS NULL)`),
    index('long_tasks_schedule_idx')
      .on(t.state, t.scheduledAt, t.id)
      .where(sql`state = 'waiting' AND scheduled_at IS NOT NULL`),
    index('long_tasks_plugin_conversation_idx').on(t.pluginId, t.conversationId, t.createdAt, t.id),
    index('long_tasks_created_by_inv_idx').on(t.createdByInvocationId),
  ],
);

export const taskReceipts = sqliteTable(
  'task_receipts',
  {
    taskId: sqliteBigInt('task_id')
      .primaryKey()
      .references(() => longTasks.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    errorJson: text('error_json'),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    claimedAt: text('claimed_at'),
    handledAt: text('handled_at'),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    bucketId: sqliteBigInt('bucket_id').references(() => buckets.id, { onDelete: 'set null' }),
    invocationOutcome: text('invocation_outcome'),
    completionReason: text('completion_reason'),
    cancelledAt: text('cancelled_at'),
    cancelledBy: text('cancelled_by'),
    adminCancelled: integer('admin_cancelled', { mode: 'boolean' }).notNull().default(false),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    check('task_receipts_status_check', sql`status IN ('completed', 'failed', 'cancelled')`),
    check('task_receipts_state_check', sql`state IN ('pending', 'claimed', 'handled', 'suppressed')`),
    check('task_receipts_admin_cancelled_check', sql`admin_cancelled IN (0, 1)`),
    check(
      'task_receipts_result_json_check',
      sql`result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384)`,
    ),
    check(
      'task_receipts_error_json_check',
      sql`error_json IS NULL OR (json_valid(error_json) AND length(CAST(error_json AS BLOB)) <= 8192)`,
    ),
    check(
      'task_receipts_content_check',
      sql`(status = 'completed' AND error_json IS NULL) OR (status = 'failed' AND result_json IS NULL) OR (status = 'cancelled' AND result_json IS NULL AND error_json IS NULL)`,
    ),
    index('task_receipts_invocation_idx').on(t.invocationId),
    uniqueIndex('task_receipts_bucket_unique').on(t.bucketId).where(sql`bucket_id IS NOT NULL`),
    index('task_receipts_delivery_idx').on(t.state, t.createdAt, t.taskId).where(sql`state = 'pending'`),
  ],
);
