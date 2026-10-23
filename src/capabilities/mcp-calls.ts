import { setTimeout as delay } from 'node:timers/promises';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { InvocationContext } from '../platform/invocation-context.ts';
import { safeJson, truncateUtf8 } from '../platform/truncate.ts';
import type { BusinessStore } from '../store/store.ts';
import { finishToolCall, rejectToolCall, startToolCall } from '../store/store.ts';
import {
  ARGUMENT_MAX_BYTES,
  KnownToolError,
  TRUNCATION_MARKER,
  classifyMcpError,
  isTransient,
  type ManagedServer,
  type McpCallResult,
  type McpToolDefinition,
} from './mcp-support.ts';

export interface McpCallDeps {
  readonly store: BusinessStore;
  readonly servers: ReadonlyMap<string, ManagedServer>;
  setState(server: ManagedServer, state: ManagedServer['state'], errorCode: string | null): void;
  scheduleReconnect(server: ManagedServer): void;
}

export async function executeMcpTool(
  deps: McpCallDeps,
  definition: McpToolDefinition,
  context: InvocationContext,
  invocationDeadline: number,
  toolCallId: string,
  input: Record<string, unknown>,
  outerSignal?: AbortSignal,
): Promise<{ content: { type: 'text'; text: string }[]; details: { server: string; tool: string } }> {
  if (invocationDeadline <= Date.now()) {
    recordRejectedCall(deps.store, context.invocationId, toolCallId, definition, input, 'invocation_timeout');
    throw new Error('Invocation deadline reached before MCP tool call');
  }
  if (!definition.validator.Check(input)) {
    recordRejectedCall(deps.store, context.invocationId, toolCallId, definition, input, 'invalid_arguments');
    throw new Error('MCP tool arguments do not match the configured schema');
  }
  const argumentsJson = JSON.stringify(input);
  if (Buffer.byteLength(argumentsJson) > ARGUMENT_MAX_BYTES) {
    recordRejectedCall(deps.store, context.invocationId, toolCallId, definition, input, 'arguments_too_large');
    throw new Error('MCP tool arguments exceed 32 KiB');
  }
  const auditId = startToolCall(
    deps.store.orm,
    context.invocationId,
    toolCallId,
    definition.exposedName,
    argumentsJson,
    !definition.policy.readOnly,
  );
  const server = deps.servers.get(definition.serverAlias);
  if (server === undefined) {
    finishToolCall(deps.store.orm, auditId, 'error', null, 'server_unconfigured', {
      startedAt: performance.now(),
      pendingOnly: true,
    });
    throw new Error('MCP server is not configured');
  }
  const startedAt = performance.now();
  let release: () => void;
  try {
    release = await server.semaphore.acquire(outerSignal ?? new AbortController().signal);
  } catch {
    finishToolCall(deps.store.orm, auditId, 'error', null, 'aborted_before_request', {
      startedAt,
      pendingOnly: true,
    });
    throw new Error('MCP tool call aborted before request');
  }
  try {
    const timeoutMs = Math.max(1, Math.min(definition.policy.timeoutMs, invocationDeadline - Date.now()));
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (outerSignal !== undefined) {
      signals.push(outerSignal);
    }
    const signal = AbortSignal.any(signals);
    let result: McpCallResult;
    try {
      result = await callMcpTool(server, definition, input, signal, timeoutMs);
    } catch (error) {
      if (!definition.policy.readOnly || !isTransient(error) || signal.aborted) {
        throw error;
      }
      await delay(100, undefined, { signal });
      result = await callMcpTool(server, definition, input, signal, timeoutMs);
    }
    const text = truncateUtf8(JSON.stringify(result), definition.resultMaxBytes, TRUNCATION_MARKER);
    if ('isError' in result && result.isError === true) {
      finishToolCall(deps.store.orm, auditId, 'error', text, 'mcp_tool_error', {
        startedAt,
        pendingOnly: true,
      });
      throw new KnownToolError(text);
    }
    finishToolCall(deps.store.orm, auditId, 'success', text, null, { startedAt, pendingOnly: true });
    return {
      content: [{ type: 'text', text }],
      details: { server: definition.serverAlias, tool: definition.originalName },
    };
  } catch (error) {
    if (error instanceof KnownToolError) {
      throw new Error(error.message);
    }
    const known =
      error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout;
    const state = known ? 'error' : 'outcome_unknown';
    finishToolCall(deps.store.orm, auditId, state, null, classifyMcpError(error), {
      startedAt,
      pendingOnly: true,
    });
    if (!known) {
      deps.setState(server, 'degraded', classifyMcpError(error));
      deps.scheduleReconnect(server);
    }
    throw new Error(`MCP tool ${definition.exposedName} failed: ${classifyMcpError(error)}`);
  } finally {
    release();
  }
}

export async function callMcpTool(
  server: ManagedServer,
  definition: McpToolDefinition,
  input: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<McpCallResult> {
  const client = server.client;
  if (client === undefined || server.state !== 'ready') {
    throw new Error('MCP transport is unavailable');
  }
  return client.callTool({ name: definition.originalName, arguments: input }, undefined, {
    signal,
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
  });
}

export function recordRejectedCall(
  store: BusinessStore,
  invocationId: bigint,
  toolCallId: string,
  definition: McpToolDefinition,
  input: unknown,
  errorCode: string,
): void {
  rejectToolCall(
    store.orm,
    invocationId,
    toolCallId,
    definition.exposedName,
    safeJson(input, ARGUMENT_MAX_BYTES),
    !definition.policy.readOnly,
    errorCode,
  );
}
