import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { eq, sql } from 'drizzle-orm';
import { SEND_TOOL_NAMES } from '../../capabilities/send/index.ts';
import { ContextBuilder, type ContextIdentity, type StablePrompt } from '../../context/builder/index.ts';
import { encodeContextMessage, estimateMessageTokens } from '../../context/codec.ts';
import { type ContextGcPlan, isRenderable, planContextGc } from '../../context/gc.ts';
import type { ContextHeader, RetainedContextMessage } from '../../context/store.ts';
import type { ActiveAgentSettings, RawConfig } from '../../platform/config/index.ts';
import { invocations } from '../../store/schema/index.ts';
import type { CachedConversationAgent } from '../conversation-runtime.ts';
import type { RuntimeServices } from './types.ts';
import { logContextGc, logContextRealigned } from './observability.ts';

/**
 * The retained window to seed from, repaired if it does not start on a turn
 * boundary.
 *
 * GC only ever cuts to a checkpoint, so the window is normally valid. An
 * eviction that lands while a run is still writing is not: `/cut_topic` moves
 * `head_seq` to the end of the history, and a tool result the aborting run
 * still had in flight then lands above the new head with its assistant tool
 * call already dropped. `pi-ai` repairs a missing tool result but forwards an
 * orphaned one verbatim, so the provider rejects every request and the whole
 * Conversation fails until someone cuts the topic again. Cutting forward to the
 * first turn boundary costs at most the tail of one interrupted turn.
 */
export function alignedRetained(
  services: RuntimeServices,
  identity: ContextIdentity,
  header: ContextHeader,
): RetainedContextMessage[] {
  const retained = services.contexts.retained(header);
  if (retained.length === 0 || isRenderable(retained.map((row) => row.message))) {
    return retained;
  }
  const boundary = retained.find((row) => row.message.role === 'user');
  if (boundary !== undefined && boundary.seq > header.headSeq) {
    services.contexts.advanceHead(header, boundary.seq);
    const realigned = services.contexts.retained(header);
    if (isRenderable(realigned.map((row) => row.message))) {
      logContextRealigned(identity, header, boundary.seq);
      return realigned;
    }
  }
  // No usable boundary at all: the window cannot be made renderable, so it goes
  // rather than poisoning every later invocation.
  services.contexts.clear(header);
  logContextRealigned(identity, header, null);
  return [];
}

/**
 * Seeds a Pi agent from the canonical history. Everything the agent knows at
 * this point comes from `context_messages`; the transcript cache is rebuilt
 * identically after an eviction or a process restart.
 */
export function createCachedAgent(
  services: RuntimeServices,
  settings: ActiveAgentSettings,
  identity: ContextIdentity,
  header: ContextHeader,
  stable: StablePrompt,
  model: Model<Api>,
  tools: readonly AgentTool[],
): CachedConversationAgent {
  const retained = alignedRetained(services, identity, header);
  const agent = new Agent({
    initialState: {
      systemPrompt: stable.systemPrompt,
      model,
      thinkingLevel: settings.thinking_level,
      tools: [...tools],
      messages: retained.map((row) => row.message),
    },
    streamFn: () => {
      throw new Error('Agent stream function is bound per invocation');
    },
  });
  agent.toolExecution = 'sequential';
  return {
    conversationId: identity.conversationId,
    agent,
    header,
    // pi 1.x seeds the prompt as a leading system message in front of the
    // retained history; it is runtime-owned and never persisted, so it gets
    // the `null` sequence entry here.
    transcriptSeqs: [null, ...retained.map((row) => row.seq)],
    pendingMemoState: null,
    systemPromptHash: stable.systemPromptHash,
    lastUsedAt: Date.now(),
  };
}

export function persistMessage(
  services: RuntimeServices,
  entry: CachedConversationAgent,
  invocationId: bigint,
  message: AgentMessage,
  isCheckpoint: boolean,
): bigint | undefined {
  const encoded = encodeContextMessage(message);
  if (encoded === undefined) {
    entry.transcriptSeqs.push(null);
    return undefined;
  }
  const seq = services.contexts.append(entry.header, {
    invocationId,
    isCheckpoint,
    estTokens: estimateMessageTokens(message),
    json: encoded.json,
    role: encoded.role,
    countedSend:
      encoded.role === 'toolResult' &&
      message.role === 'toolResult' &&
      SEND_TOOL_NAMES.has(message.toolName) &&
      message.isError !== true &&
      !(
        message.details !== null &&
        typeof message.details === 'object' &&
        'replayed' in message.details &&
        message.details.replayed === true
      ),
  });
  entry.transcriptSeqs.push(seq);
  if (entry.transcriptSeqs.length !== entry.agent.state.messages.length) {
    throw new Error('Conversation transcript diverged from the canonical history');
  }
  if (isCheckpoint && entry.pendingMemoState !== null) {
    services.contexts.setMemoState(entry.header, entry.pendingMemoState);
    entry.pendingMemoState = null;
  }
  return seq;
}

