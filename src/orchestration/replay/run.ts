/**
 * One replay run: the in-memory Pi loop, its turn, tool-call and trace guards,
 * and the redacted result document it returns.
 *
 * Split out of `replay.ts`; stream, dispatch and trace ordering are unchanged.
 */

import { randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { modelDefinitionSchema, type PublicModel } from '@plasticwan/image-service';

import { estimateMessageTokens } from '../../context/context-codec.ts';
import { composeAgentPrompt, PromptOverrideError, preparePromptOverride } from '../../platform/agent-prompt.ts';
import type { KeyedSemaphore } from '../../platform/concurrency.ts';
import { configuredToolSchemaKeywords, type RawConfig } from '../../platform/config.ts';
import { invocationGateKey } from '../../platform/invocation-policy.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { applyToolSchemaKeywords } from '../../platform/tool-schema.ts';
import { RepeatedToolFailure } from '../repeated-tool-failure.ts';
import type { ReplayPromptOverrides } from '../replay.ts';
import { createReplayTools } from '../replay-tools.ts';
import { PREFLIGHT_FIDELITY, sceneMetadata } from './preflight.ts';
import { prepareReplay, type ReplayPrepareDeps } from './prepare.ts';
import { DUPLICATE_SEND_REJECTION_LIMIT, duplicateSendGuard } from '../../capabilities/send-tool-support.ts';

const MAX_TRACE_BYTES = 1_048_576;
const MAX_TOOL_CALLS = 128;
const MAX_WALL_CLOCK_SECONDS = 240;
const MAX_TURNS = 20;

interface ReplayFailure {
  readonly code: string;
  readonly message: string;
}

interface ReplayToolCall {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments: unknown;
  result: unknown;
  is_error: boolean;
}

/** The runner's single-replay-at-a-time flag, shared by reference with `ReplayRunner`. */
export interface ReplayBusy {
  running: boolean;
}

export interface ReplayRunDeps extends ReplayPrepareDeps {
  readonly secrets: SecretStore;
  readonly modelGate: KeyedSemaphore;
  readonly shutdownSignal: AbortSignal;
  readonly busy: ReplayBusy;
}

/** Validate the core contract without resolving secrets or calling a provider. */
function publicImageModels(config: RawConfig): PublicModel[] {
  const parsed = modelDefinitionSchema.array().safeParse(config.image?.models ?? []);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    providerTag: model.providerTag,
    capabilities: model.capabilities,
    ...(model.description === undefined ? {} : { description: model.description }),
  }));
}

