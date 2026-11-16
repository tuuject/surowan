/**
 * Rebuilding and continuing: the second half of a cutover.
 *
 * This runs only after the stopped handlers have really settled. It rebuilds the
 * canonical Contexts, swaps the server instances, and decides per stopped run
 * what continues it — the batch the scheduler already released, a re-delivered
 * task completion, or a fresh empty continuation.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ConversationContextStore } from '../../../../context/store/index.ts';
import type { RawConfig } from '../../../../platform/config/index.ts';
import {
  consumedBatchHistoryLimit,
  resumeBlockReason,
  resumeInvocation,
} from '../../../../orchestration/invocation-queue/resume.ts';
import { encodeAbortUnknownTools } from '../../../../store/abort-cause.ts';
import { snapshotInvocation } from '../../../../store/invocation-snapshot.ts';
import { invocationBuckets, invocations, taskReceipts, toolCalls } from '../../../../store/schema/index.ts';
import type { Orm } from '../../../../store/store.ts';
import type {
  CutoverState,
  McpConfigPublishResult,
  McpCutoverDeps,
  SkippedResume,
  StoppedInvocation,
} from './shared.ts';
import { stopEverything } from './stop.ts';

/** The steps that may only run once every stopped handler has really settled. */
export async function finishCutover(
  deps: McpCutoverDeps,
  state: CutoverState,
  next: RawConfig,
  generation: number,
): Promise<
  Omit<McpConfigPublishResult, 'affectedChats' | 'stoppedInvocations' | 'conversations' | 'settled' | 'completion'>
> {
  // A Conversation created while the first pass waited is fenced and stopped
  // here instead of being swapped underneath. Whatever it already started used
  // the configuration published when it launched, which is the current one now.
  await stopEverything(deps, state, deps.configStore.current().config, 'settle');
  const stopped = [...state.stopped.values()];
  recordUnknownTools(deps.store.orm, stopped);
  const conversationIds = [...state.fenced].map(BigInt);
  for (const conversationId of conversationIds) {
    deps.forgetConversation(conversationId);
  }
  const rebuiltContexts = new ConversationContextStore(deps.store).rebuildForConversations(conversationIds, new Date());
  // Only now may the instances move: nothing was handed the old definitions
  // that could still call them.
  const servers = await deps.mcp.reconcile({ config: next, generation });
  const resumedInvocations: bigint[] = [];
  const skippedResumes: SkippedResume[] = [];
  const now = new Date();
  for (const row of stopped) {
    const current = deps.configStore.current().config;
    // A batch the stopped run received but never injected was released by the
    // scheduler's own terminal transition, which already queued a follow-up run
    // for it. That run is the continuation: adopt it (widened history + link)
    // instead of queueing a second one that `resumeBlockReason` would refuse.
    const released = releasedInvocation(deps.store.orm, row);
    if (released !== undefined) {
      resumedInvocations.push(adoptReleasedRun(deps, row, released, historyMessages(deps, row), now));
      continue;
    }
    const blocked = resumeBlockReason(deps.store.orm, current, row.id, now, deps.isHostReady);
    if (blocked !== undefined) {
      skippedResumes.push({ invocationId: row.id, reason: blocked });
      continue;
    }
    if (!row.roundInProgress) {
      // The run had finished its round and only waited for new messages: it
      // answered everything it injected, so a continuation would answer nothing.
      skippedResumes.push({ invocationId: row.id, reason: 'idle' });
      continue;
    }
    // A completion the stopped run was handling is re-delivered as the
    // continuation's opening batch: the rebuild dropped its payload from the
    // Context and an empty batch has no receipt to render.
    const openingBucketId = deliveredReceiptBucket(deps.store.orm, row.id);
    const resumed = resumeInvocation(deps.store, deps.configStore, row.id, deps.isHostReady, now, {
      // The rebuilt Context is empty, so the continuation must render the
      // requests its run was answering even when that batch was wider than
      // `agent.history_messages`.
      historyMessages: historyMessages(deps, row),
      ...(openingBucketId === undefined ? {} : { openingBucketId }),
    });
    if (resumed.ok) {
      carryReceipts(deps.store.orm, row.id, resumed.invocationId, now);
      resumedInvocations.push(resumed.invocationId);
    } else {
      skippedResumes.push({ invocationId: row.id, reason: resumed.reason });
    }
  }
  return { rebuiltContexts, resumedInvocations, skippedResumes, servers };
}

/** How far the continuation's history must reach back for one stopped run. */
function historyMessages(deps: McpCutoverDeps, row: StoppedInvocation): number {
  return consumedBatchHistoryLimit(deps.store.orm, row.id, deps.configStore.current().config.agent.history_messages);
}

