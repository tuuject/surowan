import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq, sql } from 'drizzle-orm';
import Type, { type TUnsafe } from 'typebox';
import Compile from 'typebox/compile';
import { AsyncSemaphore } from '../platform/concurrency.ts';
import type { McpServerConfig, RawConfig } from '../platform/config.ts';
import { type InvocationContext, previewContext } from '../platform/invocation-context.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { BusinessStore } from '../store/store.ts';
import { mcpServerState } from '../store/schema.ts';
import { executeMcpTool, type McpCallDeps } from './mcp-calls.ts';
import {
  CompatibleTransport,
  RECONNECT_MAX_MS,
  TOOL_NAME_PATTERN,
  limitResponseBody,
  resolveSecretRecord,
  type ManagedServer,
  type McpToolDefinition,
  type RegistryValidator,
} from './mcp-support.ts';

export class McpManager {
  readonly #store: BusinessStore;
  readonly #secrets: SecretStore;
  readonly #servers = new Map<string, ManagedServer>();
  #registryValidator: RegistryValidator | undefined;
  #stopping = false;
  readonly #callDeps: McpCallDeps;

  constructor(store: BusinessStore, config: RawConfig, secrets: SecretStore) {
    this.#store = store;
    this.#secrets = secrets;
    this.#callDeps = {
      store,
      servers: this.#servers,
      setState: (server, state, errorCode) => this.#setState(server, state, errorCode),
      scheduleReconnect: (server) => this.#scheduleReconnect(server),
    };
    for (const serverConfig of config.mcp?.servers ?? []) {
      this.#servers.set(serverConfig.alias, {
        config: serverConfig,
        semaphore: new AsyncSemaphore(1),
        definitions: [],
        client: undefined,
        generation: 0,
        reconnectAttempt: 0,
        reconnectTimer: undefined,
        stderrBytes: 0,
        state: 'stopped',
      });
    }
  }

  async start(): Promise<void> {
    this.#stopping = false;
    for (const server of this.#servers.values()) {
      try {
        await this.#connect(server, true);
      } catch (error) {
        this.#setState(server, 'degraded', 'initialization_failed');
        if (server.config.required) {
          await this.stop();
          throw new Error(
            `Required MCP server ${server.config.alias} failed to initialize: ${this.#secrets.redactError(error)}`,
          );
        }
        this.#scheduleReconnect(server);
      }
    }
  }

  setRegistryValidator(validator: RegistryValidator): void {
    validator(this.#createToolsForDefinitions(this.#allDefinitions(), previewContext(), Number.MAX_SAFE_INTEGER));
    this.#registryValidator = validator;
  }

  createTools(context: InvocationContext, invocationDeadline: number): readonly AgentTool[] {
    return this.#createToolsForDefinitions(this.#allDefinitions(), context, invocationDeadline);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const server of this.#servers.values()) {
      if (server.reconnectTimer !== undefined) {
        clearTimeout(server.reconnectTimer);
      }
      server.reconnectTimer = undefined;
      server.generation += 1;
      const client = server.client;
      server.client = undefined;
      if (client !== undefined) {
        await client.close().catch(() => undefined);
      }
      server.definitions = [];
      this.#setState(server, 'stopped', null);
    }
  }

  async #connect(server: ManagedServer, startup: boolean): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#setState(server, 'starting', null);
    const oldClient = server.client;
    server.client = undefined;
    server.generation += 1;
    const generation = server.generation;
    if (oldClient !== undefined) {
      await oldClient.close().catch(() => undefined);
    }
    const client = new Client(
      { name: 'surowan', version: '0.1.0' },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listChanged: {
          tools: {
            onChanged: () => {
              // A notification from a replaced or stopped client must not touch
              // the registry the current client owns.
              if (this.#stopping || generation !== server.generation) {
                return;
              }
              void this.#refreshTools(server).catch(() => {
                this.#setState(server, 'degraded', 'registry_update_failed');
              });
            },
          },
        },
      },
    );
    const transport = new CompatibleTransport(await this.#createTransport(server));
    client.onclose = () => {
      if (this.#stopping || generation !== server.generation) {
        return;
      }
      server.client = undefined;
      const detail =
        server.config.transport === 'stdio' ? `transport_closed_stderr_${server.stderrBytes}` : 'transport_closed';
      this.#setState(server, 'degraded', detail);
      this.#scheduleReconnect(server);
    };
    client.onerror = () => {
      if (this.#stopping || generation !== server.generation) {
        return;
      }
      this.#setState(server, 'degraded', 'transport_error');
    };
    // Every exit that does not publish this client closes it: a failed
    // discovery or validation used to leave its stdio process or HTTP session
    // running with nothing left that could find and close it.
    let published = false;
    try {
      await client.connect(transport, {
        signal: AbortSignal.timeout(30_000),
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      const listed = await client.listTools(undefined, {
        signal: AbortSignal.timeout(30_000),
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      // stop() or a newer connect may have run while this one awaited; publishing
      // now would mark a stopped server ready with a client nobody closes.
      if (this.#stopping || generation !== server.generation) {
        return;
      }
      const definitions = this.#selectTools(server.config, listed.tools);
      const previousDefinitions = server.definitions;
      server.definitions = definitions;
      try {
        this.#validateCandidateRegistry();
      } catch (error) {
        server.definitions = previousDefinitions;
        throw error;
      }
      server.client = client;
      published = true;
    } finally {
      if (!published) {
        // Its failure is reported by the caller, not as a transport close.
        client.onclose = () => undefined;
        client.onerror = () => undefined;
        await client.close().catch(() => undefined);
      }
    }
    server.reconnectAttempt = 0;
    this.#setState(server, 'ready', null);
    if (!startup) {
      this.#validateCandidateRegistry();
    }
  }

  async #refreshTools(server: ManagedServer): Promise<void> {
    const release = await server.semaphore.acquire(new AbortController().signal);
    try {
      const client = server.client;
      if (client === undefined) {
        throw new Error('MCP server is unavailable');
      }
      const listed = await client.listTools(undefined, {
        signal: AbortSignal.timeout(30_000),
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      // The client may have been replaced or stopped during discovery.
      if (this.#stopping || server.client !== client) {
        return;
      }
      const candidate = this.#selectTools(server.config, listed.tools);
      const previous = server.definitions;
      server.definitions = candidate;
      try {
        this.#validateCandidateRegistry();
      } catch (error) {
        server.definitions = previous;
        throw error;
      }
      this.#setState(server, 'ready', null);
    } finally {
      release();
    }
  }

  async #createTransport(server: ManagedServer): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
    if (server.config.transport === 'stdio') {
      const [command, ...args] = server.config.command;
      if (command === undefined) {
        throw new Error('MCP stdio command is empty');
      }
      const env = {
        ...getDefaultEnvironment(),
        ...(await resolveSecretRecord(server.config.env ?? {}, this.#secrets)),
      };
      const transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: 'pipe',
        maxBufferSize: server.config.payload_max_bytes,
      });
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        server.stderrBytes += Buffer.byteLength(chunk);
      });
      return transport;
    }
    const headers = await resolveSecretRecord(server.config.headers ?? {}, this.#secrets);
    const maxBytes = server.config.payload_max_bytes;
    const boundedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input.toString(), { ...init, redirect: 'manual' });
      if (request.body !== null) {
        const body = await request.clone().arrayBuffer();
        if (body.byteLength > maxBytes) {
          this.#setState(server, 'degraded', 'payload_limit');
          throw new Error('MCP request exceeds payload limit');
        }
      }
      const response = await fetch(request);
      if (response.status >= 300 && response.status < 400) {
        this.#setState(server, 'degraded', 'redirect_rejected');
        await response.body?.cancel();
        throw new Error('MCP HTTP redirect rejected');
      }
      return limitResponseBody(response, maxBytes, () => this.#setState(server, 'degraded', 'payload_limit'));
    };
    return new StreamableHTTPClientTransport(new URL(server.config.url), {
      requestInit: { headers, redirect: 'manual' },
      fetch: boundedFetch,
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 3,
      },
    });
  }

  #selectTools(
    server: McpServerConfig,
    listed: readonly {
      readonly name: string;
      readonly description?: string | undefined;
      readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
      readonly execution?: { readonly taskSupport?: 'optional' | 'required' | 'forbidden' | undefined } | undefined;
    }[],
  ): McpToolDefinition[] {
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
      const configuredPolicy =
        server.tool_policies?.find((policy) => policy.name === tool.name) ?? server.default_tool_policy;
      if (configuredPolicy === undefined) {
        throw new Error(`MCP tool ${exposedName} has no policy`);
      }
      const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
      const validator = Compile(parameters);
      return {
        serverAlias: server.alias,
        originalName: tool.name,
        exposedName,
        description: tool.description ?? `Call ${tool.name} on MCP server ${server.alias}`,
        parameters,
        validator,
        policy: {
          readOnly: configuredPolicy.read_only,
          timeoutMs: Math.round(configuredPolicy.timeout_seconds * 1_000),
        },
        resultMaxBytes: server.result_max_bytes,
      };
    });
  }

  #createToolsForDefinitions(
    definitions: readonly McpToolDefinition[],
    context: InvocationContext,
    invocationDeadline: number,
  ): AgentTool[] {
    return definitions.map(
      (definition): AgentTool<TUnsafe<Record<string, unknown>>, { server: string; tool: string }> => ({
        name: definition.exposedName,
        label: definition.exposedName,
        // Usage, untrusted-result, and failure rules live once in CORE_AGENT_PROTOCOL;
        // repeating them per tool cost ~420 characters for every MCP tool on every request.
        description: `MCP tool (${definition.policy.readOnly ? 'read-only' : 'side-effecting'}): ${definition.description}`,
        parameters: definition.parameters,
        executionMode: 'sequential',
        execute: async (toolCallId, input, signal) =>
          this.#executeTool(definition, context, invocationDeadline, toolCallId, input, signal),
      }),
    );
  }

  async #executeTool(
    definition: McpToolDefinition,
    context: InvocationContext,
    invocationDeadline: number,
    toolCallId: string,
    input: Record<string, unknown>,
    outerSignal?: AbortSignal,
  ): Promise<{ content: { type: 'text'; text: string }[]; details: { server: string; tool: string } }> {
    return executeMcpTool(this.#callDeps, definition, context, invocationDeadline, toolCallId, input, outerSignal);
  }

  #scheduleReconnect(server: ManagedServer): void {
    if (this.#stopping || server.reconnectTimer !== undefined) {
      return;
    }
    const attempt = server.reconnectAttempt;
    const waitMs = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(attempt, 6));
    server.reconnectAttempt += 1;
    const next = new Date(Date.now() + waitMs).toISOString();
    this.#store.orm
      .update(mcpServerState)
      .set({
        reconnectAttempt: BigInt(server.reconnectAttempt),
        nextReconnectAt: next,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpServerState.alias, server.config.alias))
      .run();
    server.reconnectTimer = setTimeout(() => {
      server.reconnectTimer = undefined;
      void (async () => {
        const reconnectSignal = AbortSignal.timeout(30_000);
        const release = await server.semaphore.acquire(reconnectSignal);
        try {
          await this.#connect(server, false);
        } catch {
          this.#setState(server, 'degraded', 'reconnect_failed');
          this.#scheduleReconnect(server);
        } finally {
          release();
        }
      })().catch(() => {
        this.#setState(server, 'degraded', 'reconnect_failed');
        this.#scheduleReconnect(server);
      });
    }, waitMs);
  }

  #validateCandidateRegistry(): void {
    const tools = this.#createToolsForDefinitions(this.#allDefinitions(), previewContext(), Number.MAX_SAFE_INTEGER);
    if (tools.length > 61) {
      throw new Error(`MCP registry has ${tools.length} tools; maximum alongside built-ins is 61`);
    }
    this.#registryValidator?.(tools);
  }

  #allDefinitions(): McpToolDefinition[] {
    return [...this.#servers.values()].flatMap((server) => server.definitions);
  }

  #setState(server: ManagedServer, state: ManagedServer['state'], errorCode: string | null): void {
    server.state = state;
    const now = new Date().toISOString();
    const hash =
      state === 'ready'
        ? createHash('sha256')
            .update(
              JSON.stringify(
                server.definitions.map((tool) => ({
                  name: tool.exposedName,
                  parameters: tool.parameters,
                  policy: tool.policy,
                })),
              ),
            )
            .digest('hex')
        : null;
    this.#store.orm.run(sql`
      INSERT INTO mcp_server_state(alias, state, registry_hash, reconnect_attempt, next_reconnect_at, error_code, updated_at)
      VALUES (${server.config.alias}, ${state}, ${hash}, ${BigInt(server.reconnectAttempt)}, NULL, ${errorCode}, ${now})
      ON CONFLICT(alias) DO UPDATE SET
        state = excluded.state,
        registry_hash = COALESCE(excluded.registry_hash, mcp_server_state.registry_hash),
        reconnect_attempt = excluded.reconnect_attempt,
        next_reconnect_at = excluded.next_reconnect_at,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `);
  }
}
