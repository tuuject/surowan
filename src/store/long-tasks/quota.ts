import { and, eq, sql } from 'drizzle-orm';
import { longTasks } from '../schema/index.ts';
import type { Orm } from '../store.ts';

export class TaskQuotaError extends Error {
  constructor() {
    super('Task quota exceeded for this invocation');
    this.name = 'TaskQuotaError';
  }
}

/**
 * How many of one plugin's tasks a single invocation may hold. `created`
 * counts every task the invocation created, settled or not: an alarm waits for
 * days and can be cancelled and re-created, so only the total bounds it.
 * `waiting` counts only the unsettled ones, so a slot frees the moment its task
 * completes, fails or is cancelled: an image generation settles in seconds,
 * and an invocation that follow-up messages keep alive must not run out of
 * slots for one request after another.
 */
export interface InvocationQuota {
  readonly max: number;
  readonly counts: 'created' | 'waiting';
}

export function assertInvocationQuota(quota: InvocationQuota): void {
  if (!Number.isSafeInteger(quota.max) || quota.max < 1) {
    throw new Error('invocationQuota.max must be a safe integer >= 1');
  }
}

/** Counts the invocation's tasks of one plugin under the quota's rule. */
export function invocationAtQuota(orm: Orm, pluginId: string, invocationId: bigint, quota: InvocationQuota): boolean {
  assertInvocationQuota(quota);
  const filters = [eq(longTasks.pluginId, pluginId), eq(longTasks.createdByInvocationId, invocationId)];
  if (quota.counts === 'waiting') {
    filters.push(eq(longTasks.state, 'waiting'));
  }
  const count =
    orm
      .select({ count: sql<bigint>`count(*)` })
      .from(longTasks)
      .where(and(...filters))
      .get()?.count ?? 0n;
  return count >= BigInt(quota.max);
}
