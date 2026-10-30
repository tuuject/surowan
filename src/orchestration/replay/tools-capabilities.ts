/**
 * The replay capabilities and remaining replay tools: execute dispatch
 * bookkeeping, zzz, the blocked tool, and the in-memory memory, alarm and
 * image surface.
 *
 * Split out of `replay-tools.ts`; every refusal and detail payload is
 * unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { capability, type ExecutableCapability } from '../../capabilities/execute-tool.ts';
import { MEMO_WRITE_INPUT_MAX_BYTES, newMemoBlobId, newMemoId } from '../../context/memo-pad/index.ts';
import { isMemoActive } from '../../context/memo-pad/search.ts';
import { imageModelPage } from '../../plugins/image/image.ts';
import type { ReplayDispatch, ReplayState, ReplayToolDefinition } from './tools.ts';
import {
  AddMemoInputValidator,
  AlarmInputValidator,
  DeleteAlarmInputValidator,
  DeleteMemoInputValidator,
  ImageGenerateInputValidator,
  ListAlarmInputValidator,
  ListImageModelsInputValidator,
  REPLAY_IMAGE_DEFAULT_OUTPUT_COUNT,
  REPLAY_IMAGE_MODEL_ID,
  REPLAY_MINIMUM_SLEEP_MS,
  SaveMemoImageInputValidator,
  SYNTHETIC_CAPABILITIES,
  UpdateMemoInputValidator,
  ZzzInputValidator,
  replayToolBase,
} from './tools-spec.ts';

export function replayZzzTool(definition: ReplayToolDefinition, dispatches: ReplayDispatch[]): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      if (!ZzzInputValidator.Check(params)) {
        throw new Error('zzz input does not match the tool schema');
      }
      dispatches.push({ tool_call_id: toolCallId, tool_name: 'zzz', mode: 'synthetic' });
      const now = new Date();
      const nextResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const sleepUntil = new Date(Math.max(now.getTime() + REPLAY_MINIMUM_SLEEP_MS, nextResetAt)).toISOString();
      return {
        content: [{ type: 'text' as const, text: `Sleeping until ${sleepUntil}` }],
        details: { sleep_until: sleepUntil, entered: true },
      };
    },
  };
}

export function replayExecuteTool(
  definition: ReplayToolDefinition,
  inner: AgentTool,
  state: ReplayState,
  registeredCapabilities: ReadonlySet<string>,
): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      recordExecuteDispatch(state, toolCallId, params, registeredCapabilities);
      const imageCallId = `${toolCallId}:read_image`;
      try {
        // The shared execute gateway validates and audits text envelopes. Scene
        // reads additionally return bytes to this image-capable model, not Vision.
        const result = await inner.execute(toolCallId, params, signal);
        const request = params as { action?: unknown; tool?: unknown };
        if (request.action === 'call' && request.tool === 'save_memo_image') {
          state.dispatches.push({
            tool_call_id: toolCallId,
            tool_name: 'execute',
            mode: 'synthetic',
            capability: 'save_memo_image',
          });
        }
        const image = state.imageResults.get(imageCallId);
        return image === undefined ? result : { ...result, content: [...result.content, image] };
      } finally {
        state.imageResults.delete(imageCallId);
      }
    },
  };
}

export function replayBlockedTool(definition: ReplayToolDefinition, dispatches: ReplayDispatch[]): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, _params, signal) => {
      signal?.throwIfAborted();
      dispatches.push({ tool_call_id: toolCallId, tool_name: definition.name, mode: 'blocked' });
      throw new Error(`scene test blocks tool ${definition.name}: no production executor is wired`);
    },
  };
}

export function replayCapability(definition: ReplayToolDefinition, state: ReplayState): ExecutableCapability {
  if (definition.name === 'typing') {
    return capability(
      {
        ...replayToolBase(definition),
        execute: async (_id, _params, signal) => {
          signal?.throwIfAborted();
          return { content: [{ type: 'text', text: 'Typing requested; use send to publish the reply.' }], details: {} };
        },
      },
      false,
    );
  }
  const readImage = state.options.readImage;
  if (definition.name === 'read_image' && readImage !== undefined) {
    return capability(
      {
        ...replayToolBase(definition),
        execute: async (id, params, signal) => {
          const input = params as { image_ref?: unknown };
          if (typeof input.image_ref !== 'string') {
            throw new Error('read_image input does not match the tool schema');
          }
          signal?.throwIfAborted();
          const image =
            state.savedImages.get(input.image_ref) ??
            (await readImage(input.image_ref, signal ?? new AbortController().signal));
          signal?.throwIfAborted();
          state.imageResults.set(id, image);
          return { content: [{ type: 'text', text: 'Scene image loaded.' }], details: { scene_image: true } };
        },
      },
      false,
    );
  }
  if (definition.name === 'add_memo') {
    return capability(replayAddMemoTool(definition, state), true, { inputMaxBytes: MEMO_WRITE_INPUT_MAX_BYTES });
  }
  if (definition.name === 'update_memo') {
    return capability(replayUpdateMemoTool(definition, state), true, { inputMaxBytes: MEMO_WRITE_INPUT_MAX_BYTES });
  }
  if (definition.name === 'delete_memo') {
    return capability(replayDeleteMemoTool(definition, state), true);
  }
  if (definition.name === 'save_memo_image' && readImage !== undefined) {
    return capability(replaySaveMemoImageTool(definition, state, readImage), true);
  }
  if (definition.name === 'alarm') {
    return capability(replayAlarmTool(definition, state), true);
  }
  if (definition.name === 'list_alarm') {
    return capability(replayListAlarmTool(definition, state), false);
  }
  if (definition.name === 'delete_alarm') {
    return capability(replayDeleteAlarmTool(definition, state), true);
  }
  if (definition.name === 'image_generate') {
    return capability(replayImageGenerateTool(definition), true);
  }
  if (definition.name === 'list_image_models') {
    return capability(replayListImageModelsTool(definition, state), false);
  }
  return replayBlockedCapability(definition);
}

function replayAddMemoTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(AddMemoInputValidator, params, 'add_memo');
      const now = new Date();
      const timestamp = now.toISOString();
      const expiresAt =
        input.ttl_seconds === undefined ? null : new Date(now.getTime() + input.ttl_seconds * 1_000).toISOString();
      const id = newMemoId();
      state.memories.set(id, {
        id,
        summary: input.summary,
        detail: input.detail,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${id}; ${expiresAt === null ? 'it does not expire' : `it expires at ${expiresAt}`}`,
          },
        ],
        details: { id, expires_at: expiresAt },
      };
    },
  };
}

function replayUpdateMemoTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(UpdateMemoInputValidator, params, 'update_memo');
      const existing = state.memories.get(input.id);
      const now = new Date();
      if (existing === undefined || !isMemoActive(existing, now)) {
        throw new Error('Memory not found in this Chat');
      }
      if (!state.memoryReads.has(input.id)) {
        throw new Error('Read this memory with read_memory before modifying it');
      }
      const expiresAt =
        input.ttl_seconds === undefined
          ? existing.expiresAt
          : input.ttl_seconds === null
            ? null
            : new Date(now.getTime() + input.ttl_seconds * 1_000).toISOString();
      state.memories.set(input.id, {
        id: input.id,
        summary: input.summary ?? existing.summary,
        detail: input.detail ?? existing.detail,
        createdAt: existing.createdAt,
        updatedAt: now.toISOString(),
        expiresAt,
      });
      state.memoryReads.delete(input.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated ${input.id}; ${expiresAt === null ? 'it does not expire' : `it expires at ${expiresAt}`}`,
          },
        ],
        details: { id: input.id, expires_at: expiresAt },
      };
    },
  };
}

function replayDeleteMemoTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(DeleteMemoInputValidator, params, 'delete_memo');
      const deleted = state.memories.delete(input.id);
      state.memoryReads.delete(input.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: deleted ? `Memory ${input.id} deleted` : `Memory ${input.id} was already gone`,
          },
        ],
        details: { id: input.id, deleted },
      };
    },
  };
}

function replaySaveMemoImageTool(
  definition: ReplayToolDefinition,
  state: ReplayState,
  readImage: NonNullable<ReplayState['options']['readImage']>,
): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(SaveMemoImageInputValidator, params, 'save_memo_image');
      if (!input.image_ref.startsWith('img_')) {
        throw new Error('image_ref is not visible in this conversation context');
      }
      const image = await readImage(input.image_ref, signal ?? new AbortController().signal);
      signal?.throwIfAborted();
      const uri = `pwblob://${newMemoBlobId()}`;
      state.savedImages.set(uri, image);
      return {
        content: [{ type: 'text' as const, text: `Saved image as ${uri}.` }],
        details: { blob_uri: uri, mime: image.mimeType, byte_size: Buffer.byteLength(image.data, 'base64') },
      };
    },
  };
}

function replayAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(AlarmInputValidator, params, 'alarm');
      const scheduledAt = new Date(input.datetime);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new Error('alarm datetime is invalid');
      }
      const scheduledIso = scheduledAt.toISOString();
      state.nextAlarmId += 1n;
      const id = state.nextAlarmId.toString();
      state.alarms.set(id, { scheduledAt: scheduledIso, summary: input.summary });
      return {
        content: [{ type: 'text' as const, text: `Scheduled alarm ${id} for ${scheduledIso}` }],
        details: { id, scheduled_at: scheduledIso },
      };
    },
  };
}

function replayListAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      checkedInput(ListAlarmInputValidator, params, 'list_alarm');
      const items = [...state.alarms.entries()]
        .map(([id, entry]) => ({ id, scheduled_at: entry.scheduledAt, summary: entry.summary }))
        .sort((left, right) => {
          if (left.scheduled_at !== right.scheduled_at) {
            return left.scheduled_at < right.scheduled_at ? -1 : 1;
          }
          return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
        });
      const details = { items };
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  };
}

function replayDeleteAlarmTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(DeleteAlarmInputValidator, params, 'delete_alarm');
      if (!state.alarms.delete(input.id)) {
        throw new Error('alarm not found');
      }
      const cancelledAt = new Date().toISOString();
      return {
        content: [{ type: 'text' as const, text: `Cancelled alarm ${input.id}` }],
        details: { id: input.id, state: 'cancelled' as const, cancelled_at: cancelledAt },
      };
    },
  };
}

function replayImageGenerateTool(definition: ReplayToolDefinition): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ImageGenerateInputValidator, params, 'image_generate');
      const generationId = randomUUID();
      const modelId = input.model_id ?? REPLAY_IMAGE_MODEL_ID;
      const outputCount = input.output_count ?? REPLAY_IMAGE_DEFAULT_OUTPUT_COUNT;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Generation ${generationId} submitted on model ${modelId} (${outputCount} output(s)). The result arrives as a completion receipt; do not claim the image exists before then.`,
          },
        ],
        details: { generation_id: generationId, model_id: modelId, output_count: outputCount, replayed: false },
      };
    },
  };
}

/**
 * Pages the runner-provided model directory in memory: no bridge, no network,
 * no generation submission, and no credentials (the projection is made before
 * the directory reaches replay). An absent or empty directory is an explicit
 * empty page, mirroring the production store when no snapshot is published.
 */
function replayListImageModelsTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ListImageModelsInputValidator, params, 'list_image_models');
      const page = imageModelPage(state.options.imageModels ?? [], input.offset);
      const text = JSON.stringify(page);
      return { content: [{ type: 'text' as const, text }], details: page };
    },
  };
}

function replayBlockedCapability(definition: ReplayToolDefinition): ExecutableCapability {
  return capability(
    {
      ...replayToolBase(definition),
      execute: async (_toolCallId, _params, signal) => {
        signal?.throwIfAborted();
        throw new Error(`replay blocks capability ${definition.name}: no production executor is wired`);
      },
    },
    false,
  );
}

function recordExecuteDispatch(
  state: ReplayState,
  toolCallId: string,
  params: unknown,
  registeredCapabilities: ReadonlySet<string>,
): void {
  if (typeof params !== 'object' || params === null) {
    return;
  }
  const request = params as Record<string, unknown>;
  const action = typeof request.action === 'string' ? request.action : undefined;
  const target = typeof request.tool === 'string' ? request.tool : undefined;
  const dispatches = state.dispatches;
  if (action === 'call' && target !== undefined) {
    const synthetic = registeredCapabilities.has(target) && SYNTHETIC_CAPABILITIES.has(target);
    const imageInput = request.input as { image_ref?: unknown } | undefined;
    const localImage =
      target === 'read_image' &&
      typeof imageInput?.image_ref === 'string' &&
      state.savedImages.has(imageInput.image_ref);
    const readsImage =
      (target === 'read_image' || target === 'save_memo_image') && state.options.readImage !== undefined;
    dispatches.push({
      tool_call_id: toolCallId,
      tool_name: 'execute',
      mode:
        registeredCapabilities.has(target) && readsImage && !localImage
          ? 'live_read'
          : synthetic || (registeredCapabilities.has(target) && localImage)
            ? 'synthetic'
            : 'blocked',
      capability: target,
    });
    return;
  }
  if (action === 'search' || action === 'help') {
    dispatches.push({ tool_call_id: toolCallId, tool_name: 'execute', mode: 'synthetic' });
  }
}

export function checkedInput<T>(validator: { Check(value: unknown): value is T }, value: unknown, toolName: string): T {
  if (!validator.Check(value)) {
    throw new Error(`${toolName} input does not match the tool schema`);
  }
  return value;
}