/**
 * The run the scheduler queued for a batch the stopped run received but never
 * injected (`releaseUninjectedBuckets`). It is the natural continuation: it
 * already owns those messages as its own new batch.
 */
function releasedInvocation(
  orm: Orm,
  stopped: StoppedInvocation,
): { readonly id: bigint; readonly bucketId: bigint } | undefined {
  const unInjected = orm
    .select({ bucketId: invocationBuckets.bucketId })
    .from(invocationBuckets)
    .where(and(eq(invocationBuckets.invocationId, stopped.id), isNull(invocationBuckets.injectedAt)))
    .all()
    .map((row) => row.bucketId);
  if (unInjected.length === 0) {
    return undefined;
  }
  return orm
    .select({ id: invocations.id, bucketId: invocations.bucketId })
    .from(invocations)
    .where(
      and(
        eq(invocations.conversationId, stopped.conversationId),
        eq(invocations.state, 'queued'),
        inArray(invocations.bucketId, unInjected),
      ),
    )
    .orderBy(invocations.id)
    .get();
}

/**
 * Turns the released run into a continuation: it keeps its own batch as new
 * messages, gains the history the stopped run was answering (the Context was
 * just rebuilt, so nothing else shows it) and points at the run it continues,
 * which is what makes the builder explain the cutover.
 */
function adoptReleasedRun(
  deps: McpCutoverDeps,
  stopped: StoppedInvocation,
  released: { readonly id: bigint; readonly bucketId: bigint },
  history: number,
  now: Date,
): bigint {
  const store = deps.store;
  store.transaction(() => {
    store.orm
      .update(invocations)
      .set({ resumedFromInvocationId: stopped.id })
      .where(eq(invocations.id, released.id))
      .run();
    // `append` keeps the released batch's own rows and adds history after them.
    snapshotInvocation(store, history, released.id, released.bucketId, stopped.conversationId, true, {
      append: true,
    });
    carryReceipts(store.orm, stopped.id, released.id, now);
  });
  return released.id;
}

/** The bucket of the newest task receipt the stopped run was rendering. */
function deliveredReceiptBucket(orm: Orm, stoppedId: bigint): bigint | undefined {
  return (
    orm
      .select({ bucketId: taskReceipts.bucketId })
      .from(taskReceipts)
      .where(and(eq(taskReceipts.invocationId, stoppedId), inArray(taskReceipts.state, ['claimed', 'handled'])))
      .orderBy(taskReceipts.taskId)
      .all()
      .map((row) => row.bucketId)
      .filter((bucketId): bucketId is bigint => bucketId !== null)
      .at(-1) ?? undefined
  );
}

/**
 * Hands the stopped run's task receipts to its continuation. The row keeps its
 * bucket (a receipt is unique per bucket) and delivery policy; claiming it again
 * makes the continuation's own terminal transition finalize it, and the builder
 * renders the completion again when that bucket is the opening batch.
 */
function carryReceipts(orm: Orm, stoppedId: bigint, followUpId: bigint, now: Date): void {
  const timestamp = now.toISOString();
  orm
    .update(taskReceipts)
    .set({
      invocationId: followUpId,
      state: 'claimed',
      claimedAt: timestamp,
      handledAt: null,
      invocationOutcome: null,
      completionReason: null,
      updatedAt: timestamp,
    })
    .where(and(eq(taskReceipts.invocationId, stoppedId), inArray(taskReceipts.state, ['claimed', 'handled'])))
    .run();
}

/**
 * The exposed tool names whose calls ended with an unknown outcome. `tool_calls`
 * is the runtime's own audit and the filter keeps the line to tools the run
 * actually had; nothing about arguments or results is recorded or rendered.
 */
function recordUnknownTools(orm: Orm, stopped: readonly StoppedInvocation[]): void {
  for (const row of stopped) {
    if (row.toolNames.size === 0) {
      continue;
    }
    const unknown = orm
      .select({ name: toolCalls.toolName })
      .from(toolCalls)
      .where(and(eq(toolCalls.invocationId, row.id), eq(toolCalls.state, 'outcome_unknown')))
      .all()
      .map((entry) => entry.name)
      .filter((name) => row.toolNames.has(name));
    if (unknown.length === 0) {
      continue;
    }
    orm
      .update(invocations)
      .set({ abortUnknownTools: encodeAbortUnknownTools([...new Set(unknown)]) })
      .where(eq(invocations.id, row.id))
      .run();
  }
}
