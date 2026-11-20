import type { DecisionGateSettings } from '../../platform/decision-gate.ts';
import type { BusinessStore } from '../../store/store.ts';
import { markBucketSkipped } from '../invocation-queue/shared.ts';
import { bucketFingerprint, readBucketState } from './query.ts';
import { settleDecision } from './record.ts';
import type { DecisionCandidate, DecisionRecord, DecisionToken } from './types.ts';

/** The in-process marks phase 2 reads and edits. */
export interface DecisionMarks {
  /** Buckets a verdict released; the next pass skips the gate. */
  readonly released: Set<string>;
  /** Per-Bucket count of verdicts discarded because the batch grew. */
  readonly redecs: Map<string, number>;
}

export interface SettlementContext {
  readonly store: BusinessStore;
  readonly marks: DecisionMarks;
  readonly maxRedecisions: number;
  /** The Chat's settings under the currently published configuration. */
  readonly currentSettings: (candidate: DecisionCandidate) => DecisionGateSettings | undefined;
  /** Makes a still-collecting batch due now and wakes the scheduler. */
  readonly makeDue: (bucketId: bigint, at: Date) => void;
}

/**
 * Phase 2: one verdict against the Bucket, in its own transaction.
 *
 * `shadow` only updates the row. `enforce` re-reads the Bucket first — a batch
 * the send barrier, a pause sweep or a deletion took meanwhile is `stale` and
 * nothing else — then re-resolves the Chat's settings: a gate turned off or
 * switched to `shadow` mid-request must not withhold the batch. A verdict that
 * still holds releases the Bucket (the next pass skips the gate), drops it, or —
 * when the batch grew while the model was reading — discards the verdict and
 * allows two more decisions before admitting the batch.
 */
export function applyDecision(
  context: SettlementContext,
  token: DecisionToken,
  record: DecisionRecord,
  finishedAt: Date,
): { readonly record: DecisionRecord; readonly applied: boolean } {
  const candidate = token.candidate;
  const timestamp = finishedAt.toISOString();
  if (token.settings.mode === 'shadow') {
    settleDecision(context.store, token.decisionId, record, false, timestamp);
    return { record, applied: false };
  }
  const bucket = readBucketState(context.store.orm, candidate.bucketId);
  if (bucket?.state !== 'collecting') {
    const stale: DecisionRecord = { ...record, state: 'stale' };
    settleDecision(context.store, token.decisionId, stale, false, timestamp);
    return { record: stale, applied: false };
  }
  const current = context.currentSettings(candidate);
  if (current === undefined || !current.enabled || current.mode !== 'enforce') {
    settleDecision(context.store, token.decisionId, record, false, timestamp);
    context.makeDue(candidate.bucketId, finishedAt);
    return { record, applied: false };
  }
  if (record.outcome === 'enter') {
    release(context, candidate.bucketId);
    settleDecision(context.store, token.decisionId, record, true, timestamp);
    context.makeDue(candidate.bucketId, finishedAt);
    return { record, applied: true };
  }
  const fingerprint = token.plan.kind === 'request' ? token.plan.fingerprint : '';
  if (bucketFingerprint(context.store.orm, candidate.bucketId) === fingerprint) {
    markBucketSkipped({ store: context.store }, candidate.bucketId, finishedAt, 'decision_gate_dropped');
    settleDecision(context.store, token.decisionId, record, true, timestamp);
    return { record, applied: true };
  }
  const key = candidate.bucketId.toString();
  const attempts = context.marks.redecs.get(key) ?? 0;
  if (attempts < context.maxRedecisions) {
    context.marks.redecs.set(key, attempts + 1);
    const stale: DecisionRecord = { ...record, state: 'stale' };
    settleDecision(context.store, token.decisionId, stale, false, timestamp);
    context.makeDue(candidate.bucketId, finishedAt);
    return { record: stale, applied: false };
  }
  // The re-decision budget is spent: the batch enters, so no message is silently
  // withheld. `probability < threshold` on an `enter` row is exactly this case.
  release(context, candidate.bucketId);
  const entered: DecisionRecord = { ...record, state: 'success', outcome: 'enter' };
  settleDecision(context.store, token.decisionId, entered, true, timestamp);
  context.makeDue(candidate.bucketId, finishedAt);
  return { record: entered, applied: true };
}

function release(context: SettlementContext, bucketId: bigint): void {
  context.marks.released.add(bucketId.toString());
  context.marks.redecs.delete(bucketId.toString());
}
