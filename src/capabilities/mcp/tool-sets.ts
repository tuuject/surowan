/**
 * Tool-set resolution: which tools one Chat reaches, and whether those sets are
 * allowed.
 *
 * Everything here is a pure read of the manager's state plus the configuration
 * the caller supplies — the published snapshot for an invocation, or a candidate
 * for the reload check. Nothing reconnects, so this module stays synchronous and
 * testable without a server.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type, { type TUnsafe } from 'typebox';
import Compile from 'typebox/compile';
import type { FileChat, McpServerConfig, RawConfig } from '../../platform/config/index.ts';
import { deepEqual } from '../../platform/config/diff-merge.ts';
import { type InvocationContext, previewContext } from '../../platform/invocation-context.ts';
import { resolveChatConfig } from '../../store/store.ts';
import { boundChatServers, serverToolPolicy } from './bindings.ts';
import { executeMcpTool, type McpCallDeps } from './calls.ts';
import type { McpResultDetails, McpToolResult } from './content.ts';
import type { McpState, ToolSetResolution } from './shared.ts';
import { type ManagedServer, type McpToolDefinition, TOOL_NAME_PATTERN } from './support.ts';

/**
 * Turns one server's discovery result into the definitions this alias exposes.
 * The server's own `tools` list bounds the set; task-only tools and names a
 * model API cannot carry fail the connection instead of disappearing silently.
 */
