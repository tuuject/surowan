import { and, eq, gt, inArray } from 'drizzle-orm';
import { AGENT_PROMPT_VERSION } from '../../platform/agent-protocol.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { type DeliveryBlockReason, deliveryBlockReason, deliveryTarget } from '../../store/delivery-target.ts';
import { enqueueInvocation } from '../../store/invocation-enqueue.ts';
import { snapshotInvocation } from '../../store/invocation-snapshot.ts';
import { buckets, invocations } from '../../store/schema/index.ts';
import { storedSleepUntil } from '../../store/sleep.ts';
import type { BusinessStore, Orm } from '../../store/store.ts';

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
  | 'sleeping'
  | DeliveryBlockReason;

export type ResumeResult =
  | { readonly ok: true; readonly invocationId: bigint; readonly bucketId: bigint }
  | { readonly ok: false; readonly reason: ResumeBlockReason };

/**
 * Why an administrator cannot resume this invocation now, or undefined when
 * they can. Only the newest invocation of a Conversation qualifies: the failed
 * batch is already in the canonical Context, so a resume continues from there,
 * and that is only the same thing as "run that batch again" while nothing has
 * happened in the Conversation since.
 *
 * Read-only, so the detail view can ask it without touching the sleep row.
 */
export function resumeBlockReason(
  orm: Orm,
  config: RawConfig,
  invocationId: bigint,
  now: Date,
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
 * Queues a new invocation that continues the failed one. It opens with an
 * empty batch: the failed batch already reached the canonical Context, so
 * copying its snapshot would inject the same messages twice. The context
 * builder recognises the link and tells the model why it runs without new
 * messages. The run uses whatever configuration is active when it launches,
 * so switching the model first is how an operator retries on another model.
 */
export function resumeInvocation(
  store: BusinessStore,
  configStore: RuntimeConfigurationStore,
  invocationId: bigint,
  now = new Date(),
): ResumeResult {
  return store.transaction(() => {
    const current = configStore.current();
    const reason = resumeBlockReason(store.orm, current.config, invocationId, now);
    if (reason !== undefined) {
      return { ok: false, reason };
    }
    const source = store.orm
      .select({ conversationId: invocations.conversationId })
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
    // History rides along like a task receipt's: the builder drops whatever
    // the canonical Context already holds.
    snapshotInvocation(store, current.config.agent.history_messages, resumed, bucket.id, source.conversationId, true);
    return { ok: true, invocationId: resumed, bucketId: bucket.id };
  });
}
