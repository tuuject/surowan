import { completeAgentSettings } from '../platform/config-resolve.ts';
import { configuredToolSchemaKeywords } from '../platform/config.ts';
import { hostExecutionProfile } from '../platform/host-profile.ts';
import { InvocationContextState } from '../platform/invocation-context.ts';
import { createZzzTool, type DailyTokenBudget, isLowDailyTokenBudget, readDailyTokenBudget } from '../store/sleep.ts';
import type { InvocationConfigSnapshot } from '../platform/runtime-config.ts';
import { capabilitiesFor } from './agent-runtime-support.ts';
import type { RunScope, RunState, RuntimeServices } from './agent-runtime-types.ts';
import { logContextRebuilt, logZzzExposure } from './agent-runtime-observability.ts';
import { createAgentRun } from './agent-runtime-run-agent.ts';
import { executeRun } from './agent-runtime-run-finish.ts';
import { bindRequestHooks, subscribeRunEvents } from './agent-runtime-run-hooks.ts';
import { createRoundControl } from './agent-runtime-run-round.ts';
import { bindTurnHooks } from './agent-runtime-run-turns.ts';
import { RepeatedToolFailure } from './repeated-tool-failure.ts';
import type { InvocationOutcome } from './scheduler.ts';
import type { SystemSkill } from '../platform/system-resources.ts';

/**
 * One invocation from snapshot to outcome. The phases run in this order and
 * share one `RunScope`: open the run and bind the agent, build the round
 * control, bind the request and turn hooks, subscribe the transcript writers,
 * then drive the loop. Each phase receives the same live objects by reference.
 */
export async function runInvocation(
  services: RuntimeServices,
  invocationId: bigint,
  snapshot: InvocationConfigSnapshot,
  schedulerSignal: AbortSignal,
): Promise<InvocationOutcome> {
  // Every runtime-policy read below comes from the snapshot this run was
  // started with; the global daily budget and debug recording switch are re-read live. The snapshot
  // carries its own model registry, so a configuration published while this
  // run is in flight never reaches it — neither its models nor its provider
  // connections — and a model that is no longer registered fails the run
  // instead of silently falling back.
  const config = snapshot.config;
  const identity = services.contextBuilder.identity(config, invocationId);
  // The host resolved this policy once, when the run started. Reading it back
  // here keeps a Telegram chat entry and a room on the same code path. The
  // queue gates on the same check, but a reload may have dropped the identity
  // triple between queuing and launch; abort instead of erroring.
  const settings = completeAgentSettings(identity.policy.agent);
  if (settings === undefined) {
    return { state: 'aborted', reason: 'agent_unconfigured' };
  }
  const model = snapshot.models.getModel(settings.provider, settings.model);
  if (model === undefined) {
    throw new Error(`Agent model ${settings.provider}/${settings.model} is not registered`);
  }
  // The declared keyword profile of the agent model decides what its tool
  // definitions may carry; the snapshot is read so a reload cannot change the
  // schema mid-run.
  const toolSchemaKeywords = configuredToolSchemaKeywords(config, settings.provider, settings.model);
  const supportsImages = model.input.includes('image');
  const stable = services.contextBuilder.buildSystemPrompt(
    config,
    identity,
    supportsImages,
    {
      provider: model.provider,
      model: model.id,
    },
    services.skillVisibility === undefined
      ? undefined
      : {
          skillFilter: (skill: SystemSkill) =>
            services.skillVisibility?.(skill, {
              hostKind: identity.hostKind,
              conversationId: identity.conversationId,
            }) ?? true,
        },
  );
  const opened = services.contexts.open(identity.conversationId, stable.systemPromptHash);
  const header = opened.header;
  if (opened.rebuilt) {
    // A changed stable system prompt restarts the Conversation Context: the
    // same conversation under two different prompts is not replayable.
    services.conversationRuntime.forget(identity.conversationId);
    logContextRebuilt(identity, stable.systemPromptHash);
  }
  const startedAt = Date.now();
  const deadline = startedAt + config.agent.context.max_wall_clock_seconds * 1_000;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const signal = AbortSignal.any([schedulerSignal, timeoutSignal]);
  const contextState = new InvocationContextState({
    invocationId,
    conversationId: identity.conversationId,
    hostKind: identity.hostKind,
    chatId: identity.chatId,
    threadId: identity.threadId,
    completion: identity.completion,
  });
  // The host profile decides what this identity may reach. Nothing below
  // falls back to the Telegram defaults when the host is the Playground.
  const profile = hostExecutionProfile(identity.hostKind);
  const bypassDailyBudget = (): boolean =>
    profile.budgetBypass && contextState.completion?.delivery.bypassDailyBudget === true;
  const dailyBudget = (): DailyTokenBudget =>
    readDailyTokenBudget(services.store.orm, services.configStore.current().config.agent.daily_budget.max_tokens, {
      scope: profile.budgetScope,
    });
  contextState.setSystemPrompt(stable.systemPrompt);
  const capabilities = capabilitiesFor(services, header);
  const state: RunState = {
    turns: 0,
    turnsSinceInjection: 0,
    toolCalls: 0,
    estimatedInputTokens: 0,
    sendUsed: false,
    nudged: false,
    sleepRequested: false,
    modelBudgetBlocked: false,
    contextClosing: false,
    barrierSpent: false,
    duplicateSendRejections: 0,
    stopReason: 'completed',
  };
  const repeatedFailure = new RepeatedToolFailure();
  const zzz = profile.sleep
    ? createZzzTool({
        orm: services.store.orm,
        invocationId,
        chatId: identity.chatId,
        onSleep: () => {
          state.sleepRequested = true;
        },
      })
    : undefined;
  const initialBudget = dailyBudget();
  const zzzExposed = zzz !== undefined && !bypassDailyBudget() && isLowDailyTokenBudget(initialBudget);
  if (zzzExposed) {
    logZzzExposure(invocationId, identity.chatId, initialBudget);
  }

  const scope: RunScope = {
    services,
    invocationId,
    snapshot,
    config,
    identity,
    settings,
    model,
    toolSchemaKeywords,
    supportsImages,
    stable,
    header,
    deadline,
    timeoutSignal,
    signal,
    contextState,
    profile,
    bypassDailyBudget,
    dailyBudget,
    capabilities,
    state,
    repeatedFailure,
    zzz,
  };
  const run = createAgentRun(scope, zzzExposed);
  const round = createRoundControl(scope, run);
  bindRequestHooks(scope, run);
  bindTurnHooks(scope, run, round);
  const unsubscribe = subscribeRunEvents(scope, run, round);
  return executeRun(scope, run, round, unsubscribe);
}
