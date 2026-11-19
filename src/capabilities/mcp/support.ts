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
import type { AsyncSemaphore } from '../../platform/concurrency.ts';
import type { McpServerConfig, SecretRef } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { McpToolPolicy } from './bindings.ts';

export const ARGUMENT_MAX_BYTES = 32_768;
export const RECONNECT_MAX_MS = 60_000;
export const TRUNCATION_MARKER = '\n[tool result truncated]';
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface McpToolDefinition {
  /**
   * The instance that discovered this tool. A call goes to this instance, never
   * to whichever instance the alias publishes later: a replaced server speaks
   * its own schema and policy, and sending an old definition to the new
   * connection would silently change both.
   */
  readonly server: ManagedServer;
  readonly serverAlias: string;
  readonly originalName: string;
  readonly exposedName: string;
  readonly description: string;
  readonly parameters: TUnsafe<Record<string, unknown>>;
  readonly validator: { Check(value: unknown): value is Record<string, unknown> };
  readonly policy: McpToolPolicy;
  readonly resultMaxBytes: number;
}

/**
 * An in-flight connect/discovery before its client is published. Until the
 * attempt publishes, `server.client` is still empty, so this handle is what
 * `stopServer` aborts, closes and waits on — a pending stdio child or HTTP
 * request must never outlive the manager's stop.
 */
export interface PendingAttempt {
  /** The client being handshaken, once it exists; closing it kills its transport. */
  client: Client | undefined;
  /** Cancels the connect and discovery calls of this attempt. */
  readonly abort: AbortController;
  /** Resolves when the connect unwinds, whether it published or failed. */
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export function newPendingAttempt(): PendingAttempt {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { client: undefined, abort: new AbortController(), settled: promise, settle: resolve };
}

/** What one MCP `listTools` response carries per tool. */
export interface McpListedTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
  readonly execution?: { readonly taskSupport?: 'optional' | 'required' | 'forbidden' | undefined } | undefined;
}

/** One tool a server advertised at discovery, unfiltered by its `tools` setting. */
export interface AdvertisedMcpTool {
  readonly name: string;
  readonly description: string | null;
  /** The raw `inputSchema` JSON. Server data: untrusted, never an instruction. */
  readonly input_schema: Record<string, unknown> | null;
}

/** The per-alias advertised-tool listing the Admin Panel reads. */
export interface McpServerToolListing {
  readonly alias: string;
  readonly tools: readonly AdvertisedMcpTool[];
}

/** The advertised view of one discovery result: every name, nothing filtered. */
export function advertisedTools(listed: readonly McpListedTool[]): readonly AdvertisedMcpTool[] {
  return listed.map((tool) => ({
    name: tool.name,
    description: tool.description === undefined ? null : tool.description,
    input_schema: tool.inputSchema,
  }));
}

export interface ManagedServer {
  readonly config: McpServerConfig;
  readonly semaphore: AsyncSemaphore;
  definitions: McpToolDefinition[];
  /** Every tool the last successful discovery advertised, even unselected ones. */
  advertised: readonly AdvertisedMcpTool[];
  client: Client | undefined;
  /** The connection attempt currently running, if any — never the published client. */
  attempt: PendingAttempt | undefined;
  generation: number;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | undefined;
  stderrBytes: number;
  payloadLimited: boolean;
  state: 'starting' | 'ready' | 'degraded' | 'stopped';
  /** The code the last state write recorded; feeds the availability warning. */
  errorCode: string | null;
  /** The persisted backoff target of the pending reconnect, if any. */
  nextReconnectAt: string | null;
  /**
   * One degraded episode logs once: the event fires on the transition into
   * `degraded` and once more when it clears, never per retry.
   */
  degradedNotified: boolean;
}

/**
 * Checks one resolved tool set of one configuration. `chatIds` are the Chats of
 * `host` that resolve to it, so the caller can validate against every model
 * those Chats can run on instead of every configured model.
 */
export type RegistryValidator = (tools: readonly AgentTool[], chatIds: readonly number[], host: HostKind) => void;
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
