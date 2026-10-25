/**
 * The one place a queued invocation row is created.
 *
 * Telegram buckets and room releases both enqueue work; they must agree on the
 * row shape, the attached bucket and the queued state, so the scheduler and
 * every recovery path see the same thing. The caller supplies the policy
 * values, because a room release leaves them frozen from its own config.
 */
import type { Orm } from './store.ts';
import { invocationBuckets, invocations } from './schema/index.ts';

export interface QueuedInvocationInput {
  readonly bucketId: bigint;
  readonly conversationId: bigint;
  readonly configHash: string;
  readonly promptVersion: bigint;
  readonly createdAt: string;
}

/** Insert a queued invocation and attach its bucket. */
export function enqueueInvocation(orm: Orm, input: QueuedInvocationInput): bigint {
  const created = orm
    .insert(invocations)
    .values({
      bucketId: input.bucketId,
      conversationId: input.conversationId,
      state: 'queued',
      configHash: input.configHash,
      promptVersion: input.promptVersion,
      createdAt: input.createdAt,
    })
    .returning({ id: invocations.id })
    .get();
  if (created === undefined) {
    throw new Error('invocations insert returned no row');
  }
  // The opening bucket is joined like every attached one, so terminal state
  // transitions and un-injected releases can be uniform.
  orm
    .insert(invocationBuckets)
    .values({ invocationId: created.id, bucketId: input.bucketId, attachedAt: input.createdAt })
    .run();
  return created.id;
}