export function selectTools(
  instance: ManagedServer,
  listed: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
    readonly execution?: { readonly taskSupport?: 'optional' | 'required' | 'forbidden' | undefined } | undefined;
  }[],
): McpToolDefinition[] {
  const server = instance.config;
  const byName = new Map<string, (typeof listed)[number]>();
  for (const tool of listed) {
    if (byName.has(tool.name)) {
      throw new Error(`MCP server ${server.alias} returned duplicate tool ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  const selected =
    server.tools === '*'
      ? listed
      : server.tools.map((name) => {
          const tool = byName.get(name);
          if (tool === undefined) {
            throw new Error(`MCP server ${server.alias} is missing configured tool ${name}`);
          }
          return tool;
        });
  return selected.map((tool) => {
    if (tool.execution?.taskSupport === 'required') {
      throw new Error(`MCP task-only tool ${server.alias}__${tool.name} is unsupported`);
    }
    const exposedName = `${server.alias}__${tool.name}`;
    if (exposedName.length > 128 || !TOOL_NAME_PATTERN.test(exposedName)) {
      throw new Error(`MCP tool name is incompatible with model APIs: ${exposedName}`);
    }
    const configuredPolicy = serverToolPolicy(server, tool.name);
    if (configuredPolicy === undefined) {
      throw new Error(`MCP tool ${exposedName} has no policy`);
    }
    const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
    const validator = Compile(parameters);
    return {
      server: instance,
      serverAlias: server.alias,
      originalName: tool.name,
      exposedName,
      description: tool.description ?? `Call ${tool.name} on MCP server ${server.alias}`,
      parameters,
      validator,
      policy: configuredPolicy,
      resultMaxBytes: server.result_max_bytes,
    };
  });
}

/**
 * A Chat binding that names tools on a server whose own list is `*` can only
 * be checked against what discovery returned. A missing tool fails the
 * connection the same way a missing configured tool does, instead of silently
 * exposing a smaller set to that Chat.
 */
export function assertBindingsSatisfied(
  state: McpState,
  server: McpServerConfig,
  definitions: readonly McpToolDefinition[],
): void {
  const available = new Set(definitions.map((definition) => definition.originalName));
  for (const chat of state.config.telegram.chats) {
    for (const binding of chat.mcp ?? []) {
      if (binding.server !== server.alias) {
        continue;
      }
      const selected = binding.tools ?? server.tools;
      if (selected !== '*' && binding.tools !== undefined) {
        for (const tool of binding.tools) {
          if (!available.has(tool)) {
            throw new Error(`MCP server ${server.alias} is missing tool ${tool}, which chat ${chat.id} binds`);
          }
        }
      }
      // A wildcard selection exposes whatever discovery returned, so its
      // override names can only be checked here.
      if (selected === '*') {
        for (const policy of binding.tool_policies ?? []) {
          if (!available.has(policy.name)) {
            throw new Error(
              `MCP server ${server.alias} is missing tool ${policy.name}, which chat ${chat.id} overrides`,
            );
          }
        }
      }
    }
  }
}

/**
 * Binding tool names against servers that are already connected and will not
 * reconnect: a reload that only changes a Chat would otherwise never notice a
 * name a wildcard server does not expose.
 */
export function assertConfigBindings(state: McpState, config: RawConfig): void {
  const configured = new Map((config.mcp?.servers ?? []).map((server) => [server.alias, server]));
  for (const chat of config.telegram.chats) {
    for (const binding of chat.mcp ?? []) {
      const serverConfig = configured.get(binding.server);
      const instance = state.servers.get(binding.server);
      if (serverConfig === undefined || instance === undefined) {
        continue;
      }
      if (!deepEqual(instance.config, serverConfig) || instance.state !== 'ready') {
        // A changed or not-yet-connected server is checked when it discovers.
        continue;
      }
      const available = new Set(instance.definitions.map((definition) => definition.originalName));
      const selection = binding.tools ?? serverConfig.tools;
      if (selection !== '*') {
        for (const tool of selection) {
          if (!available.has(tool)) {
            throw new Error(`MCP server ${binding.server} is missing tool ${tool}, which chat ${chat.id} binds`);
          }
        }
        continue;
      }
      // A wildcard selection exposes whatever discovery returned, so override
      // names can only be checked against the connected instance.
      for (const policy of binding.tool_policies ?? []) {
        if (!available.has(policy.name)) {
          throw new Error(
            `MCP server ${binding.server} is missing tool ${policy.name}, which chat ${chat.id} overrides`,
          );
        }
      }
    }
  }
}

/** The tools one Chat reaches under one configuration, as definitions the call path can run. */
export function definitions(state: McpState, config: RawConfig, chat: Pick<FileChat, 'mcp'>): McpToolDefinition[] {
  const resolved: McpToolDefinition[] = [];
  for (const bound of boundChatServers(config, chat)) {
    const server = state.servers.get(bound.server.alias);
    if (server === undefined || !deepEqual(server.config, bound.server)) {
      // No connected instance of *this* server configuration yet: either the
      // reconcile has not connected it, or the alias still publishes the
      // previous configuration (which may be another endpoint and policy).
      continue;
    }
    for (const definition of server.definitions) {
      if (bound.tools !== '*' && !bound.tools.includes(definition.originalName)) {
        continue;
      }
      const policy = bound.policies.get(definition.originalName);
      resolved.push(policy === undefined ? definition : { ...definition, policy });
    }
  }
  return resolved;
}

/**
 * Every distinct tool set the configuration produces, once per set, with the
 * Chats that resolve to it. A Chat that lists no binding reaches every server,
 * so the union is validated whenever such a Chat exists.
 */
export function resolutions(state: McpState, config: RawConfig): ToolSetResolution[] {
  const groups = new Map<string, { chatIds: number[]; definitions: McpToolDefinition[] }>();
  for (const chat of config.telegram.chats) {
    const chatDefinitions = definitions(state, config, chat);
    const signature = JSON.stringify(
      chatDefinitions.map((definition) => [
        definition.exposedName,
        definition.policy.readOnly,
        definition.policy.timeoutMs,
      ]),
    );
    const group = groups.get(signature);
    if (group === undefined) {
      groups.set(signature, { chatIds: [chat.id], definitions: chatDefinitions });
    } else {
      group.chatIds.push(chat.id);
    }
  }
  return [...groups.values()];
}

/** The tools of one Chat under the configuration an invocation runs with. */
export function chatTools(
  state: McpState,
  config: RawConfig,
  callDeps: McpCallDeps,
  context: InvocationContext,
  invocationDeadline: number,
): AgentTool[] {
  const chat = resolveChatConfig(config, state.store.orm, context.chatId);
  return chat === undefined ? [] : buildTools(callDeps, definitions(state, config, chat), context, invocationDeadline);
}

export function buildTools(
  callDeps: McpCallDeps,
  definitions: readonly McpToolDefinition[],
  context: InvocationContext,
  invocationDeadline: number,
): AgentTool[] {
  return definitions.map(
    (definition): AgentTool<TUnsafe<Record<string, unknown>>, McpResultDetails> => ({
      name: definition.exposedName,
      label: definition.exposedName,
      // Usage, untrusted-result, and failure rules live once in CORE_AGENT_PROTOCOL;
      // repeating them per tool cost ~420 characters for every MCP tool on every request.
      description: `MCP tool (${definition.policy.readOnly ? 'read-only' : 'side-effecting'}): ${definition.description}`,
      parameters: definition.parameters,
      executionMode: 'sequential',
      execute: async (toolCallId, input, signal) =>
        executeTool(callDeps, definition, context, invocationDeadline, toolCallId, input, signal),
    }),
  );
}

async function executeTool(
  callDeps: McpCallDeps,
  definition: McpToolDefinition,
  context: InvocationContext,
  invocationDeadline: number,
  toolCallId: string,
  input: Record<string, unknown>,
  outerSignal?: AbortSignal,
): Promise<McpToolResult> {
  return executeMcpTool(callDeps, definition, context, invocationDeadline, toolCallId, input, outerSignal);
}

/** The 61-tool cap and the model fit, checked per resolved set. */
export function validateResolution(state: McpState, callDeps: McpCallDeps, resolution: ToolSetResolution): void {
  const tools = buildTools(callDeps, resolution.definitions, previewContext(), Number.MAX_SAFE_INTEGER);
  if (tools.length > 61) {
    throw new Error(
      `MCP tool set of chat ${resolution.chatIds.join(',')} has ${tools.length} tools; maximum alongside built-ins is 61`,
    );
  }
  state.registryValidator?.(tools, resolution.chatIds);
}
