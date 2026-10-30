import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { PublicModel } from '@surowan/image-service';
import { createExecuteTool } from '../../capabilities/execute-tool.ts';
import { SystemResourceError, type SystemResources } from '../../platform/system-resources.ts';
import type { ToolAudit } from '../../store/tool-audit.ts';
import {
  checkedInput,
  replayBlockedTool,
  replayCapability,
  replayExecuteTool,
  replayZzzTool,
} from './tools-capabilities.ts';
import { replaySendReplyTool, replaySendTool } from './tools-send.ts';
import {
  ReadMemoryInputValidator,
  ReplayReadInputValidator,
  SearchMemoryInputValidator,
  replayToolBase,
} from './tools-spec.ts';

/**
 * Scene execution against current tool definitions, never their production
 * executors. Each call is either synthesized in memory
 * (`synthetic`), served from readonly system resources or scene-authorized
 * image bytes (`live_read`), or refused (`blocked`). Production executors for
 * web fetching, sticker search, Vision, unknown capabilities, unknown
 * top-level tools, and MCP tools are all deny-by-default. `list_image_models`
 * is synthetic: it pages the runner-provided current model directory
 * (`imageModels`, already stripped of credentials) in memory, exactly like
 * `list_alarm` pages its in-memory overlay; it never touches the image bridge.
 */

export type ReplayDispatchMode = 'synthetic' | 'live_read' | 'blocked';

export type ReplayToolDefinition = Pick<AgentTool, 'name' | 'label' | 'description' | 'parameters'>;
export interface ReplayToolRegistry {
  readonly tools: readonly ReplayToolDefinition[];
  readonly capabilities: readonly ReplayToolDefinition[];
}

export function toolDefinition(tool: ReplayToolDefinition): ReplayToolDefinition {
  return { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters };
}

export interface ReplayToolOptions {
  readonly readImage?: (ref: string, signal: AbortSignal) => Promise<ImageContent>;
  /** The current image model directory, credential-free; absent means an empty catalog. */
  readonly imageModels?: readonly PublicModel[];
  readonly maxTextLength?: number;
  readonly disallowBlankLines?: boolean;
  readonly allowReplyMessageMultipleTimes?: boolean;
  /** Mirrors the production duplicate send guard within one replay scene. */
  readonly duplicateSendGuard?: { readonly onRejected: () => void };
  readonly replyMessageIds?: ReadonlySet<string>;
}

/** One successfully synthesized `send`; `arguments` are the call's own input fields. */
export interface ReplayOutput {
  readonly tool_call_id: string;
  readonly tool_name: 'send';
  readonly arguments: Record<string, unknown>;
  readonly reply_to_message_id: string | null;
}

/**
 * One attempted tool dispatch. `mode` is the path the call took, not its
 * outcome: `blocked` calls are recorded before the refusal is thrown, a
 * `live_read` is recorded before the resource read is attempted, and a
 * `synthetic` call is recorded when its tool handles it without any external
 * effect. `capability` is set for `execute.call` dispatches and names the inner
 * capability the call targeted.
 */
export interface ReplayDispatch {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly mode: ReplayDispatchMode;
  readonly capability?: string;
}

export interface ReplayTools {
  readonly tools: AgentTool[];
  readonly outputs: ReplayOutput[];
  readonly dispatches: ReplayDispatch[];
}

