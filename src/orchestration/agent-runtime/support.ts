import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { eq, sql } from 'drizzle-orm';
import { capability, createExecuteTool, type ExecutableCapability } from '../../capabilities/execute-tool.ts';
import { createReadTool } from '../../capabilities/read-tool.ts';
import { createSendTools } from '../../capabilities/send/index.ts';
import { createTyping } from '../../capabilities/typing-tool.ts';
import { createCapabilityResolver } from '../../context/refs.ts';
import type { ContextHeader } from '../../context/store.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { ImHost } from '../../platform/im-host/index.ts';
import {
  type CapabilityRefResolver,
  type InvocationContext,
  unavailableCapabilities,
} from '../../platform/invocation-context.ts';
import { scopedSystemResources } from '../../platform/system-resources.ts';
import { agentMessages, invocations } from '../../store/schema/index.ts';
import { createZzzTool, isLowDailyTokenBudget, readDailyTokenBudget } from '../../store/sleep.ts';
import { createToolAudit } from '../../store/tool-audit.ts';
import type { RuntimeServices } from './types.ts';
import { duplicateSendGuard } from '../../capabilities/send/support.ts';

/** The host bound to one kind of conversation, or a clear failure. */
export function hostFor(services: RuntimeServices, kind: HostKind): ImHost {
  const host = services.hosts[kind];
  if (host === undefined) {
    throw new Error(`no "${kind}" host is bound to this process`);
  }
  return host;
}

export function sendRateLimit(config: RawConfig): { sendsPerWindow: number; windowSeconds: number } {
  return {
    sendsPerWindow: config.agent.rate_limits.sends_per_window,
    windowSeconds: config.agent.rate_limits.window_seconds,
  };
}

/**
 * Checks the per-invocation tool registry against a model's context window.
 * The model is passed in because the caller resolves it: `/model` switches and
 * reloads validate against the model the run will actually get, which is not
 * the one this runtime was constructed with.
 */
export function validateAdditionalTools(
  services: RuntimeServices,
  context: InvocationContext,
  additionalTools: readonly AgentTool[],
  model: Model<Api>,
): void {
  const config = services.configStore.current().config;
  const { send, sendReply } = createSendTools({
    store: services.store,
    host: hostFor(services, context.hostKind),
    conversation: services.conversation(context),
    context,
    capabilities: staticCapabilities(),
    sendRateLimit: sendRateLimit(config),
    maxTextLength: config.agent.send_max_text_length,
    disallowBlankLines: config.agent.send_disallow_blank_lines === true,
    allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
    ...duplicateSendGuard(config.agent.send_duplicate_guard_enabled),
    deadline: Number.MAX_SAFE_INTEGER,
    bot: services.bot,
  });
  validateToolRegistry(
    [
      createReadTool({ store: services.store, context, resources: services.systemResources }),
      send,
      sendReply,
      createExecuteTool({ audit: createToolAudit(services.store, context.invocationId), capabilities: [] }),
      ...additionalTools,
    ],
    model.contextWindow,
  );
}

/** Current definitions only; scene tests never receive these production executors. */
export function sceneToolDefinitions(
  services: RuntimeServices,
  context: InvocationContext,
  config: RawConfig,
): {
  readonly tools: readonly AgentTool[];
  readonly capabilities: readonly AgentTool[];
} {
  const resolver = unavailableCapabilities();
  const deadline = Number.MAX_SAFE_INTEGER;
  const capabilities = [
    capability(
      createTyping(
        hostFor(services, context.hostKind).activity,
        {
          conversation: services.conversation(context),
          policy: hostFor(services, context.hostKind).policy(services.conversation(context)),
        },
        new AbortController().signal,
      ).tool,
      false,
    ),
    ...(services.capabilityTools?.(context, deadline, resolver) ?? []),
  ];
  return {
    tools: buildTools(
      services,
      context,
      config,
      deadline,
      resolver,
      capabilities,
      hostExecutionProfile(context.hostKind).sleep &&
        isLowDailyTokenBudget(
          readDailyTokenBudget(services.store.orm, config.agent.daily_budget.max_tokens, {
            scope: hostExecutionProfile(context.hostKind).budgetScope,
          }),
        )
        ? createZzzTool({
            orm: services.store.orm,
            invocationId: context.invocationId,
            chatId: context.chatId,
            onSleep: () => {},
          })
        : undefined,
    ),
    capabilities: capabilities.map((entry) => entry.tool),
  };
}

