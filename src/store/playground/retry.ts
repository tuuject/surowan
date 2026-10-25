/**
 * Retrying a terminated, side-effect-free release attempt: every guard that
 * proves the run touched nothing, then a fresh invocation over a copy of the
 * frozen snapshot.
 */
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { enqueueInvocation } from '../invocation-enqueue.ts';
import type { RetryInput, RetryResult } from './index.ts';
import {
  buckets,
  invocationBuckets,
  invocations,
  longTasks,
  modelCalls,
  playgroundReleases,
  playgroundRetries,
  taskReceipts,
} from '../schema/index.ts';
import { PlaygroundError, type PlaygroundDeps, roomRow } from './shared.ts';

export function retry(deps: PlaygroundDeps, chatId: bigint, input: RetryInput): RetryResult {
  const now = deps.clock().toISOString();
  return deps.orm.transaction(() => {
    const existing = deps.orm
      .select()
      .from(playgroundRetries)
      .where(and(eq(playgroundRetries.chatId, chatId), eq(playgroundRetries.attemptKey, input.attemptKey)))
      .get();
    if (existing !== undefined) {
      // An attempt key names one retry of one release: the same key sent to
      // another release is a different request, not a lost response.
      if (existing.releaseId !== input.releaseId) {
        throw new PlaygroundError(
          'input_conflict',
          `attempt key ${input.attemptKey} was already used for release ${existing.releaseId}`,
        );
      }
      return {
        retryId: existing.id,
        invocationId: existing.invocationId,
        bucketId: bucketIdOfInvocation(deps, existing.invocationId),
        replayed: true,
      };
    }
    const room = roomRow(deps, chatId);
    if (room === undefined) {
      throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
    }
    const release = deps.orm
      .select()
      .from(playgroundReleases)
      .where(and(eq(playgroundReleases.id, input.releaseId), eq(playgroundReleases.chatId, chatId)))
      .get();
    if (release === undefined || release.invocationId === null) {
      throw new PlaygroundError('unknown_release', `release ${input.releaseId} has no invocation`);
    }
    const later = deps.orm
      .select({ id: playgroundReleases.id })
      .from(playgroundReleases)
      .where(and(eq(playgroundReleases.chatId, chatId), gt(playgroundReleases.id, release.id)))
      .get();
    if (later !== undefined) {
      throw new PlaygroundError('retry_refused', 'a later release exists in this room');
    }
    // Every guard below judges the release's latest attempt. The first
    // invocation stays failed after it was retried, so checking it again
    // would let a second attempt key queue the same batch twice.
    const latestRetry = deps.orm
      .select({ invocationId: playgroundRetries.invocationId })
      .from(playgroundRetries)
      .where(eq(playgroundRetries.releaseId, release.id))
      .orderBy(desc(playgroundRetries.id))
      .get();
    const attemptInvocationId = latestRetry?.invocationId ?? release.invocationId;
    const original = deps.orm.select().from(invocations).where(eq(invocations.id, attemptInvocationId)).get();
    if (original === undefined) {
      throw new PlaygroundError('unknown_release', `invocation ${attemptInvocationId} does not exist`);
    }
    // Only a known, terminated attempt may be retried. `outcome_unknown`
    // is exactly the case we must not double-run.
    if (original.state !== 'failed' && original.state !== 'aborted') {
      throw new PlaygroundError('retry_refused', `invocation is ${original.state}`);
    }
    if (original.sideEffectStarted || original.sendsUsed > 0n || original.toolCallsUsed > 0n) {
      throw new PlaygroundError('retry_refused', 'invocation started side effects');
    }
    const modelCall = deps.orm
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(eq(modelCalls.invocationId, original.id))
      .get();
    if (modelCall !== undefined) {
      throw new PlaygroundError('retry_refused', 'invocation called a model');
    }
    const injected = deps.orm.all<{ count: bigint }>(
      sql`SELECT COUNT(*) AS count FROM context_messages WHERE invocation_id = ${original.id}`,
    )[0];
    if (injected !== undefined && Number(injected.count) > 0) {
      throw new PlaygroundError('retry_refused', 'invocation already injected context');
    }
    const sent = deps.orm.all<{ id: bigint }>(
      sql`SELECT hs.id FROM host_sends hs
            JOIN tool_calls tc ON tc.id = hs.tool_call_id
            WHERE tc.invocation_id = ${original.id}
            LIMIT 1`,
    )[0];
    if (sent !== undefined) {
      throw new PlaygroundError('retry_refused', 'invocation already sent a message');
    }
    const receipt = deps.orm
      .select({ id: taskReceipts.invocationId })
      .from(taskReceipts)
      .where(eq(taskReceipts.invocationId, original.id))
      .get();
    if (receipt !== undefined) {
      throw new PlaygroundError('retry_refused', 'invocation has a task receipt');
    }
    const longTask = deps.orm
      .select({ id: longTasks.id })
      .from(longTasks)
      .where(eq(longTasks.createdByInvocationId, original.id))
      .get();
    if (longTask !== undefined) {
      throw new PlaygroundError('retry_refused', 'invocation started a long task');
    }
    const bucket = deps.orm
      .insert(buckets)
      .values({
        conversationId: room.conversationId,
        state: 'queued',
        kind: 'realtime',
        firstReceivedAt: now,
        deadlineAt: now,
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: buckets.id })
      .get();
    if (bucket === undefined) {
      throw new Error('failed to seal retry bucket');
    }
    const invocationId = enqueueInvocation(deps.orm, {
      bucketId: bucket.id,
      conversationId: room.conversationId,
      configHash: original.configHash,
      promptVersion: original.promptVersion,
      createdAt: now,
    });
    // Copy the frozen snapshot. The retry must run the same messages, not
    // whatever is held now.
    deps.orm.run(
      sql`INSERT INTO invocation_messages
              (invocation_id, source_bucket_id, sequence_no, message_id, revision_id, section, snapshot_json, snapshot_format)
            SELECT ${invocationId}, ${bucket.id}, sequence_no, message_id, revision_id, section, snapshot_json, snapshot_format
            FROM invocation_messages WHERE invocation_id = ${original.id}`,
    );
    const retry = deps.orm
      .insert(playgroundRetries)
      .values({
        chatId,
        releaseId: release.id,
        invocationId,
        retryOfInvocationId: original.id,
        attemptKey: input.attemptKey,
        createdAt: now,
      })
      .returning({ id: playgroundRetries.id })
      .get();
    if (retry === undefined) {
      throw new Error('failed to record retry');
    }
    return { retryId: retry.id, invocationId, bucketId: bucket.id, replayed: false };
  });
}

function bucketIdOfInvocation(deps: PlaygroundDeps, invocationId: bigint): bigint {
  return (
    deps.orm
      .select({ bucketId: invocationBuckets.bucketId })
      .from(invocationBuckets)
      .where(eq(invocationBuckets.invocationId, invocationId))
      .get()?.bucketId ?? 0n
  );
}
