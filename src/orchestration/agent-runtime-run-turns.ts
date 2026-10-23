import { SEND_TOOL_NAMES } from '../capabilities/send-tool.ts';
import { activeSleepUntil, isDailyTokenBudgetReached } from '../store/sleep.ts';
import { estimateToolRegistryCharacters, recordAgentMessage } from './agent-runtime-support.ts';
import type { AgentRun, RoundControl, RunScope } from './agent-runtime-types.ts';
import { estimateInputTokens, maybeCollect } from './agent-runtime-transcript.ts';
import { DUPLICATE_SEND_REJECTION_LIMIT } from '../capabilities/send-tool-support.ts';

/**
 * Safety net for models that draft a group-facing reply as ordinary assistant
 * text and then stop without calling send. Ordinary assistant text is private
 * and never published, so such a reply is silently lost. When a turn ends on
 * non-empty private text without calling send since the newest injected batch,
 * inject one harness-level reminder to use send. Fires at most once per injected
 * batch; if the model still does not send, we stop and let it stay silent.
 *
 * The check has to run before the inject and idle-grace paths: both extend the
 * run, and a draft is only recoverable while its batch is still the newest one.
 * Left after them, the reminder only ever fires once the conversation has been
 * quiet for a whole grace period, so every batch that is followed by another
 * bucket within the grace silently loses its reply.
 */
const SEND_NUDGE_TEXT =
  'You produced a reply as ordinary assistant text. Ordinary assistant text is private and is never published to Telegram. If that text is meant for the chat, call the send tool to publish it now. You will not be reminded again.';

