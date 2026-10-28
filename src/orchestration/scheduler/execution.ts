import { and, eq, sql } from 'drizzle-orm';
import type { HostKind } from '../../platform/im-host/identity.ts';
import { resolveBucketWindowSeconds } from '../../platform/config/resolve.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { chats, conversations, invocations, taskReceipts } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { WarningService } from '../../store/warnings.ts';
import type { InvocationQueueService } from '../invocation-queue/index.ts';
import type { InvocationHandler, InvocationOutcome } from './index.ts';

export interface ActiveInvocation {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export interface InvocationRow {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
}

interface InvocationDiagnosticRow {
  readonly host_kind: string;
  readonly telegram_chat_id: bigint | null;
  readonly bucket_message_count: bigint;
  readonly pending_bucket_count: bigint;
  readonly chat_pending_bucket_count: bigint;
  readonly previous_started_at: string | null;
}

/** Mutable bookkeeping this module owns on the scheduler's behalf. */
export type InvocationExecutionState = {
  lastForcedGcAt: number;
};

/**
 * What one invocation run needs from the scheduler. `active` and `state` are the
 * scheduler's own objects: the map it adds entries to and the fields it reports
 * on, not copies, so every change here is visible to it immediately.
 */
export type InvocationExecutionDeps = {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly queue: InvocationQueueService;
  readonly handler: InvocationHandler;
  readonly active: Map<string, ActiveInvocation>;
  readonly state: InvocationExecutionState;
  readonly warnings?: WarningService;
  readonly processDue: (now: Date) => bigint[];
  readonly processTasksDue: (now: Date) => bigint[];
  readonly wake: () => void;
};

export async function executeInvocation(
  deps: InvocationExecutionDeps,
  invocation: InvocationRow,
  snapshot: InvocationConfigSnapshot,
  controller: AbortController,
): Promise<void> {
  const executionStartedAt = performance.now();
  logInvocationDiagnostic(deps, 'agent_invocation_start', invocation, deps.active.size + 1, null, null, null);
  let outcome: InvocationOutcome;
  try {
    outcome = await deps.handler(invocation.id, snapshot, controller.signal);
  } catch {
    // A handler that throws is a runtime fault: persist an outcome code rather
    // than `error.name`, which reads as "Error" for a plain Error and told
    // operators nothing. `AgentRuntime.run` logs the message itself.
    const aborted = controller.signal.aborted;
    outcome = {
      state: aborted ? 'aborted' : 'failed',
      reason: aborted ? 'aborted' : 'invocation_error',
    };
  }
  const finishedAt = new Date();
  let persisted = false;
  try {
    deps.store.transaction(() => {
      const nowIso = finishedAt.toISOString();
      deps.store.orm
        .update(invocations)
        .set({ state: outcome.state, completionReason: outcome.reason, finishedAt: nowIso })
        .where(and(eq(invocations.id, invocation.id), eq(invocations.state, 'running')))
        .run();
      // Release first, close second. The two statements both target buckets in
      // `invocation_buckets`, and closing first left every un-injected batch in
      // a terminal state, which made the release a no-op that still queued a new
      // invocation: the batch was re-processed while its bucket read `completed`.
      deps.queue.releaseUninjectedBuckets(invocation.id, finishedAt);
      // Every bucket this run actually consumed — opening bucket and injected
      // batches alike — closes with the invocation. Released batches are already
      // back to `queued` and must keep that state.
      deps.store.orm.run(
        sql`UPDATE buckets SET state = ${outcome.state}, finished_at = ${nowIso}, updated_at = ${nowIso}
             WHERE state = 'running'
               AND id IN (SELECT bucket_id FROM invocation_buckets WHERE invocation_id = ${invocation.id})`,
      );
      const started = deps.store.orm
        .all<{ started_at: string }>(sql`SELECT started_at FROM invocations WHERE id = ${invocation.id}`)
        .at(0);
      if (started === undefined) {
        throw new Error(`Invocation ${invocation.id} has no start time`);
      }
      // A bucket that was due while the chat was busy is not overdue once the
      // run ends: push it to the run's end so it starts with the next tick.
      // This only ever moves a deadline later; a batch still inside its own
      // window keeps that window, which is what makes every batch collect a
      // full `bucket_window_seconds` (see the ingestion comments).
      const chat = deps.store.orm
        .select({
          hostKind: chats.hostKind,
          chatId: conversations.chatId,
        })
        .from(conversations)
        .innerJoin(chats, eq(chats.id, conversations.chatId))
        .where(eq(conversations.id, invocation.conversation_id))
        .get();
      if (chat === undefined) {
        throw new Error(`Invocation ${invocation.id} has no chat`);
      }
      // The window follows the host: a room collects nothing. A Telegram
      // chat reads the live window, as ingestion does for the buckets it is
      // pushing back, so a reloaded window applies to both alike. Resolving
      // it from the host kind does not require the chat entry to still exist.
      const windowSeconds = resolveBucketWindowSeconds(deps.configStore.current().config, chat.hostKind as HostKind);
      const nextDeadline = new Date(
        Math.max(finishedAt.getTime(), Date.parse(started.started_at) + windowSeconds * 1_000),
      ).toISOString();
      deps.store.orm.run(
        sql`UPDATE buckets SET deadline_at = ${nextDeadline}, updated_at = ${nowIso}
             WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chat.chatId})
               AND state = 'collecting' AND deadline_at < ${nextDeadline}`,
      );
      deps.store.orm
        .update(taskReceipts)
        .set({
          state: 'handled',
          handledAt: nowIso,
          invocationOutcome: outcome.state,
          completionReason: outcome.reason,
          updatedAt: nowIso,
        })
        .where(and(eq(taskReceipts.invocationId, invocation.id), eq(taskReceipts.state, 'claimed')))
        .run();
    });
    persisted = true;
    // The terminal row is visible now, so the failure-rate warning samples this
    // run too. Recording must never change scheduling, so the service absorbs
    // its own errors.
    deps.warnings?.observeInvocation(finishedAt);
  } finally {
    deps.active.delete(invocation.id.toString());
    if (persisted) {
      deps.processTasksDue(finishedAt);
      deps.processDue(finishedAt);
    }
    logInvocationDiagnostic(
      deps,
      'agent_invocation_end',
      invocation,
      deps.active.size,
      Math.round(performance.now() - executionStartedAt),
      outcome,
      persisted,
    );
    deps.wake();
  }
}

function logInvocationDiagnostic(
  deps: InvocationExecutionDeps,
  event: 'agent_invocation_start' | 'agent_invocation_end',
  invocation: InvocationRow,
  activeAgentSessions: number,
  durationMs: number | null,
  outcome: InvocationOutcome | null,
  persisted: boolean | null,
): void {
  try {
    const now = new Date();
    const row = deps.store.orm
      .all<InvocationDiagnosticRow>(
        sql`SELECT c.host_kind, c.telegram_chat_id,
                  (SELECT COUNT(*) FROM bucket_messages bm WHERE bm.bucket_id = ${invocation.bucket_id}) AS bucket_message_count,
                  (SELECT COUNT(*) FROM buckets pb WHERE pb.state IN ('collecting', 'queued')) AS pending_bucket_count,
                  (SELECT COUNT(*) FROM buckets pb
                   JOIN conversations pv ON pv.id = pb.conversation_id
                   WHERE pv.chat_id = v.chat_id AND pb.state IN ('collecting', 'queued')) AS chat_pending_bucket_count,
                  (SELECT MAX(prior.started_at) FROM invocations prior
                   JOIN conversations prior_v ON prior_v.id = prior.conversation_id
                   WHERE prior_v.chat_id = v.chat_id AND prior.id < ${invocation.id} AND prior.started_at IS NOT NULL) AS previous_started_at
           FROM conversations v
           JOIN chats c ON c.id = v.chat_id
           WHERE v.id = ${invocation.conversation_id}`,
      )
      .at(0);
    if (row === undefined) {
      throw new Error('invocation_conversation_missing');
    }
    const currentStartedAt =
      deps.store.orm
        .all<{ started_at: string | null }>(sql`SELECT started_at FROM invocations WHERE id = ${invocation.id}`)
        .at(0)?.started_at ?? null;
    const recentInvocations =
      deps.store.orm
        .all<{ count: bigint }>(
          sql`SELECT COUNT(*) AS count FROM invocations WHERE started_at >= ${new Date(now.getTime() - 60_000).toISOString()}`,
        )
        .at(0)?.count ?? 0n;
    const memory = process.memoryUsage();
    let gcMemory: NodeJS.MemoryUsage | null = null;
    // Forced GC is a diagnostic aid, not a correctness requirement: it only
    // runs when the runtime exposes it (Node requires --expose-gc), and the
    // gc_* metrics simply stay null otherwise.
    const forceGc = (globalThis as { gc?: () => void }).gc;
    if (
      event === 'agent_invocation_end' &&
      forceGc !== undefined &&
      now.getTime() - deps.state.lastForcedGcAt >= 60_000
    ) {
      deps.state.lastForcedGcAt = now.getTime();
      forceGc();
      gcMemory = process.memoryUsage();
    }
    console.log(
      JSON.stringify({
        event,
        invocation_id: invocation.id.toString(),
        session_id: invocation.id.toString(),
        host_kind: row.host_kind,
        chat_id: row.telegram_chat_id?.toString() ?? null,
        bucket_message_count: Number(row.bucket_message_count),
        pending_bucket_count: Number(row.pending_bucket_count),
        chat_pending_bucket_count: Number(row.chat_pending_bucket_count),
        active_agent_sessions: activeAgentSessions,
        invocations_started_last_minute: Number(recentInvocations),
        invocation_duration_ms: durationMs,
        previous_invocation_gap_ms:
          currentStartedAt === null || row.previous_started_at === null
            ? null
            : Date.parse(currentStartedAt) - Date.parse(row.previous_started_at),
        outcome_state: outcome?.state ?? null,
        outcome_reason: outcome?.reason ?? null,
        terminal_state_persisted: persisted,
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        heap_total_bytes: memory.heapTotal,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
        forced_gc: gcMemory !== null,
        gc_rss_bytes: gcMemory?.rss ?? null,
        gc_heap_used_bytes: gcMemory?.heapUsed ?? null,
        gc_heap_total_bytes: gcMemory?.heapTotal ?? null,
        gc_external_bytes: gcMemory?.external ?? null,
        gc_array_buffers_bytes: gcMemory?.arrayBuffers ?? null,
        runtime_version: process.version,
        at: now.toISOString(),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'agent_invocation_diagnostic_failed',
        invocation_id: invocation.id.toString(),
        error: error instanceof Error ? error.name : 'diagnostic_error',
        at: new Date().toISOString(),
      }),
    );
  }
}