interface MemoryEntry {
  readonly summary: string;
  readonly detail: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

interface AlarmEntry {
  readonly scheduledAt: string;
  readonly summary: string;
}

export interface ReplayState {
  readonly outputs: ReplayOutput[];
  readonly dispatches: ReplayDispatch[];
  readonly memories: Map<string, MemoryEntry>;
  /** Memo ids whose detail a scene tool has read. */
  readonly memoryReads: Set<string>;
  readonly alarms: Map<string, AlarmEntry>;
  readonly imageResults: Map<string, ImageContent>;
  /** Content the reply policy rejected in this scene; retargeting it is refused. */
  readonly burnedContentKeys: Set<string>;
  sends: number;
  nextAlarmId: bigint;
  readonly options: ReplayToolOptions;
}

export function createReplayTools(
  input: ReplayToolRegistry,
  resources: SystemResources,
  options: ReplayToolOptions = {},
): ReplayTools {
  const state: ReplayState = {
    outputs: [],
    dispatches: [],
    memories: new Map(),
    memoryReads: new Set(),
    alarms: new Map(),
    imageResults: new Map(),
    burnedContentKeys: new Set(),
    sends: 0,
    nextAlarmId: 0n,
    options,
  };
  // The runner captures audit events from the tool results; replay only needs a
  // no-op sink so the same createExecuteTool dispatch path can run.
  const audit: ToolAudit = {
    start: () => ({ succeed: () => {}, fail: () => {} }),
    reject: () => {},
  };
  const execute = createExecuteTool({
    audit,
    capabilities: input.capabilities.map((definition) => replayCapability(definition, state)),
  });
  const registeredCapabilities = new Set(input.capabilities.map((definition) => definition.name));
  const tools: AgentTool[] = [];
  const seen = new Set<string>();
  for (const definition of input.tools) {
    if (seen.has(definition.name)) {
      throw new Error(`Duplicate replay tool definition: ${definition.name}`);
    }
    seen.add(definition.name);
    tools.push(replayTool(definition, state, resources, execute, registeredCapabilities));
  }
  return { tools, outputs: state.outputs, dispatches: state.dispatches };
}

function replayTool(
  definition: ReplayToolDefinition,
  state: ReplayState,
  resources: SystemResources,
  execute: AgentTool,
  registeredCapabilities: ReadonlySet<string>,
): AgentTool {
  if (definition.name === 'read') {
    return replayReadTool(definition, resources, state.dispatches);
  }
  if (definition.name === 'send') {
    return replaySendTool(definition, state);
  }
  if (definition.name === 'send_reply') {
    return replaySendReplyTool(definition, state);
  }
  if (definition.name === 'execute') {
    return replayExecuteTool(definition, execute, state, registeredCapabilities);
  }
  if (definition.name === 'zzz') {
    return replayZzzTool(definition, state.dispatches);
  }
  if (definition.name === 'search_memory') {
    return replaySearchMemoryTool(definition, state);
  }
  if (definition.name === 'read_memory') {
    return replayReadMemoryTool(definition, state);
  }
  return replayBlockedTool(definition, state.dispatches);
}

function replayReadTool(
  definition: ReplayToolDefinition,
  resources: SystemResources,
  dispatches: ReplayDispatch[],
): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ReplayReadInputValidator, params, 'read');
      dispatches.push({ tool_call_id: toolCallId, tool_name: 'read', mode: 'live_read' });
      try {
        const resource = await resources.readText(input.uri, input.base);
        return {
          content: [{ type: 'text' as const, text: resource.text }],
          details: { uri: resource.uri, truncated: resource.truncated },
        };
      } catch (error) {
        throw new Error(
          error instanceof SystemResourceError
            ? `read failed: ${error.code} (${error.message})`
            : 'read failed: read_error',
        );
      }
    },
  };
}

function replaySearchMemoryTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(SearchMemoryInputValidator, params, 'search_memory');
      const keywords = (input.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
      const matches = [...state.memories.entries()]
        .filter(([, entry]) => {
          if (input.from !== undefined && entry.createdAt < new Date(input.from).toISOString()) {
            return false;
          }
          if (input.to !== undefined && entry.createdAt > new Date(input.to).toISOString()) {
            return false;
          }
          if (keywords.length === 0) {
            return true;
          }
          const summary = entry.summary.toLowerCase();
          const detail = entry.detail.toLowerCase();
          const hits = keywords.filter((keyword) => summary.includes(keyword) || detail.includes(keyword)).length;
          return hits >= Math.ceil(keywords.length / 2);
        })
        .toReversed()
        .slice(0, input.limit ?? 20);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              matches.length === 0
                ? 'No matching memories in this Chat.'
                : [
                    `Found ${matches.length} memories:`,
                    ...matches.map(
                      ([id, entry]) =>
                        `- ${id} [${entry.expiresAt === null ? 'long-term' : `short-term, expires ${entry.expiresAt}`}; created ${entry.createdAt}]: ${entry.summary}`,
                    ),
                    'Call read_memory with an id to read its detail.',
                  ].join('\n'),
          },
        ],
        details: { count: matches.length },
      };
    },
  };
}

function replayReadMemoryTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const input = checkedInput(ReadMemoryInputValidator, params, 'read_memory');
      const entry = state.memories.get(input.id);
      if (entry === undefined) {
        throw new Error('Memory not found in this Chat');
      }
      state.memoryReads.add(input.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `id: ${input.id}`,
              `summary: ${entry.summary}`,
              `created_at: ${entry.createdAt}`,
              `expires_at: ${entry.expiresAt ?? 'permanent'}`,
              'detail:',
              entry.detail,
            ].join('\n'),
          },
        ],
        details: { id: input.id },
      };
    },
  };
}
