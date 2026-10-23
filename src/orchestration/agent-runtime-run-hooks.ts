import { getCurrentTools, type ThinkingContent } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { SEND_TOOL_NAMES } from '../capabilities/send-tool.ts';
import { activeSleepUntil, isDailyTokenBudgetReached, isLowDailyTokenBudget } from '../store/sleep.ts';
import { invocations } from '../store/schema.ts';
import { errorStream, recordAgentMessage } from './agent-runtime-support.ts';
import type { AgentRun, RoundControl, RunScope } from './agent-runtime-types.ts';
import {
  failModelCall,
  finishModelCall,
  recordModelCallRequest,
  recordModelCallResponse,
  startModelCall,
} from './agent-runtime-observability.ts';
import { markBucketInjected, persistMessage } from './agent-runtime-transcript.ts';

/** Binds the model-call and tool-call hooks; both close over this run's state. */
export function bindRequestHooks(scope: RunScope, run: AgentRun): void {
  const services = scope.services;
  const { identity, invocationId, deadline, signal, snapshot, state, profile, dailyBudget, bypassDailyBudget } = scope;
  const { agent } = run;
  agent.streamFunction = async (streamModel, modelContext, options) => {
    if (!bypassDailyBudget() && isDailyTokenBudgetReached(dailyBudget())) {
      state.modelBudgetBlocked = true;
      return errorStream(streamModel, 'daily_token_budget');
    }
    const release = await services.modelGate.acquire(identity.policy.gateKey, signal);
    // Per-request visibility audit: the exact tool names this llmContext
    // carried (the loop can trim tools to send-only near the context limit).
    // pi 1.x carries the declarations in the transcript's system messages.
    const callId = startModelCall(
      services,
      invocationId,
      streamModel,
      getCurrentTools(modelContext.messages).map((tool) => tool.name),
    );
    const recordPayloads = services.configStore.current().config.developer.record_model_payloads;
    try {
      const stream = snapshot.models.streamSimple(streamModel, modelContext, {
        ...options,
        signal,
        maxTokens: streamModel.maxTokens,
        maxRetries: 2,
        maxRetryDelayMs: Math.max(0, deadline - Date.now()),
        // Snapshot audit: capture the provider request payload without
        // retaining inline image bytes, plus the HTTP response status, so
        // rendered context and transport outcome stay inspectable.
        onPayload: (payload) => {
          if (recordPayloads && services.configStore.current().config.developer.record_model_payloads) {
            recordModelCallRequest(services, callId, payload);
          }
          return undefined;
        },
        onResponse: (response) => {
          if (recordPayloads && services.configStore.current().config.developer.record_model_payloads) {
            recordModelCallResponse(services, callId, response);
          }
        },
      });
      void stream
        .result()
        .then(
          (message) => {
            // Reported input tokens already cover the tool schemas this request
            // carried, so adding the registry estimate on top would double count
            // it — and because this runs per model call, the addend accumulated:
            // the estimate drifted upward by one registry per turn regardless of
            // how much history there actually was. In a long-lived invocation
            // that crossed `hard_token_ratio` on turn count alone, so GC threw
            // away live history and the run then ended as `context_limit`.
            state.estimatedInputTokens = Math.max(state.estimatedInputTokens, message.usage.input);
            finishModelCall(services, callId, identity.chatId, message, profile.budgetScope);
          },
          (error) => failModelCall(services, callId, 'stream_rejected', error),
        )
        .finally(release)
        .catch(() => undefined);
      return stream;
    } catch (error) {
      release();
      failModelCall(services, callId, 'model_setup_error', error);
      return errorStream(streamModel, services.secrets.redactError(error));
    }
  };
  agent.beforeToolCall = async ({ toolCall }) => {
    if (
      toolCall.name !== 'zzz' &&
      profile.sleep &&
      !bypassDailyBudget() &&
      (state.sleepRequested || activeSleepUntil(services.store.orm) !== null)
    ) {
      return { block: true, reason: 'The bot is sleeping', terminate: true };
    }
    if (toolCall.name === 'zzz' && (bypassDailyBudget() || !isLowDailyTokenBudget(dailyBudget()))) {
      return { block: true, reason: 'You are no longer sleepy' };
    }
    // Audit-only counter: there is no per-invocation tool-call cap. Runaway
    // loops stay bounded by the per-injection turn budget, the wall clock,
    // the context stop ratio, and the daily token budget.
    state.toolCalls += 1;
    services.store.orm
      .update(invocations)
      .set({ toolCallsUsed: BigInt(state.toolCalls) })
      .where(eq(invocations.id, invocationId))
      .run();
    return undefined;
  };
}

/** Subscribes the transcript writers; the returned function detaches them. */
export function subscribeRunEvents(scope: RunScope, run: AgentRun, round: RoundControl): () => void {
  const services = scope.services;
  const { invocationId, state } = scope;
  const { agent, cached } = run;
  const { pendingUserTags } = round;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      state.turns += 1;
      state.turnsSinceInjection += 1;
      services.store.orm
        .update(invocations)
        .set({ turnsUsed: BigInt(state.turns) })
        .where(eq(invocations.id, invocationId))
        .run();
    }
    if (event.type === 'tool_execution_end' && SEND_TOOL_NAMES.has(event.toolName)) {
      state.sendUsed = true;
    }
    if (event.type !== 'message_end') {
      return;
    }
    const pendingUser = event.message.role === 'user' ? pendingUserTags.shift() : undefined;
    persistMessage(services, cached, invocationId, event.message, pendingUser?.tag === 'checkpoint');
    if (pendingUser !== undefined && pendingUser.bucketId !== null) {
      markBucketInjected(services, invocationId, pendingUser.bucketId);
    }
    if (event.message.role === 'assistant') {
      const text = event.message.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('');
      // CoT is recorded only when the developer switch is on; read the live
      // value so a hot-applied toggle affects the next assistant message.
      const thinking = services.configStore.current().config.developer.record_agent_thinking
        ? event.message.content
            .filter((entry): entry is ThinkingContent => entry.type === 'thinking' && entry.thinking.trim().length > 0)
            .map((entry) => entry.thinking)
            .join('\n\n')
        : '';
      recordAgentMessage(services, invocationId, 'assistant', text, thinking);
    } else if (event.message.role === 'toolResult') {
      const text = event.message.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('');
      recordAgentMessage(services, invocationId, 'tool_result', text);
    }
  });

  return unsubscribe;
}
