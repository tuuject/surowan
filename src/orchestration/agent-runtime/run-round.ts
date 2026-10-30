import type { AgentContext, AgentMessage } from '@earendil-works/pi-agent-core';
import { isLowDailyTokenBudget } from '../../store/sleep.ts';
import {
  deferCollectingBucket,
  estimateToolDefinitionCharacters,
  hostFor,
  recordToolRegistry,
  validateToolRegistry,
} from './support.ts';
import type { AgentRun, RoundControl, RunScope, StopReason } from './types.ts';
import { logContextInjected, logZzzExposure } from './observability.ts';
import { collectTranscriptMessageIds, estimateMessagesTokens, estimateTranscriptCharacters } from './transcript.ts';

/**
 * Round control: injecting user batches, freeing the agent at a round end, and
 * the `zzz` exposure refresh that every turn boundary shares.
 */
export function createRoundControl(scope: RunScope, run: AgentRun): RoundControl {
  const services = scope.services;
  const {
    config,
    identity,
    invocationId,
    signal,
    header,
    supportsImages,
    model,
    contextState,
    state,
    profile,
    dailyBudget,
    bypassDailyBudget,
    zzz,
    repeatedFailure,
  } = scope;
  const runtime = services.conversationRuntime;
  const conversationId = identity.conversationId;
  const { agent, tools, typing, toolDefinitionCharacters, carriedInjections, cached, carried: carriedSticker } = run;
  // One entry per user message handed to the agent, in delivery order. A batch
  // carries its bucket so it is acknowledged only once it is in the transcript.
  const { pendingUserTags } = run;
  const injectBatch = async (bucketId: bigint): Promise<AgentMessage> => {
    // Later queued batches see earlier announcements without changing the
    // durable header before their checkpoints actually reach the transcript.
    const pendingMemo = pendingUserTags.findLast((entry) => entry.memoState !== undefined)?.memoState;
    const injectionHeader =
      pendingMemo === undefined
        ? header
        : {
            ...header,
            memoStateJson: pendingMemo.stateJson,
            memoRefreshSeq: pendingMemo.refreshSeq,
            memoRefreshPending: pendingMemo.pending,
          };
    const refresh =
      injectionHeader.memoRefreshPending ||
      injectionHeader.memoRefreshSeq === null ||
      injectionHeader.memoRefreshSeq < injectionHeader.headSeq;
    const injection = services.contextBuilder.renderInjection(config, {
      header: injectionHeader,
      identity,
      bucketId,
      seq: header.nextSeq,
      injectedMessageIds: collectTranscriptMessageIds(agent.state.messages),
      sleepy: profile.sleep && isLowDailyTokenBudget(dailyBudget()),
      supportsImages,
      contextWindow: model.contextWindow,
      toolDefinitionCharacters,
      maxOutputTokens: model.maxTokens,
      transcriptCharacters: estimateTranscriptCharacters(cached),
      agentModel: { provider: model.provider, model: model.id },
      carriedStickerCatalog: carriedSticker.stickerCatalog,
      carriedInjections,
    });
    contextState.applyInjection(injection);
    if (injection.stickerCatalog.length > 0) {
      carriedSticker.stickerCatalog = injection.stickerCatalog;
    }
    for (const contribution of injection.injections) {
      if (contribution.signatures.length === 0) {
        continue;
      }
      // Accumulating is correct: older batches still in the retained window keep
      // their signatures until a GC rebuilds these sets from the transcript.
      const carried = carriedInjections.get(contribution.name);
      if (carried !== undefined) {
        for (const signature of contribution.signatures) {
          carried.add(signature);
        }
      }
    }
    runtime.beginRound(conversationId);
    const images = supportsImages ? ((await services.directImageLoader?.(contextState, signal)) ?? []) : [];
    pendingUserTags.push({
      tag: 'checkpoint',
      bucketId,
      ...(injection.memoState === null ? {} : { memoState: { ...injection.memoState, refresh } }),
    });
    state.turnsSinceInjection = 0;
    state.sendUsed = false;
    state.nudged = false;
    repeatedFailure.reset();
    state.estimatedInputTokens = Math.max(
      state.estimatedInputTokens,
      estimateMessagesTokens(agent.state.messages) + Math.ceil((injection.text.length + toolDefinitionCharacters) / 4),
    );
    logContextInjected(invocationId, identity, bucketId, injection, header.nextSeq);
    return {
      role: 'user',
      content: [{ type: 'text', text: injection.text }, ...images],
      timestamp: Date.now(),
    };
  };
  const injectPending = async (includeCompletion: boolean, turnContext: AgentContext): Promise<boolean> => {
    if (contextState.completion !== null) {
      return false;
    }
    const pending = runtime.takeNextInjections(conversationId, includeCompletion);
    if (pending.length === 0) {
      return false;
    }
    for (const bucketId of pending) {
      // `steer` only queues the message. The bucket is marked injected when the
      // message is persisted (`message_end`), so a run that ends first leaves it
      // un-injected and `releaseUninjectedBuckets` re-queues the batch.
      agent.steer(await injectBatch(bucketId));
    }
    // pi 1.x announces tool-set changes itself by diffing the executable set
    // against the transcript's declarations, so an injection queued after the
    // prepare boundary (including an idle wake) only has to refresh the
    // executable snapshot before the next request.
    refreshZzz(turnContext);
    return true;
  };
  /**
   * The instant the agent is free again — a turn that called no tools, or a run
   * that is ending — is where the next batch's collection window starts, so a
   * batch whose messages arrived during this round collects a full window of
   * free-agent time instead of being handed over the moment the round ends.
   */
  const freeAgent = (): void => {
    typing.stop();
    hostFor(services, identity.hostKind).activity.stop(services.conversation(identity));
    runtime.endRound(conversationId);
    state.barrierSpent = false;
    deferCollectingBucket(services, config, identity.hostKind, conversationId, Date.now());
  };
  const stop = (reason: StopReason): { action: 'end' } => {
    // A run that ends frees the agent just like the end of a round does.
    freeAgent();
    state.stopReason = reason;
    state.contextClosing = true;
    runtime.beginClosing(conversationId);
    return { action: 'end' };
  };

  const refreshZzz = (turnContext: AgentContext): boolean => {
    const budget = dailyBudget();
    const shouldExposeZzz = !bypassDailyBudget() && isLowDailyTokenBudget(budget);
    if (shouldExposeZzz === run.zzzExposed) {
      return false;
    }
    run.zzzExposed = shouldExposeZzz;
    const nextTools = (turnContext.tools ?? tools).filter((tool) => tool.name !== 'zzz');
    if (shouldExposeZzz && zzz !== undefined) {
      nextTools.push(zzz);
      logZzzExposure(invocationId, identity.chatId, budget);
      state.estimatedInputTokens += Math.ceil(estimateToolDefinitionCharacters(zzz) / 4);
    }
    validateToolRegistry(nextTools, model.contextWindow);
    recordToolRegistry(services, invocationId, nextTools);
    turnContext.tools = nextTools;
    agent.state.tools = nextTools;
    return true;
  };

  return { pendingUserTags, injectBatch, injectPending, freeAgent, stop, refreshZzz };
}
