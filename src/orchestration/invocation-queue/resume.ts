import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from '../../platform/agent-protocol.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { type DeliveryBlockReason, deliveryBlockReason, deliveryTarget } from '../../store/delivery-target.ts';
import { enqueueInvocation } from '../../store/invocation-enqueue.ts';
import { snapshotInvocation } from '../../store/invocation-snapshot.ts';
import { buckets, invocationBuckets, invocations } from '../../store/schema/index.ts';
import { storedSleepUntil } from '../../store/sleep.ts';
import type { BusinessStore, Orm } from '../../store/store.ts';
import type { HostReadiness } from '../host-scope.ts';

/**
 * Terminal states a resume may follow. `outcome_unknown` is included on
 * purpose: the operator accepts that a send may repeat, which is the whole
 * point of an unconditional resume.
 */
const RESUMABLE_STATES: ReadonlySet<string> = new Set(['failed', 'aborted', 'outcome_unknown']);

export type ResumeBlockReason =
  | 'not_found'
  | 'not_failed'
  | 'not_latest'
  | 'conversation_busy'
  | 'unsupported_host'
  | 'host_unavailable'
  | 'sleeping'
  | DeliveryBlockReason;

export type ResumeResult =
  | { readonly ok: true; readonly invocationId: bigint; readonly bucketId: bigint }
  | { readonly ok: false; readonly reason: ResumeBlockReason };

/**
 * Why an administrator cannot resume this invocation now, or undefined when
 * they can. Only the newest invocation of a Conversation qualifies: a resume
 * continues from the canonical Context, and that is only the same thing as
 * "run that batch again" while nothing has happened in the Conversation since.
 *
 * Read-only, so the detail view can ask it without touching the sleep row.
 */
export function resumeBlockReason(
  orm: Orm,
  config: RawConfig,
  invocationId: bigint,
  now: Date,
  isHostReady: HostReadiness,
): ResumeBlockReason | undefined {
  const source = orm
    .select({ conversationId: invocations.conversationId, state: invocations.state })
    .from(invocations)
    .where(eq(invocations.id, invocationId))
    .get();
  if (source === undefined) {
    return 'not_found';
  }
  if (!RESUMABLE_STATES.has(source.state)) {
    return 'not_failed';
  }
  const later = orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(and(eq(invocations.conversationId, source.conversationId), gt(invocations.id, invocationId)))
    .limit(1)
    .get();
  if (later !== undefined) {
    return 'not_latest';
  }
  // Receipt deliveries launch ahead of older queued work, so a queued run with
  // a smaller id can outlive a newer failed one.
  const busy = orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(
      and(eq(invocations.conversationId, source.conversationId), inArray(invocations.state, ['queued', 'running'])),
    )
    .limit(1)
    .get();
  if (busy !== undefined) {
    return 'conversation_busy';
  }
  const target = deliveryTarget(orm, source.conversationId);
  if (target === undefined) {
    return 'chat_removed';
  }
  // A Playground room retries through its own Release ledger; a run without a
  // Release would sit outside it.
  if (target.hostKind !== 'telegram') {
    return 'unsupported_host';
  }
  // The scheduler never launches work of a host that is disabled or not
  // connected; the run would sit queued and block every later resume.
  if (!isHostReady('telegram')) {
    return 'host_unavailable';
  }
  const blocked = deliveryBlockReason(orm, config, target);
  if (blocked !== undefined) {
    return blocked;
  }
  // The scheduler would skip the queued run as `sleeping`; refusing here tells
  // the operator instead of failing out of sight.
  const sleepUntil = storedSleepUntil(orm);
  if (sleepUntil !== null && sleepUntil > now.toISOString()) {
    return 'sleeping';
  }
  return undefined;
}

/**
 * Queues a new invocation that continues the failed one. When the failed
 * batch already reached the canonical Context (the usual case: it is written
 * before the first model call), the new run opens with an empty batch, since
 * copying the snapshot would inject the same messages twice; the context
 * builder recognises the link and tells the model why it runs without new
 * messages. When the batch never got in (a crash or a failure before the
 * opening injection), its frozen snapshot is copied instead, so the new run
 * sees exactly what the failed one should have seen. The run uses whatever
 * configuration is active when it launches, so switching the model first is
 * how an operator retries on another model.
 */
export function resumeInvocation(
  store: BusinessStore,
  configStore: RuntimeConfigurationStore,
  invocationId: bigint,
  isHostReady: HostReadiness,
  now = new Date(),
): ResumeResult {
  return store.transaction(() => {
    const current = configStore.current();
    const reason = resumeBlockReason(store.orm, current.config, invocationId, now, isHostReady);
    if (reason !== undefined) {
      return { ok: false, reason };
    }
    const source = store.orm
      .select({ conversationId: invocations.conversationId, bucketId: invocations.bucketId })
      .from(invocations)
      .where(eq(invocations.id, invocationId))
      .get();
    if (source === undefined) {
      return { ok: false, reason: 'not_found' };
    }
    const timestamp = now.toISOString();
    const bucket = store.orm
      .insert(buckets)
      .values({
        conversationId: source.conversationId,
        state: 'queued',
        kind: 'realtime',
        firstReceivedAt: timestamp,
        deadlineAt: timestamp,
        queuedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: buckets.id })
      .get();
    if (bucket === undefined) {
      throw new Error('buckets insert returned no row');
    }
    const resumed = enqueueInvocation(store.orm, {
      bucketId: bucket.id,
      conversationId: source.conversationId,
      configHash: current.hash,
      promptVersion: AGENT_PROMPT_VERSION,
      createdAt: timestamp,
      resumedFromInvocationId: invocationId,
    });
    const opening = store.orm
      .select({ injectedAt: invocationBuckets.injectedAt })
      .from(invocationBuckets)
      .where(and(eq(invocationBuckets.invocationId, invocationId), eq(invocationBuckets.bucketId, source.bucketId)))
      .get();
    if (opening?.injectedAt === null) {
      // Only the opening batch and its history: later batches can only have
      // been attached after the opening injection, which never happened, and
      // the failed run already released them as their own work.
      store.orm.run(
        sql`INSERT INTO invocation_messages
              (invocation_id, source_bucket_id, sequence_no, message_id, revision_id, section, omitted_before, snapshot_json, snapshot_format)
            SELECT ${resumed}, CASE WHEN section = 'new' THEN ${bucket.id} ELSE NULL END, sequence_no, message_id,
                   revision_id, section, omitted_before, snapshot_json, snapshot_format
            FROM invocation_messages
            WHERE invocation_id = ${invocationId} AND (section = 'history' OR source_bucket_id = ${source.bucketId})`,
      );
    } else {
      // History rides along like a task receipt's: the builder drops whatever
      // the canonical Context already holds.
      snapshotInvocation(store, current.config.agent.history_messages, resumed, bucket.id, source.conversationId, true);
    }
    return { ok: true, invocationId: resumed, bucketId: bucket.id };
  });
}
