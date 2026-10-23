import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq } from 'drizzle-orm';
import { capability } from '../capabilities/execute-tool.ts';
import { createTyping } from '../capabilities/typing-tool.ts';
import { ContextBuilder } from '../context/context-builder.ts';
import type { InvocationContext, VisibleSender } from '../platform/invocation-context.ts';
import { applyToolSchemaKeywords } from '../platform/tool-schema.ts';
import { buckets } from '../store/schema.ts';
import {
  buildTools,
  estimateToolRegistryCharacters,
  hostFor,
  recordToolRegistry,
  validateToolRegistry,
} from './agent-runtime-support.ts';
import type { AgentRun, RunScope } from './agent-runtime-types.ts';
import { createCachedAgent, estimateInputTokens, lastStickerCatalog } from './agent-runtime-transcript.ts';
import type { CachedConversationAgent } from './conversation-runtime.ts';
import { attachBucketToInvocation } from './invocation-queue.ts';

/**
 * Opens the run: binds the tool set, resolves the cached agent for this
 * Conversation and re-binds it to this run's model, thinking level and tools.
 * The canonical history is the only source of the transcript, so a cache miss
 * rebuilds it identically.
 */
export function createAgentRun(scope: RunScope, zzzExposed: boolean): AgentRun {
  const services = scope.services;
  const {
    config,
    identity,
    invocationId,
    deadline,
    signal,
    header,
    stable,
    settings,
    model,
    capabilities,
    toolSchemaKeywords,
    zzz,
    contextState,
    state,
  } = scope;
  /**
   * Send barrier. Messages that arrive while the model works on its reply would
   * otherwise wait for the next round and get a reply of their own. Before the
   * first send of a round goes out, a batch collecting for this conversation is
   * attached to this run instead, and the send is held back; the batch reaches
   * the model at the next turn boundary through the ordinary injection path.
   * The batch skips the proactive reply gate on purpose: this Invocation
   * already won its chance (a hit or a direct trigger), and the batch is part
   * of the reply in progress, so it neither samples nor moves the pity counter.
   */
  const holdForNewMessages = (): boolean => {
    const conversationRuntime = services.conversationRuntime;
    const conversationId = identity.conversationId;
    // A closing run never injects again. A receipt also finishes its own round
    // before user batches, so neither may hold a send for pending messages.
    if (state.contextClosing || conversationRuntime.isClosing(conversationId) || contextState.completion !== null) {
      return false;
    }
    // A batch the barrier already queued holds back every later send of the
    // same turn too, so no reply goes out before the model has read it.
    if (conversationRuntime.hasPendingInjections(conversationId, 'messages')) {
      return true;
    }
    if (state.barrierSpent) {
      return false;
    }
    const now = new Date();
    const bucketId = services.store.transaction(() => {
      const collecting = services.store.orm
        .select({ id: buckets.id })
        .from(buckets)
        .where(and(eq(buckets.conversationId, conversationId), eq(buckets.state, 'collecting')))
        .get();
      if (collecting === undefined) {
        return undefined;
      }
      attachBucketToInvocation(
        services.store,
        config.agent.history_messages,
        invocationId,
        collecting.id,
        conversationId,
        now,
      );
      return collecting.id;
    });
    if (bucketId === undefined) {
      return false;
    }
    state.barrierSpent = true;
    conversationRuntime.queueInjection(conversationId, bucketId);
    console.log(
      JSON.stringify({
        event: 'send_barrier',
        invocation_id: invocationId.toString(),
        bucket_id: bucketId.toString(),
        conversation_id: conversationId.toString(),
        chat_id: identity.chatId.toString(),
        at: now.toISOString(),
      }),
    );
    return true;
  };
  const typingConversation = services.conversation({
    chatId: identity.chatId,
    threadId: identity.threadId,
    conversationId: identity.conversationId,
  });
  const typing = createTyping(
    hostFor(services, identity.hostKind).activity,
    { conversation: typingConversation, policy: hostFor(services, identity.hostKind).policy(typingConversation) },
    signal,
  );
  const executableCapabilities = [
    capability(typing.tool, false),
    ...(services.capabilityTools?.(contextState, deadline, capabilities) ?? []),
  ];
  const buildToolsFor = (target: InvocationContext, exposeZzz: boolean): readonly AgentTool[] =>
    buildTools(
      services,
      target,
      config,
      deadline,
      capabilities,
      executableCapabilities,
      exposeZzz ? zzz : undefined,
      config.agent.send_barrier_enabled === true ? holdForNewMessages : undefined,
      () => {
        state.duplicateSendRejections += 1;
      },
    );
  const tools = applyToolSchemaKeywords(buildToolsFor(contextState, zzzExposed), toolSchemaKeywords);
  validateToolRegistry(tools, model.contextWindow);
  const toolDefinitionCharacters = estimateToolRegistryCharacters(tools);
  recordToolRegistry(services, invocationId, tools);

  const conversationId = identity.conversationId;
  const runtime = services.conversationRuntime;
  let entry = runtime.cachedAgent(conversationId);
  if (entry !== undefined && (entry.header.id !== header.id || entry.systemPromptHash !== stable.systemPromptHash)) {
    runtime.forget(conversationId);
    entry = undefined;
  }
  if (entry === undefined) {
    entry = createCachedAgent(services, settings, identity, header, stable, model, tools);
    runtime.remember(entry);
  } else {
    // One Context, one header object. A cached entry carries the header of the
    // run that built it, and every writer here works through `entry.header`
    // (`#persistMessage`, `#maybeCollect`), while the injection path and the
    // capability resolver close over the handle from `open()`. Left as two
    // objects, the second handle never advanced: every batch after the first in
    // a cache-reusing run recorded the run's opening `next_seq` as the
    // `source_seq` of its media and reply references, so a later GC revoked
    // them one collection too early, and the resolver kept checking a
    // `head_seq` that a mid-run GC had already moved.
    entry.header = header;
  }
  const cached: CachedConversationAgent = entry;
  const carried: { stickerCatalog: string | null } = { stickerCatalog: null };
  /**
   * Per-injector dedupe signatures the retained transcript still carries.
   * Rebuilt with the visible-sender state: a GC that drops a batch also drops
   * its signatures, which is what allows re-injection.
   */
  const carriedInjections = new Map<string, Set<string>>(
    services.contextInjectors.map((injector) => [injector.name, new Set<string>()]),
  );
  /**
   * The visible sender set follows the retained transcript: senders from
   * batches that were collected away must not stay alarm targets.
   */
  const rebuildVisibleState = (retained: readonly AgentMessage[]): void => {
    const senders = new Map<string, VisibleSender>();
    let callerUserId: bigint | null = null;
    for (const set of carriedInjections.values()) {
      set.clear();
    }
    for (const message of retained) {
      if (message.role !== 'user') {
        continue;
      }
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n');
      const collected = ContextBuilder.collectVisibleSenders(text);
      if (collected.length > 0) {
        callerUserId = collected.at(-1)?.userId ?? callerUserId;
      }
      for (const sender of collected) {
        senders.set(sender.userId.toString(), sender);
      }
      for (const injector of services.contextInjectors) {
        for (const signature of injector.collect(text)) {
          carriedInjections.get(injector.name)?.add(signature);
        }
      }
    }
    contextState.retainVisibleSenders([...senders.values()]);
    // Retained history is not a fresh authorization for a receipt-only round.
    if (contextState.callerUserId !== null) {
      contextState.setCallerUserId(callerUserId);
    }
    // A GC can evict the batch that carried the catalog; the next batch must then
    // render it again.
    carried.stickerCatalog = lastStickerCatalog(retained);
  };
  rebuildVisibleState(cached.agent.state.messages);
  const agent = cached.agent;
  // Hooks close over this run's state, so a cached agent is re-bound on every
  // invocation instead of being rebuilt from the canonical history. The prompt
  // is not re-bound: pi 1.x replays it from the transcript's leading system
  // message, and a changed prompt hash evicted the cache entry above.
  agent.state.model = model;
  // The cached agent keeps the thinking level of the run that built it, so a
  // reused entry has to be re-bound here like the prompt and the model.
  agent.state.thinkingLevel = settings.thinking_level;
  agent.state.tools = [...tools];
  agent.maxRetryDelayMs = Math.max(0, deadline - Date.now());
  state.estimatedInputTokens = estimateInputTokens(services, cached, toolDefinitionCharacters);

  return {
    agent,
    cached,
    typing,
    tools,
    toolDefinitionCharacters,
    carriedInjections,
    rebuildVisibleState,
    carried,
    zzzExposed,
  };
}
