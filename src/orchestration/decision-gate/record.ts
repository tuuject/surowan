import { eq, sql } from 'drizzle-orm';
import type { DecisionGateMode } from '../../platform/decision-gate.ts';
import { bucketDecisions } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { DecisionRecord } from './types.ts';

/** Phase 1: the `pending` row a crash leaves for startup recovery to close. */
export function insertPendingDecision(
  store: BusinessStore,
  input: {
    readonly bucketId: bigint;
    readonly conversationId: bigint;
    readonly mode: DecisionGateMode;
    readonly model: string;
    readonly threshold: number;
    readonly historyCount: bigint;
    readonly pendingCount: bigint;
    readonly createdAt: string;
  },
): bigint {
  const created = store.orm
    .insert(bucketDecisions)
    .values({
      bucketId: input.bucketId,
      conversationId: input.conversationId,
      mode: input.mode,
      model: input.model,
      state: 'pending',
      threshold: input.threshold,
      historyCount: input.historyCount,
      pendingCount: input.pendingCount,
      createdAt: input.createdAt,
    })
    .returning({ id: bucketDecisions.id })
    .get();
  if (created === undefined) {
    throw new Error('bucket_decisions insert returned no row');
  }
  return created.id;
}

export function settleDecision(
  store: BusinessStore,
  decisionId: bigint,
  record: DecisionRecord,
  applied: boolean,
  finishedAt: string,
): void {
  store.orm
    .update(bucketDecisions)
    .set({
      state: record.state,
      outcome: record.outcome,
      applied,
      probability: record.probability,
      threshold: record.threshold,
      inputTokens: record.inputTokens,
      cost: record.cost,
      durationMs: record.durationMs,
      errorCode: record.errorCode,
      errorDetail: record.errorDetail,
      finishedAt,
    })
    .where(eq(bucketDecisions.id, decisionId))
    .run();
}

/**
 * Pushes a batch's deadline out, never back. Same shape as `deferBucket`: an
 * update that would move the deadline earlier is a no-op, so a round that
 * already postponed the batch keeps its later anchor.
 */
export function pushDeadlineLater(store: BusinessStore, bucketId: bigint, atLeast: Date, now: Date): void {
  store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${atLeast.toISOString()}, updated_at = ${now.toISOString()}
       WHERE id = ${bucketId} AND state = 'collecting' AND deadline_at < ${atLeast.toISOString()}`,
  );
}

/** Makes a still-collecting batch due now, so the next pass takes it. */
export function makeDue(store: BusinessStore, bucketId: bigint, now: Date): void {
  store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
       WHERE id = ${bucketId} AND state = 'collecting' AND deadline_at > ${now.toISOString()}`,
  );
}