export function buildTools(
  services: RuntimeServices,
  target: InvocationContext,
  config: RawConfig,
  deadline: number,
  capabilities: CapabilityRefResolver,
  executableCapabilities: readonly ExecutableCapability[],
  zzz?: AgentTool,
  holdForNewMessages?: () => boolean,
  onDuplicateSend?: () => void,
): readonly AgentTool[] {
  const { send, sendReply } = createSendTools({
    store: services.store,
    host: hostFor(services, target.hostKind),
    conversation: services.conversation(target),
    context: target,
    capabilities,
    sendRateLimit: sendRateLimit(config),
    maxTextLength: config.agent.send_max_text_length,
    disallowBlankLines: config.agent.send_disallow_blank_lines === true,
    allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
    ...duplicateSendGuard(config.agent.send_duplicate_guard_enabled, onDuplicateSend),
    deadline,
    bot: services.bot,
    ...(holdForNewMessages === undefined ? {} : { holdForNewMessages }),
    ...(services.imageGeneration === undefined ? {} : { imageGeneration: services.imageGeneration }),
  });
  const skillVisibility = services.skillVisibility;
  const resources =
    skillVisibility === undefined
      ? services.systemResources
      : scopedSystemResources(services.systemResources, (skill) =>
          skillVisibility(skill, { hostKind: target.hostKind, conversationId: target.conversationId }),
        );
  return [
    createReadTool({ store: services.store, context: target, resources }),
    send,
    sendReply,
    createExecuteTool({
      audit: createToolAudit(services.store, target.invocationId),
      capabilities: executableCapabilities,
    }),
    ...(services.additionalTools?.(target, deadline, capabilities) ?? []),
    ...(zzz === undefined ? [] : [zzz]),
  ];
}

export function capabilitiesFor(services: RuntimeServices, header: ContextHeader): CapabilityRefResolver {
  return createCapabilityResolver(services.refs, header);
}

export function staticCapabilities(): CapabilityRefResolver {
  return unavailableCapabilities();
}

/**
 * Anchors the next batch's collection window at the moment the agent becomes
 * free. A batch that collected while the model was working (its messages
 * arrived mid-round) would otherwise be handed over the instant the round ends,
 * having collected far less than `telegram.bucket_window_seconds`.
 *
 * Extension-only: a batch whose own deadline is already later — one whose first
 * message arrived after this round ended — keeps it. The write is what also
 * re-schedules the scheduler, which recomputes its next wake from deadlines.
 */
export function deferCollectingBucket(
  services: RuntimeServices,
  config: RawConfig,
  conversationId: bigint,
  freeSince: number,
): void {
  const atLeast = new Date(freeSince + config.telegram.bucket_window_seconds * 1_000).toISOString();
  services.store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${atLeast}, updated_at = ${new Date(freeSince).toISOString()}
       WHERE conversation_id = ${conversationId} AND state = 'collecting' AND deadline_at < ${atLeast}`,
  );
}

export function recordToolRegistry(services: RuntimeServices, invocationId: bigint, tools: readonly AgentTool[]): void {
  const toolRegistryHash = createHash('sha256')
    .update(
      tools
        .map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
        .join('\n'),
    )
    .digest('hex');
  const toolRegistry = tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description }));
  services.store.orm
    .update(invocations)
    .set({ toolRegistryHash, toolRegistryJson: JSON.stringify(toolRegistry) })
    .where(eq(invocations.id, invocationId))
    .run();
}

export function recordAgentMessage(
  services: RuntimeServices,
  invocationId: bigint,
  role: 'assistant' | 'tool_result' | 'harness_nudge',
  text: string,
  thinking = '',
): bigint {
  const sequence =
    services.store.orm
      .all<{ value: bigint }>(
        sql`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS value FROM agent_messages WHERE invocation_id = ${invocationId}`,
      )
      .at(0)?.value ?? 1n;
  const created = services.store.orm
    .insert(agentMessages)
    .values({
      invocationId,
      sequenceNo: sequence,
      role,
      text,
      thinkingText: thinking,
      createdAt: new Date().toISOString(),
    })
    .returning({ id: agentMessages.id })
    .get();
  if (created === undefined) {
    throw new Error('agent_messages insert returned no row');
  }
  return created.id;
}

export function estimateToolDefinitionCharacters(tool: AgentTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }).length;
}

export function estimateToolRegistryCharacters(tools: readonly AgentTool[]): number {
  return tools.reduce((total, tool) => total + estimateToolDefinitionCharacters(tool), 0);
}

export function validateToolRegistry(tools: readonly AgentTool[], contextWindow: number): void {
  if (tools.length > 64) {
    throw new Error(`Tool registry has ${tools.length} tools; maximum is 64`);
  }
  const characters = estimateToolRegistryCharacters(tools);
  if (characters / 4 > contextWindow * 0.1) {
    throw new Error('Tool registry exceeds 10% of the model context window');
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

export function errorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'error', reason: 'error', error: message });
  return stream;
}
