import { and, eq } from 'drizzle-orm';
import type { HostKind } from '../platform/im-host.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { snapshotInvocation } from '../store/invocation-snapshot.ts';
import { LongTaskService } from '../store/long-tasks.ts';
import { ParticipationRegistry } from '../store/participation.ts';
import { buckets, invocationBuckets } from '../store/schema.ts';
import type { BusinessStore } from '../store/store.ts';
import { everyHostReady, type HostReadiness } from './host-scope.ts';
import { processDueBuckets } from './invocation-queue/due.ts';
import {
  releaseUninjectedBuckets as releaseUninjected,
  skipQueuedInvocations as skipQueued,
  suppressInvalidQueuedReceipts as suppressInvalidQueued,
} from './invocation-queue/outcomes.ts';
import { processReceiptsDue } from './invocation-queue/receipts.ts';
import { finishRuntimeCatchUpQueue } from './invocation-queue/catch-up.ts';
import { finishStartupCatchUpQueue, recoverQueue } from './invocation-queue/recovery.ts';
import { type InvocationQueueDeps, sleepUntilFor } from './invocation-queue/shared.ts';
import { ProactiveReplyGate, type ProactiveReplyGateOptions } from './proactive-reply.ts';

export const RECOVERY_MAX_AGE_MS = 5 * 60_000;
export const STARTUP_CATCH_UP_STATE_KEY = 'telegram_startup_catch_up';
/** Floor for re-checking a batch that is due but whose conversation is mid-round. */
export const MINIMUM_DEFER_MS = 250;

/**
 * Attach side of long-lived invocations. The queue service owns every database
 * transition; it only needs these answers from the runtime that owns the
 * in-memory agent: "is this run still accepting work", "is it between rounds"
 * and "wake it up".
 */
export interface BucketAttachmentTarget {
  isClosing(conversationId: bigint): boolean;
  /** True from the moment a batch is injected until that round's last turn ends. */
  isRoundInProgress(conversationId: bigint): boolean;
  queueInjection(conversationId: bigint, bucketId: bigint, kind?: 'messages' | 'completion'): void;
}

/**
 * Moves one collecting bucket into a running invocation and freezes its
 * messages there, so later edits never change the batch the model will see.
 * Callers run it inside their transaction and then queue the injection. Shared
 * by the due-bucket attach below and the send barrier in `AgentRuntime`.
 */
export function attachBucketToInvocation(
  store: BusinessStore,
  historyMessages: number,
  invocationId: bigint,
  bucketId: bigint,
  conversationId: bigint,
  now: Date,
): void {
  const timestamp = now.toISOString();
  store.orm.insert(invocationBuckets).values({ invocationId, bucketId, attachedAt: timestamp }).run();
  store.orm
    .update(buckets)
    .set({ state: 'running', startedAt: timestamp, updatedAt: timestamp })
    .where(and(eq(buckets.id, bucketId), eq(buckets.state, 'collecting')))
    .run();
  snapshotInvocation(store, historyMessages, invocationId, bucketId, conversationId, false, { append: true });
}

/**
 * Synchronous state transitions that turn due buckets and task receipts into queued
 * invocations, plus crash recovery and startup catch-up. No timers live here:
 * the scheduler drives these methods from its event loop.
 *
 * The database work lives in `./invocation-queue/*`; this class owns the live
 * dependencies object the modules share, so there is exactly one in-memory
 * state and every module mutates it by reference.
 */
export class InvocationQueueService {
  readonly #deps: InvocationQueueDeps;

  constructor(
    store: BusinessStore,
    configStore: RuntimeConfigurationStore,
    attachment?: BucketAttachmentTarget,
    tasks = new LongTaskService(store.orm),
    proactive?: ProactiveReplyGateOptions,
    hosts?: readonly HostKind[],
    isHostReady: HostReadiness = everyHostReady,
  ) {
    /**
     * Conversations this process serves. Undefined means every host (a shared
     * process); a single-host process passes its own set so recovery, due
     * batches and receipts never read or write another host's work. Readiness
     * is applied per query, not copied, so a connection that becomes usable
     * resumes its work on the next pass.
     */
    this.#deps = {
      store,
      configStore,
      participation: new ParticipationRegistry(configStore),
      attachment,
      tasks,
      hosts: hosts === undefined || hosts.length === 0 ? undefined : hosts,
      isHostReady,
      // The global sleep state is Telegram's; a process without it never reads or clears it.
      servesTelegram: hosts === undefined || hosts.length === 0 || hosts.includes('telegram'),
      proactive: proactive === undefined ? undefined : new ProactiveReplyGate(store.orm, configStore, proactive),
      recoveryMaxAgeMs: RECOVERY_MAX_AGE_MS,
      startupCatchUpStateKey: STARTUP_CATCH_UP_STATE_KEY,
      minimumDeferMs: MINIMUM_DEFER_MS,
      attachBucketToInvocation,
    };
  }

  /** `activeSleepUntil` for a process that serves Telegram; null otherwise, without touching the row. */
  sleepUntil(now: Date): string | null {
    return sleepUntilFor(this.#deps, now);
  }

  recover(now = new Date()): void {
    recoverQueue(this.#deps, now);
  }

  finishStartupCatchUp(startedAt: Date, now = new Date()): bigint[] {
    return finishStartupCatchUpQueue(this.#deps, startedAt, now);
  }

  /** Materialises one runtime backlog pass; no process-wide drain marker involved. */
  finishRuntimeCatchUp(startedAt: Date, now = new Date()): bigint[] {
    return finishRuntimeCatchUpQueue(this.#deps, startedAt, now);
  }

  processDue(now = new Date()): bigint[] {
    return processDueBuckets(this.#deps, now);
  }

  releaseUninjectedBuckets(invocationId: bigint, now: Date): void {
    releaseUninjected(this.#deps, invocationId, now);
  }

  processTasksDue(now = new Date()): bigint[] {
    return processReceiptsDue(this.#deps, now);
  }

  /** Recheck destinations immediately before launch, not just when claiming. */
  suppressInvalidQueuedReceipts(now = new Date()): void {
    suppressInvalidQueued(this.#deps, now);
  }

  skipQueuedInvocations(sleepUntil: string, now: Date): void {
    skipQueued(this.#deps, sleepUntil, now);
  }
}