export function openingBucketId(services: RuntimeServices, invocationId: bigint): bigint {
  const row = services.store.orm
    .select({ bucketId: invocations.bucketId })
    .from(invocations)
    .where(eq(invocations.id, invocationId))
    .get();
  if (row === undefined) {
    throw new Error(`Invocation ${invocationId} does not exist`);
  }
  return row.bucketId;
}

export function markBucketInjected(services: RuntimeServices, invocationId: bigint, bucketId: bigint): void {
  services.store.orm.run(
    sql`UPDATE invocation_buckets SET injected_at = ${new Date().toISOString()}
        WHERE invocation_id = ${invocationId} AND bucket_id = ${bucketId} AND injected_at IS NULL`,
  );
}

/**
 * Discard-only collection at a turn boundary. Four things must move together
 * or the transcript forks: the canonical `head_seq`, the loop context, the
 * cached `Agent.state.messages`, and the references carried by evicted rows.
 */
export function maybeCollect(
  services: RuntimeServices,
  config: RawConfig,
  entry: CachedConversationAgent,
  // The model this run actually talks to. The constructor-time default is wrong
  // after a runtime `/model` switch: GC then judged token pressure against one
  // window while the closing threshold used another, so a switch to a smaller
  // model overran its window and a switch to a larger one collected live history.
  model: Model<Api>,
  loopMessages: readonly AgentMessage[],
  invocationId: bigint,
  estimatedInputTokens: number,
  onRetained: (retained: readonly AgentMessage[]) => void,
): ContextGcPlan | undefined {
  const header = entry.header;
  const plan = planContextGc({
    retainedSendsTarget: config.agent.context.retained_sends_target,
    retainedSendsMax: config.agent.context.retained_sends_max,
    hardTokenRatio: config.agent.context.hard_token_ratio,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    estimatedInputTokens,
    headSeq: header.headSeq,
    transcriptSeqs: entry.transcriptSeqs,
    window: services.contexts.window(header),
    messages: loopMessages,
  });
  if (plan === undefined) {
    return undefined;
  }
  // Captured before the move: `advanceHead` sets `headSeq` to `targetSeq`, so
  // reading it afterwards only reported the target twice and lost the one number
  // that says how much this collection dropped.
  const previousHeadSeq = header.headSeq;
  services.contexts.advanceHead(header, plan.targetSeq);
  // The leading system message is runtime-owned (pi 1.x replays the prompt from
  // it) and sits in front of the collected window, so a cut that starts past
  // index 0 must re-attach it to the retained segment.
  const head = loopMessages[0];
  const leadingSystem = head !== undefined && head.role === 'system' ? [head] : [];
  const retained = [...leadingSystem, ...loopMessages.slice(plan.retainedIndex)];
  entry.transcriptSeqs = [
    ...(leadingSystem.length > 0 ? [null] : []),
    ...entry.transcriptSeqs.slice(plan.retainedIndex),
  ];
  entry.agent.state.messages = [...retained];
  onRetained(retained);
  logContextGc(invocationId, header, previousHeadSeq, plan);
  return plan;
}

export function estimateInputTokens(
  services: RuntimeServices,
  entry: CachedConversationAgent,
  toolDefinitionCharacters: number,
): number {
  const window = services.contexts.window(entry.header);
  const retained = window.reduce((total, row) => total + Number(row.estTokens), 0);
  return retained + Math.ceil(toolDefinitionCharacters / 4);
}

export function estimateTranscriptCharacters(entry: CachedConversationAgent): number {
  return estimateMessagesTokens(entry.agent.state.messages) * 4;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** The newest sticker catalog a retained transcript batch carries, or `null`. */
export function lastStickerCatalog(messages: readonly AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
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
    const catalog = ContextBuilder.collectStickerCatalog(text);
    if (catalog !== null) {
      return catalog;
    }
  }
  return null;
}

/**
 * Telegram message IDs the retained transcript already carries, so the next
 * injection renders only the history rows that never reached the model.
 */
export function collectTranscriptMessageIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
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
    for (const id of ContextBuilder.collectInjectedMessageIds(text)) {
      ids.add(id);
    }
  }
  return ids;
}
