import { and, eq, sql } from 'drizzle-orm';
import { longTasks, taskReceipts } from '../schema/index.ts';
import type { Orm } from '../store.ts';
import type { CancelOptions, CompletionOptions } from './index.ts';
import { MAX_ERROR, MAX_JSON, jsonText } from './json.ts';

/**
 * The settling writes of the task service: a waiting task completes, fails or
 * is cancelled exactly once, in the same transaction that writes its single
 * receipt. Each returns whether anything changed; the service wakes the
 * Scheduler when it did.
 */

export function finishTask(
  orm: Orm,
  pluginId: string,
  conversationId: bigint,
  taskId: bigint,
  status: 'completed' | 'failed',
  value: unknown | undefined,
  options: CompletionOptions | undefined,
  now = new Date(),
): boolean {
  const json =
    value === undefined
      ? null
      : jsonText(value, status === 'completed' ? MAX_JSON : MAX_ERROR, status === 'completed' ? 'result' : 'error');
  const at = now.toISOString();
  const changed = orm.transaction(
    () => {
      const update = orm
        .update(longTasks)
        .set({ state: status, finishedAt: at, updatedAt: at })
        .where(
          and(
            eq(longTasks.id, taskId),
            eq(longTasks.pluginId, pluginId),
            eq(longTasks.conversationId, conversationId),
            eq(longTasks.state, 'waiting'),
          ),
        )
        .run();
      if (update.changes === 0) {
        return false;
      }
      orm
        .insert(taskReceipts)
        .values({
          taskId,
          status,
          resultJson: status === 'completed' ? json : null,
          errorJson: status === 'failed' ? json : null,
          state: options?.notify === false ? 'suppressed' : 'pending',
          createdAt: at,
          updatedAt: at,
        })
        .run();
      return true;
    },
    { behavior: 'immediate' },
  );
  return changed;
}

export function cancelTask(
  orm: Orm,
  pluginId: string,
  conversationId: bigint,
  taskId: bigint,
  callerId: bigint | null,
  restricted: boolean,
  options: CancelOptions | undefined,
  now = new Date(),
): boolean {
  if (restricted && callerId === null) {
    return false;
  }
  const at = now.toISOString();
  const changed = orm.transaction(
    () => {
      const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
      const identity = and(
        eq(longTasks.id, taskId),
        eq(longTasks.pluginId, pluginId),
        eq(longTasks.conversationId, conversationId),
        owner,
      );
      const waiting = orm
        .update(longTasks)
        .set({ state: 'cancelled', finishedAt: at, updatedAt: at })
        .where(and(identity, eq(longTasks.state, 'waiting')))
        .run();
      if (waiting.changes > 0) {
        orm
          .insert(taskReceipts)
          .values({
            taskId,
            status: 'cancelled',
            state: 'suppressed',
            createdAt: at,
            updatedAt: at,
            cancelledAt: at,
            cancelledBy: options?.cancelledBy ?? null,
            adminCancelled: options?.adminCancelled ?? false,
            cancelReason: options?.reason ?? null,
          })
          .run();
        return true;
      }
      const pending = orm
        .update(taskReceipts)
        .set({
          state: 'suppressed',
          updatedAt: at,
          cancelledAt: at,
          cancelledBy: options?.cancelledBy ?? null,
          adminCancelled: options?.adminCancelled ?? false,
          cancelReason: options?.reason ?? null,
        })
        .where(
          and(
            eq(taskReceipts.taskId, taskId),
            eq(taskReceipts.state, 'pending'),
            sql`EXISTS (SELECT 1 FROM long_tasks lt WHERE lt.id = ${taskReceipts.taskId} AND lt.plugin_id = ${pluginId} AND lt.conversation_id = ${conversationId}${restricted && callerId !== null ? sql` AND lt.created_by_user_id = ${callerId}` : sql``})`,
          ),
        )
        .run();
      return pending.changes > 0;
    },
    { behavior: 'immediate' },
  );
  return changed;
}
