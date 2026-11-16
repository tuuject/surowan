import { setTimeout as delay } from 'node:timers/promises';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { InvocationContext } from '../../platform/invocation-context.ts';
import { safeJson } from '../../platform/truncate.ts';
import type { BusinessStore } from '../../store/store.ts';
import { finishToolCall, rejectToolCall, startToolCall } from '../../store/store.ts';
import type { PlaygroundAssetStore } from '../media/local-assets.ts';
import { convertMcpResult, type McpToolResult } from './content.ts';
import {
  ARGUMENT_MAX_BYTES,
  classifyMcpError,
  isTransient,
  type ManagedServer,
  type McpCallResult,
  type McpToolDefinition,
} from './support.ts';

export interface McpCallDeps {
  readonly store: BusinessStore;
  readonly assets: PlaygroundAssetStore;
  /** Whether one instance is still the one its alias publishes. */
  isCurrent(server: ManagedServer): boolean;
  setState(server: ManagedServer, state: ManagedServer['state'], errorCode: string | null, detail?: unknown): void;
  scheduleReconnect(server: ManagedServer): void;
}

/**
 * The instance had no live client when a call tried to send, so no request
 * left this process. The executor maps it to an audited `server_unavailable`
 * refusal rather than the transport-failure path, whose `outcome_unknown`
 * audit assumes a request may already have been sent.
 */
class McpTransportUnavailableError extends Error {}

export async function executeMcpTool(
  deps: McpCallDeps,
  definition: McpToolDefinition,
  context: InvocationContext,
  invocationDeadline: number,
  toolCallId: string,
  input: Record<string, unknown>,
  outerSignal?: AbortSignal,
): Promise<McpToolResult> {
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
  // A call goes to the instance that handed out this definition. A stopped or
  // replaced instance may still be held by a run that outlived its fence; that
  // run must get a clean refusal instead of sending an old schema or policy to
  // the connection its alias now publishes.
  const server = definition.server;
  if (!deps.isCurrent(server)) {
    recordRejectedCall(deps.store, context.invocationId, toolCallId, definition, input, 'server_replaced');
    throw new Error(`MCP server ${definition.serverAlias} was replaced; call ${definition.originalName} again`);
  }
  if (server.state !== 'ready' || server.client === undefined) {
    // A definite refusal like `server_replaced`: nothing was sent, so the
    // audit is `error`, not `outcome_unknown`, and the refusal itself must
    // not degrade or re-arm a server that is already retrying.
    recordRejectedCall(deps.store, context.invocationId, toolCallId, definition, input, 'server_unavailable');
    throw new Error(`MCP server ${definition.serverAlias} is unavailable; call ${definition.originalName} again later`);
  }
  const auditId = startToolCall(
    deps.store.orm,
    context.invocationId,
    toolCallId,
    definition.exposedName,
    argumentsJson,
    !definition.policy.readOnly,
  );
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
  let received = false;
  try {
    const timeoutMs = Math.max(1, Math.min(definition.policy.timeoutMs, invocationDeadline - Date.now()));
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (outerSignal !== undefined) {
      signals.push(outerSignal);
    }
    const signal = AbortSignal.any(signals);
    let result: McpCallResult;
    server.payloadLimited = false;
    try {
      result = await callMcpTool(server, definition, input, signal, timeoutMs);
    } catch (error) {
      if (server.payloadLimited || !definition.policy.readOnly || !isTransient(error) || signal.aborted) {
        throw error;
      }
      await delay(100, undefined, { signal });
      try {
        result = await callMcpTool(server, definition, input, signal, timeoutMs);
      } catch (retryError) {
        // The first attempt already put a request on the wire: a retry that
        // finds no client must not rewrite the audit into the definite
        // `server_unavailable` refusal, so it keeps the sent attempt's class.
        throw retryError instanceof McpTransportUnavailableError ? error : retryError;
      }
    }
    received = true;
    const converted = await convertMcpResult(result, definition, context, deps.assets, signal);
    const text = converted.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    finishToolCall(
      deps.store.orm,
      auditId,
      converted.isError ? 'error' : 'success',
      text,
      converted.isError ? 'mcp_tool_error' : null,
      {
        startedAt,
        pendingOnly: true,
        resultContentJson: JSON.stringify(converted),
      },
    );
    return converted;
  } catch (error) {
    if (received) {
      finishToolCall(deps.store.orm, auditId, 'error', null, 'mcp_result_processing_failed', {
        startedAt,
        pendingOnly: true,
      });
      throw new Error('MCP tool executed, but its result could not be processed; do not repeat side effects');
    }
    if (error instanceof McpTransportUnavailableError) {
      // The server dropped while this call waited on the semaphore (or lost
      // its client between the pre-check and the send): the same definite
      // refusal as the pre-check, not a transport failure.
      finishToolCall(deps.store.orm, auditId, 'error', null, 'server_unavailable', {
        startedAt,
        pendingOnly: true,
      });
      throw new Error(
        `MCP server ${definition.serverAlias} is unavailable; call ${definition.originalName} again later`,
      );
    }
    const known =
      error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout;
    const state = known ? 'error' : 'outcome_unknown';
    const errorCode = server.payloadLimited ? 'payload_limit' : classifyMcpError(error);
    finishToolCall(deps.store.orm, auditId, state, null, errorCode, {
      startedAt,
      pendingOnly: true,
    });
    // The caller's own run was aborted (a cutover, an admin cancel, the model
    // switch). The SDK rejects the request with the abort signal's own reason,
    // but the server may already have executed the call, so the audit stays
    // `outcome_unknown`.
    // Degrading here would drop and respawn the connection under every other
    // conversation's in-flight call on the same server, so only a real
    // transport failure or this call's own timeout tears it down.
    const callerAborted = outerSignal?.aborted === true;
    if (!known && !callerAborted) {
      deps.setState(server, 'degraded', errorCode, error);
      deps.scheduleReconnect(server);
    }
    throw new Error(`MCP tool ${definition.exposedName} failed: ${errorCode}`);
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
    throw new McpTransportUnavailableError('MCP transport is unavailable');
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
