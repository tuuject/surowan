import { and, asc, eq, or } from 'drizzle-orm';
import type { ListedTask } from './index.ts';
import { parseJson } from './json.ts';
import { longTasks, taskReceipts } from '../schema/index.ts';
import type { Orm } from '../store.ts';

const MAX_INT64 = 9_223_372_036_854_775_807n;

export function positiveInt64(id: bigint): bigint {
  if (id <= 0n || id > MAX_INT64) {
    throw new Error('ID must be a positive int64');
  }
  return id;
}

function listed(row: {
  id: bigint;
  payloadJson: string;
  state: string;
  scheduledAt: string | null;
  createdAt: string;
}): ListedTask {
  if (row.state !== 'waiting' && row.state !== 'completed' && row.state !== 'failed' && row.state !== 'cancelled') {
    throw new Error('Invalid task state in database');
  }
  return {
    id: row.id,
    payload: parseJson(row.payloadJson, 'task payload'),
    state: row.state,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
  };
}

export function getTask(
  orm: Orm,
  pluginId: string,
  conversationId: bigint,
  taskId: bigint,
  callerId: bigint | null,
  restricted: boolean,
): ListedTask | undefined {
  if (restricted && callerId === null) {
    return undefined;
  }
  const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
  const row = orm
    .select({
      id: longTasks.id,
      payloadJson: longTasks.payloadJson,
      state: longTasks.state,
      scheduledAt: longTasks.scheduledAt,
      createdAt: longTasks.createdAt,
    })
    .from(longTasks)
    .where(
      and(
        eq(longTasks.id, taskId),
        eq(longTasks.pluginId, pluginId),
        eq(longTasks.conversationId, conversationId),
        owner,
      ),
    )
    .get();
  return row === undefined ? undefined : listed(row);
}

export function listTasks(
  orm: Orm,
  pluginId: string,
  conversationId: bigint,
  callerId: bigint | null,
  restricted: boolean,
): ListedTask[] {
  if (restricted && callerId === null) {
    return [];
  }
  const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
  const visible = restricted ? or(eq(longTasks.state, 'waiting'), eq(taskReceipts.state, 'pending')) : undefined;
  return orm
    .select({
      id: longTasks.id,
      payloadJson: longTasks.payloadJson,
      state: longTasks.state,
      scheduledAt: longTasks.scheduledAt,
      createdAt: longTasks.createdAt,
    })
    .from(longTasks)
    .leftJoin(taskReceipts, eq(taskReceipts.taskId, longTasks.id))
    .where(and(eq(longTasks.pluginId, pluginId), eq(longTasks.conversationId, conversationId), owner, visible))
    .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
    .all()
    .map(listed);
}
