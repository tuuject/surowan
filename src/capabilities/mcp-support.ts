import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolResult,
  type CompatibilityCallToolResult,
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import type { TUnsafe } from 'typebox';
import type { AsyncSemaphore } from '../platform/concurrency.ts';
import type { McpServerConfig, SecretRef } from '../platform/config.ts';
import type { SecretStore } from '../platform/secrets.ts';

export const ARGUMENT_MAX_BYTES = 32_768;
export const RECONNECT_MAX_MS = 60_000;
export const TRUNCATION_MARKER = '\n[tool result truncated]';
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ToolPolicy {
  readonly readOnly: boolean;
  readonly timeoutMs: number;
}

export interface McpToolDefinition {
  readonly serverAlias: string;
  readonly originalName: string;
  readonly exposedName: string;
  readonly description: string;
  readonly parameters: TUnsafe<Record<string, unknown>>;
  readonly validator: { Check(value: unknown): value is Record<string, unknown> };
  readonly policy: ToolPolicy;
  readonly resultMaxBytes: number;
}

export interface ManagedServer {
  readonly config: McpServerConfig;
  readonly semaphore: AsyncSemaphore;
  definitions: McpToolDefinition[];
  client: Client | undefined;
  generation: number;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | undefined;
  stderrBytes: number;
  state: 'starting' | 'ready' | 'degraded' | 'stopped';
}

export type RegistryValidator = (tools: readonly AgentTool[]) => void;
export type McpCallResult = CallToolResult | CompatibilityCallToolResult;

export class CompatibleTransport implements Transport {
  readonly #inner: StdioClientTransport | StreamableHTTPClientTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: StdioClientTransport | StreamableHTTPClientTransport) {
    this.#inner = inner;
  }

  async start(): Promise<void> {
    this.#inner.onclose = () => this.onclose?.();
    this.#inner.onerror = (error) => this.onerror?.(error);
    this.#inner.onmessage = (message) => this.onmessage?.(message);
    await this.#inner.start();
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.#inner instanceof StdioClientTransport) {
      await this.#inner.send(message);
      return;
    }
    const httpOptions =
      options === undefined
        ? undefined
        : {
            ...(options.resumptionToken === undefined ? {} : { resumptionToken: options.resumptionToken }),
            ...(options.onresumptiontoken === undefined ? {} : { onresumptiontoken: options.onresumptiontoken }),
          };
    await this.#inner.send(message, httpOptions);
  }

  setProtocolVersion(version: string): void {
    if (this.#inner instanceof StreamableHTTPClientTransport) {
      this.#inner.setProtocolVersion(version);
    }
  }
}

export class KnownToolError extends Error {}

export async function resolveSecretRecord(
  record: Readonly<Record<string, SecretRef>>,
  secrets: SecretStore,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(record)) {
    resolved[name] = await secrets.resolve(reference);
  }
  return resolved;
}

export function limitResponseBody(response: Response, maxBytes: number, onLimit: () => void): Response {
  if (response.body === null) {
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await reader.read();
      if (item.done) {
        controller.close();
        return;
      }
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        onLimit();
        await reader.cancel();
        controller.error(new Error('MCP response exceeds payload limit'));
        return;
      }
      controller.enqueue(item.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function isTransient(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 429 || error.code === 502 || error.code === 503 || error.code === 504;
  }
  return (
    error instanceof McpError && (error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout)
  );
}

export function classifyMcpError(error: unknown): string {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.ConnectionClosed) {
      return 'connection_closed';
    }
    if (error.code === ErrorCode.RequestTimeout) {
      return 'timeout';
    }
    return `mcp_${error.code}`;
  }
  if (error instanceof StreamableHTTPError) {
    return error.code === undefined ? 'http_error' : `http_${error.code}`;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'timeout';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'aborted';
  }
  return 'transport_error';
}