/** Binds the two turn-boundary hooks: collection before a turn, decisions after one. */
export function bindTurnHooks(scope: RunScope, run: AgentRun, round: RoundControl): void {
  const services = scope.services;
  const {
    config,
    model,
    invocationId,
    deadline,
    signal,
    state,
    profile,
    contextState,
    dailyBudget,
    bypassDailyBudget,
    repeatedFailure,
  } = scope;
  const runtime = services.conversationRuntime;
  const conversationId = scope.identity.conversationId;
  const { agent, cached, tools, typing, rebuildVisibleState } = run;
  const { pendingUserTags, refreshZzz, injectPending, freeAgent, stop } = round;
  agent.prepareNextTurnWithContext = async (turn) => {
    const registryChanged = refreshZzz(turn.context);
    const nextTools = turn.context.tools;
    // The only safe collection point: after the tool batch closed, before the
    // next model call. Never during streaming.
    const collected = maybeCollect(
      services,
      config,
      cached,
      model,
      turn.context.messages,
      invocationId,
      state.estimatedInputTokens,
      rebuildVisibleState,
    );
    // The retained segment keeps the runtime-owned leading system message that
    // pi 1.x replays the prompt from; the planner's `retainedIndex` is always
    // past it, so the cut would otherwise drop the prompt from the loop context.
    const loopHead = turn.context.messages[0];
    const leadingSystem = loopHead !== undefined && loopHead.role === 'system' ? [loopHead] : [];
    const messages =
      collected === undefined ? undefined : [...leadingSystem, ...turn.context.messages.slice(collected.retainedIndex)];
    if (collected !== undefined) {
      // The estimate is a high-water mark that model usage only ever raises, so
      // after a collection it still describes the history just dropped and
      // would push a run that GC had relieved straight into closing mode.
      state.estimatedInputTokens = estimateInputTokens(
        services,
        cached,
        estimateToolRegistryCharacters(nextTools ?? tools),
      );
    }
    const stopThreshold = Math.floor(model.contextWindow * config.agent.context_stop_ratio);
    if (state.estimatedInputTokens >= stopThreshold) {
      state.contextClosing = true;
      state.stopReason = 'context_limit';
      const closingTools = (nextTools ?? tools).filter((tool) => SEND_TOOL_NAMES.has(tool.name) || tool.name === 'zzz');
      return {
        context: {
          ...turn.context,
          ...(messages === undefined ? {} : { messages }),
          ...(closingTools === undefined ? {} : { tools: closingTools }),
        },
      };
    }
    if (messages === undefined && !registryChanged) {
      return undefined;
    }
    return {
      context: {
        ...turn.context,
        ...(messages === undefined ? {} : { messages }),
        ...(nextTools === undefined ? {} : { tools: nextTools }),
      },
    };
  };
  // pi 1.x replacement for the removed `shouldStopAfterTurn`. It runs before
  // `turn_end` (and before the next `prepareNextTurnWithContext`), so turn-end
  // bookkeeping that this hook reads lags one turn: `turnsSinceInjection` is
  // compensated below, and a closing send-only turn has already streamed by the
  // time `contextClosing` is first seen.
  agent.finishTurn = async (turn) => {
    if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') {
      // Error and aborted responses are hard exits; pi ignores the decision.
      return undefined;
    }
    if (
      profile.sleep &&
      !bypassDailyBudget() &&
      (state.sleepRequested || activeSleepUntil(services.store.orm) !== null)
    ) {
      return stop('sleep');
    }
    if (!bypassDailyBudget() && isDailyTokenBudgetReached(dailyBudget())) {
      return stop('budget');
    }
    if (state.contextClosing) {
      // `prepareNextTurnWithContext` entered closing mode before the send-only
      // turn it schedules; that turn has streamed by the time this hook sees the
      // flag, so the promised answer is out and the run stops now.
      return stop(state.stopReason);
    }
    if (state.duplicateSendRejections > DUPLICATE_SEND_REJECTION_LIMIT) {
      return stop('duplicate_send');
    }
    if (repeatedFailure.observe(turn)) {
      return stop('repeated_tool_failure');
    }
    // `turn_end` now emits after this hook, so the turn that just completed is
    // not counted yet.
    if (state.turnsSinceInjection + 1 >= config.agent.rate_limits.turns_per_injection) {
      return stop('turn_budget');
    }
    // Safety net first, before anything that can extend the run: a newer batch
    // (or the idle grace) would otherwise swallow the current batch's draft.
    // Only when this turn produced no tool calls (a would-be final message), so
    // we never interrupt an in-progress workflow. The round is deliberately not
    // treated as over here: the agent still owes a published answer.
    const hasToolCalls = turn.message.content.some((entry) => entry.type === 'toolCall');
    if (config.agent.send_nudge_enabled === true && !state.sendUsed && !state.nudged) {
      const text = turn.message.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('');
      if (!hasToolCalls && text.trim().length > 0) {
        state.nudged = true;
        pendingUserTags.push({ tag: 'harness', bucketId: null });
        agent.steer({ role: 'user', content: [{ type: 'text', text: SEND_NUDGE_TEXT }], timestamp: Date.now() });
        recordAgentMessage(services, invocationId, 'harness_nudge', SEND_NUDGE_TEXT);
        return undefined;
      }
    }
    if (!hasToolCalls && contextState.completion !== null) {
      // A receipt's exemption ends with its round, not with the Invocation.
      // Pending ordinary messages must never spend that exemption.
      contextState.finishCompletion();
      refreshZzz(turn.context);
      if (
        (profile.sleep && (state.sleepRequested || activeSleepUntil(services.store.orm) !== null)) ||
        isDailyTokenBudgetReached(dailyBudget())
      ) {
        return stop('completed');
      }
    }
    // User batches keep their existing turn-boundary semantics. Completion
    // receipts enter one at a time between rounds, never interrupting tools or
    // merging independent mention/budget policies into one model response.
    if (!hasToolCalls) {
      typing.stop();
    }
    if (await injectPending(!hasToolCalls, turn.context)) {
      return undefined;
    }
    const idleGraceMilliseconds = config.agent.context.idle_grace_seconds * 1_000;
    // The grace belongs to the end of a round, not to every turn. A turn that
    // ended with tool calls, or one with a batch already queued to inject, is
    // followed by another turn regardless, so waiting here would only delay it:
    // a three-step round used to pay the grace after every step, and a batch
    // injected while the model was working paid it before being answered.
    // A batch that becomes due while a tool runs is still picked up at the next
    // turn boundary, and if that boundary falls just before the attach lands the
    // queued injection wakes this wait immediately.
    const roundIsOver = !hasToolCalls && !runtime.hasPendingInjections(conversationId);
    if (roundIsOver) {
      freeAgent();
    }
    if (roundIsOver && idleGraceMilliseconds > 0 && Date.now() < deadline) {
      const waited = await runtime.waitForInjection(
        conversationId,
        Math.min(idleGraceMilliseconds, Math.max(0, deadline - Date.now())),
        signal,
      );
      if (waited === 'pending' && (await injectPending(true, turn.context))) {
        return undefined;
      }
      if (waited === 'aborted') {
        return undefined;
      }
    }
    if (Date.now() >= deadline) {
      return stop('wall_clock');
    }
    if (roundIsOver) {
      // The loop is about to end on its own: no tool calls this turn and nothing
      // queued, which is exactly Pi's own exit condition. `stop()` never runs on
      // this path, so without marking the run closing here the attach path stayed
      // open for the whole teardown and could hand over a batch that no turn
      // boundary would ever inject.
      runtime.beginClosing(conversationId);
    }
    // Nothing to force: the loop ends on its own once the model stops calling
    // tools. Forcing a stop here would cut the answer short.
    return undefined;
  };
}