export async function runReplay(
  deps: ReplayRunDeps,
  id: bigint,
  override: ReplayPromptOverrides,
  requestSignal: AbortSignal,
) {
  if (deps.busy.running) {
    throw new deps.error('replay_busy', 'Another replay is running', 429);
  }
  const { source, runtime, stable, scene, registry } = prepareReplay(deps, id, override);
  let globalTemplate: string | undefined;
  let groupTemplate: string | undefined;
  try {
    globalTemplate =
      override.global_prompt === undefined ? undefined : preparePromptOverride(override.global_prompt, 'global');
    groupTemplate =
      override.group_prompt === undefined ? undefined : preparePromptOverride(override.group_prompt, 'group');
  } catch (error) {
    if (error instanceof PromptOverrideError) {
      throw new deps.error(error.code, error.message, 400);
    }
    throw error;
  }
  const systemPrompt = composeAgentPrompt(
    {
      ...stable.promptLayers,
      global: globalTemplate ?? stable.promptLayers.global,
      group: groupTemplate ?? stable.promptLayers.group,
    },
    stable.templateValues,
  );
  const { snapshot, settings, model, selection: modelSelection } = runtime;
  const { secrets, systemResources, modelGate, shutdownSignal } = deps;
  const config = snapshot.config;
  const imageLoader = deps.imageLoader;
  let duplicateSendRejections = 0;
  const capture = createReplayTools(registry, systemResources, {
    imageModels: publicImageModels(config),
    ...(config.agent.send_max_text_length === undefined ? {} : { maxTextLength: config.agent.send_max_text_length }),
    disallowBlankLines: config.agent.send_disallow_blank_lines === true,
    allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
    ...duplicateSendGuard(config.agent.send_duplicate_guard_enabled, () => {
      duplicateSendRejections += 1;
    }),
    replyMessageIds: new Set(scene.replyMessageIds),
    ...(imageLoader === undefined || !model.input.includes('image')
      ? {}
      : {
          readImage: async (ref: string, imageSignal: AbortSignal) => {
            const mediaId = scene.mediaRefs.get(ref);
            if (mediaId === undefined) {
              throw new Error('image_ref is not visible in this scene');
            }
            return await imageLoader(mediaId, AbortSignal.any([signal, imageSignal]));
          },
        }),
  });
  const tools = applyToolSchemaKeywords(
    capture.tools,
    configuredToolSchemaKeywords(config, settings.provider, settings.model),
  );
  const maxTurns = Math.min(MAX_TURNS, config.agent.rate_limits.turns_per_injection);
  const wallClockSeconds = Math.min(MAX_WALL_CLOCK_SECONDS, config.agent.context.max_wall_clock_seconds);
  const replayId = randomUUID();
  const startedAt = new Date();
  const timeout = AbortSignal.timeout(wallClockSeconds * 1_000);
  const signal = AbortSignal.any([requestSignal, shutdownSignal, timeout]);
  let error: ReplayFailure | null = null;
  let completionReason = 'completed';
  let turns = 0;
  let traceBytes = 2;
  let partialBytes = 0;
  const trace: unknown[] = [];
  const toolCalls: ReplayToolCall[] = [];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost: 0 };
  const fail = (code: string, message: string): void => {
    error ??= { code, message: secrets.redact(message).slice(0, 4_096) };
    completionReason = error.code;
  };
  const redacted = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === 'string') {
          return secrets.redact(entry);
        }
        // Tool argument keys and dispatch names are model-controlled too.
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          return Object.fromEntries(Object.entries(entry).map(([key, child]) => [secrets.redact(key), child]));
        }
        return entry;
      }),
    );
  const repeatedFailure = new RepeatedToolFailure();
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: settings.thinking_level,
      messages: [{ role: 'user', content: scene.text, timestamp: Date.parse(scene.cutoffAt) }],
      tools,
    },
    sessionId: `replay-${replayId}`,
    toolExecution: 'sequential',
    streamFn: async (streamModel, context, options) => {
      signal.throwIfAborted();
      // pi 1.x carries tool declarations in the transcript's system messages, so
      // the estimate reads the seeded registry directly instead of `context.tools`.
      const inputTokens =
        context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
        Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
      if (inputTokens + streamModel.maxTokens >= streamModel.contextWindow * config.agent.context_stop_ratio) {
        fail('context_limit', 'Replay input exceeds the current model context budget');
        throw new Error('Replay context limit');
      }
      if (turns >= maxTurns) {
        fail('turn_budget', 'Replay turn budget exhausted');
        throw new Error('Replay turn budget');
      }
      const release = await modelGate.acquire(invocationGateKey('telegram', source.chatId), signal);
      try {
        signal.throwIfAborted();
        turns += 1;
        const stream = snapshot.models.streamSimple(streamModel, context, {
          ...options,
          signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
          maxTokens: streamModel.maxTokens,
          maxRetries: 0,
          maxRetryDelayMs: 0,
        });
        void stream
          .result()
          .finally(release)
          .catch(() => undefined);
        return stream;
      } catch (cause) {
        release();
        throw cause;
      }
    },
    beforeToolCall: async () => {
      if (signal.aborted || error !== null) {
        return { block: true, terminate: true, reason: 'Replay stopped' };
      }
      return undefined;
    },
    // pi 1.x: `finishTurn` replaces `shouldStopAfterTurn` and runs before
    // `turn_end`; `{ action: 'end' }` stops the run after the completed turn.
    finishTurn: (turn) => {
      if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') {
        // Hard exits; pi ignores the decision on these turns.
        return undefined;
      }
      if (error !== null || signal.aborted) {
        return { action: 'end' };
      }
      if (turn.toolResults.some((result) => result.toolName === 'zzz' && !result.isError)) {
        completionReason = 'sleep';
        return { action: 'end' };
      }
      if (duplicateSendRejections > DUPLICATE_SEND_REJECTION_LIMIT) {
        completionReason = 'duplicate_send';
        return { action: 'end' };
      }
      if (repeatedFailure.observe(turn)) {
        completionReason = 'repeated_tool_failure';
        return { action: 'end' };
      }
      if (turn.message.content.some((block) => block.type === 'toolCall') && turns >= maxTurns) {
        fail('turn_budget', 'Replay turn budget exhausted');
        return { action: 'end' };
      }
      return undefined;
    },
  });
  agent.subscribe((event) => {
    if (event.type === 'message_start') {
      partialBytes = 0;
    } else if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta' || delta.type === 'toolcall_delta') {
        partialBytes += Buffer.byteLength(delta.delta);
        if (traceBytes + partialBytes > MAX_TRACE_BYTES) {
          fail('trace_limit', 'Replay trace exceeded its size limit');
          agent.abort();
        }
      }
    } else if (event.type === 'tool_execution_start') {
      if (error !== null || signal.aborted) {
        return;
      }
      // Pi validates arguments before beforeToolCall, so count attempted calls
      // here as well: unknown names and invalid schemas must consume the cap.
      if (toolCalls.length >= MAX_TOOL_CALLS) {
        fail('tool_budget', 'Replay tool-call budget exhausted');
        agent.abort();
        return;
      }
      toolCalls.push({
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: redacted(event.args),
        result: null,
        is_error: false,
      });
    } else if (event.type === 'tool_execution_end') {
      const callEntry = toolCalls.findLast((entry) => entry.tool_call_id === event.toolCallId);
      if (callEntry !== undefined) {
        const result = redacted(event.result);
        if (traceBytes + Buffer.byteLength(JSON.stringify(result)) > MAX_TRACE_BYTES) {
          fail('trace_limit', 'Replay trace exceeded its size limit');
          agent.abort();
          callEntry.is_error = true;
        } else {
          callEntry.result = result;
          callEntry.is_error = event.isError;
        }
      }
    } else if (event.type === 'message_end') {
      const message = event.message;
      if (message.role === 'assistant') {
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cache_read += message.usage.cacheRead;
        usage.cache_write += message.usage.cacheWrite;
        usage.total_tokens = usage.input + usage.output + usage.cache_read + usage.cache_write;
        usage.cost += message.usage.cost.total;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          fail('model_error', message.errorMessage ?? 'Model request failed');
        }
      }
      const json = JSON.stringify(redacted(message));
      traceBytes += Buffer.byteLength(json) + (trace.length > 0 ? 1 : 0);
      if (traceBytes > MAX_TRACE_BYTES) {
        fail('trace_limit', 'Replay trace exceeded its size limit');
        agent.abort();
      } else {
        trace.push(JSON.parse(json));
      }
    }
  });
  const abort = (): void => agent.abort();
  signal.addEventListener('abort', abort, { once: true });
  deps.busy.running = true;
  try {
    signal.throwIfAborted();
    await agent.continue();
    if (agent.state.errorMessage !== undefined) {
      fail('model_error', agent.state.errorMessage);
    }
  } catch (cause) {
    fail('replay_failed', secrets.redactError(cause));
  } finally {
    signal.removeEventListener('abort', abort);
    deps.busy.running = false;
  }
  if (signal.aborted) {
    error = {
      code: timeout.aborted ? 'timeout' : 'aborted',
      message: timeout.aborted ? 'Replay wall-clock limit exceeded' : 'Replay cancelled',
    };
    completionReason = error.code;
  }
  return redacted({
    version: 2,
    replay_id: replayId,
    source_invocation_id: id.toString(),
    scene: sceneMetadata(scene),
    conversation_id: source.conversationId.toString(),
    chat_id: source.chatId.toString(),
    thread_id: source.threadId.toString(),
    model: { provider: model.provider, id: model.id, thinking_level: settings.thinking_level },
    overrides: {
      global_prompt: override.global_prompt !== undefined,
      group_prompt: override.group_prompt !== undefined,
      provider: override.provider !== undefined,
      model: override.model !== undefined,
      thinking_level: override.thinking_level !== undefined,
    },
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    latency_ms: Date.now() - startedAt.getTime(),
    completion_reason: completionReason,
    responded: capture.outputs.length > 0,
    send_count: capture.outputs.length,
    outputs: capture.outputs.map(redacted),
    tool_calls: toolCalls,
    usage: { ...usage, model_calls: turns },
    trace,
    error,
    fidelity: {
      ...PREFLIGHT_FIDELITY,
      model_selection:
        modelSelection.provider || modelSelection.model || modelSelection.thinking_level
          ? 'temporary_override'
          : 'current_chat_config',
      hot_injections: scene.slice === undefined ? 'not_replayed' : 'flattened_before_send',
      omitted_images: scene.omittedImages,
      memory_and_alarms: 'empty_in_memory_overlay',
      ref_authorization: 'scene_local_media_and_reply',
      synthetic_validation: 'current_schema_and_send_limits_no_world_state_checks',
      dispatch_mode: 'execution_path_not_success',
      send_nudge: 'disabled',
      production_budgets: 'not_charged',
      limits: {
        turns: maxTurns,
        tool_calls: MAX_TOOL_CALLS,
        wall_clock_seconds: wallClockSeconds,
        trace_bytes: MAX_TRACE_BYTES,
      },
      dispatches: capture.dispatches,
    },
  });
}
