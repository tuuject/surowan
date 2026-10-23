import { and, eq } from 'drizzle-orm';
import { toolCalls as toolCallsTable } from '../store/schema.ts';
import { hostFor } from './agent-runtime-support.ts';
import type { AgentRun, RoundControl, RunScope } from './agent-runtime-types.ts';
import { openingBucketId } from './agent-runtime-transcript.ts';
import type { InvocationOutcome } from './scheduler.ts';

/**
 * Drives the agent loop and always tears the run down: the transcript stays in
 * the cached agent on purpose, memory-side queues and the closing flag are
 * released, and a failed run forgets the entry so the next one rebuilds from
 * the canonical history.
 */
export async function executeRun(
  scope: RunScope,
  run: AgentRun,
  round: RoundControl,
  unsubscribe: () => void,
): Promise<InvocationOutcome> {
  const services = scope.services;
  const { invocationId, identity, header, signal, timeoutSignal, state } = scope;
  const runtime = services.conversationRuntime;
  const conversationId = identity.conversationId;
  const { agent, typing } = run;
  const { injectBatch } = round;
  const abortAgent = (): void => agent.abort();
  signal.addEventListener('abort', abortAgent, { once: true });
  let outcome: InvocationOutcome | undefined;
  try {
    services.contexts.touch(header, invocationId);
    const openingBucket = openingBucketId(services, invocationId);
    await agent.prompt(await injectBatch(openingBucket));
    if (signal.aborted) {
      const unknown =
        services.store.orm
          .select({ id: toolCallsTable.id })
          .from(toolCallsTable)
          .where(and(eq(toolCallsTable.invocationId, invocationId), eq(toolCallsTable.state, 'outcome_unknown')))
          .limit(1)
          .get() !== undefined;
      outcome = {
        state: unknown ? 'outcome_unknown' : 'aborted',
        reason: timeoutSignal.aborted ? 'timeout' : 'aborted',
      };
    } else if (state.modelBudgetBlocked) {
      outcome = { state: 'failed', reason: 'daily_token_budget' };
    } else if (agent.state.errorMessage !== undefined) {
      outcome = { state: 'failed', reason: 'model_error' };
    } else {
      outcome = { state: 'completed', reason: state.stopReason };
    }
  } finally {
    typing.stop();
    hostFor(services, identity.hostKind).activity.stop(services.conversation(identity));
    signal.removeEventListener('abort', abortAgent);
    unsubscribe();
    // The cached agent keeps its transcript on purpose: the next invocation
    // of this Conversation continues where this one stopped.
    agent.clearAllQueues();
    // A batch that was attached but never reached a turn boundary must not stay
    // queued in memory: the next run of this Conversation would take it from the
    // queue and inject it a second time, on top of the opening injection it has
    // by then become. The database side is the scheduler's job — those rows still
    // have `injected_at IS NULL`, so `releaseUninjectedBuckets` re-queues them.
    runtime.takeInjections(conversationId);
    runtime.endClosing(conversationId);
    // Backstop for the paths that never reach `freeAgent` (abort mid-round, a
    // thrown error): the flag must not outlive the run, or the conversation
    // would look busy forever and its batches would never be attached.
    runtime.endRound(conversationId);
    services.contexts.clearActiveInvocation(invocationId);
    services.contexts.touch(header, null);
    // A failed run must not leave a half-broken transcript behind that the
    // next invocation would happily replay. That covers a thrown error too
    // (`outcome` is only set on a normal return): a persistence failure can
    // throw after the agent added a message but before `transcriptSeqs` knew
    // of it, and the next run would trip over the diverged arrays again.
    if (outcome === undefined || agent.state.errorMessage !== undefined) {
      runtime.forget(conversationId);
    }
  }
  if (outcome === undefined) {
    throw new Error('Agent run ended without an outcome');
  }
  return outcome;
}
