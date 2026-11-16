/**
 * Connection lifecycle: one alias at a time, never the whole registry.
 *
 * A server is connected, discovered, refreshed and stopped here. Every callback
 * a client installs is guarded by its generation, so a replaced or stopped
 * client can never write into the alias its replacement now owns. Definition
 * validation is injected as `revalidate`, because the cap and the model fit are
 * the manager's policy while reconnecting is this module's job.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq, sql } from 'drizzle-orm';
import { AsyncSemaphore } from '../../platform/concurrency.ts';
import type { McpServerConfig } from '../../platform/config/index.ts';
import { versionUserAgent } from '../../platform/version.ts';
import { mcpServerState } from '../../store/schema/index.ts';
import type { McpState } from './shared.ts';
import {
  CompatibleTransport,
  limitResponseBody,
  type ManagedServer,
  RECONNECT_MAX_MS,
  resolveSecretRecord,
} from './support.ts';
import { assertBindingsSatisfied, selectTools } from './tool-sets.ts';

/** The hook that re-checks the candidate registry after definitions changed. */
export type Revalidate = () => void;

export function managedServer(config: McpServerConfig): ManagedServer {
  return {
    config,
    semaphore: new AsyncSemaphore(1),
    definitions: [],
    client: undefined,
    generation: 0,
    reconnectAttempt: 0,
    reconnectTimer: undefined,
    stderrBytes: 0,
    payloadLimited: false,
    state: 'stopped',
  };
}

/** Whether one instance is still the one this alias publishes. */
export function isCurrent(state: McpState, server: ManagedServer): boolean {
  return state.servers.get(server.config.alias) === server;
}

export async function stopServer(state: McpState, server: ManagedServer): Promise<void> {
  if (server.reconnectTimer !== undefined) {
    clearTimeout(server.reconnectTimer);
  }
  server.reconnectTimer = undefined;
  server.generation += 1;
  const client = server.client;
  server.client = undefined;
  // Cleared before the close is awaited: a caller building a tool set during
  // the close must not see the old definitions under a stopped alias.
  server.definitions = [];
  if (client !== undefined) {
    await client.close().catch(() => undefined);
  }
  setState(state, server, 'stopped', null);
}

export async function connect(
  state: McpState,
  server: ManagedServer,
  startup: boolean,
  revalidate: Revalidate,
): Promise<void> {
  // A replaced instance may still have a reconnect timer firing; it must not
  // open a connection the alias no longer owns.
  if (state.stopping || !isCurrent(state, server)) {
    return;
  }
  setState(state, server, 'starting', null);
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
            if (state.stopping || generation !== server.generation) {
              return;
            }
            void refreshTools(state, server, revalidate).catch(() => {
              setState(state, server, 'degraded', 'registry_update_failed');
            });
          },
        },
      },
    },
  );
  const transport = new CompatibleTransport(await createTransport(state, server));
  client.onclose = () => {
    if (state.stopping || generation !== server.generation) {
      return;
    }
    server.client = undefined;
    const detail =
      server.config.transport === 'stdio' ? `transport_closed_stderr_${server.stderrBytes}` : 'transport_closed';
    setState(state, server, 'degraded', detail);
    scheduleReconnect(state, server, revalidate);
  };
  client.onerror = (error) => {
    if (state.stopping || generation !== server.generation) {
      return;
    }
    if (error.message.startsWith('ReadBuffer exceeded maximum size of ')) {
      server.payloadLimited = true;
    }
    setState(state, server, 'degraded', server.payloadLimited ? 'payload_limit' : 'transport_error');
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
    if (state.stopping || generation !== server.generation) {
      return;
    }
    const definitions = selectTools(server, listed.tools);
    assertBindingsSatisfied(state, server.config, definitions);
    const previousDefinitions = server.definitions;
    server.definitions = definitions;
    try {
      revalidate();
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
  setState(state, server, 'ready', null);
  if (!startup) {
    revalidate();
  }
}

async function refreshTools(state: McpState, server: ManagedServer, revalidate: Revalidate): Promise<void> {
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
    if (state.stopping || server.client !== client) {
      return;
    }
    const candidate = selectTools(server, listed.tools);
    assertBindingsSatisfied(state, server.config, candidate);
    const previous = server.definitions;
    server.definitions = candidate;
    try {
      revalidate();
    } catch (error) {
      server.definitions = previous;
      throw error;
    }
    setState(state, server, 'ready', null);
  } finally {
    release();
  }
}

async function createTransport(
  state: McpState,
  server: ManagedServer,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (server.config.transport === 'stdio') {
    const [command, ...args] = server.config.command;
    if (command === undefined) {
      throw new Error('MCP stdio command is empty');
    }
    const env = {
      ...getDefaultEnvironment(),
      ...(await resolveSecretRecord(server.config.env ?? {}, state.secrets)),
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
  const headers = await resolveSecretRecord(server.config.headers ?? {}, state.secrets);
  // A configured User-Agent overrides the default; Headers matches names case-insensitively.
  const requestHeaders = new Headers({ 'user-agent': versionUserAgent() });
  for (const [name, value] of Object.entries(headers)) {
    requestHeaders.set(name, value);
  }
  const maxBytes = server.config.payload_max_bytes;
  const boundedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input.toString(), { ...init, redirect: 'manual' });
    if (request.body !== null) {
      const body = await request.clone().arrayBuffer();
      if (body.byteLength > maxBytes) {
        setState(state, server, 'degraded', 'payload_limit');
        throw new Error('MCP request exceeds payload limit');
      }
    }
    const response = await fetch(request);
    if (response.status >= 300 && response.status < 400) {
      setState(state, server, 'degraded', 'redirect_rejected');
      await response.body?.cancel();
      throw new Error('MCP HTTP redirect rejected');
    }
    return limitResponseBody(response, maxBytes, () => {
      server.payloadLimited = true;
      setState(state, server, 'degraded', 'payload_limit');
    });
  };
  return new StreamableHTTPClientTransport(new URL(server.config.url), {
    requestInit: { headers: requestHeaders, redirect: 'manual' },
    fetch: boundedFetch,
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 3,
    },
  });
}

export function scheduleReconnect(state: McpState, server: ManagedServer, revalidate: Revalidate): void {
  // A replaced or removed instance must not open a second connection nobody
  // owns; the alias belongs to whichever instance the map publishes now.
  if (state.stopping || !isCurrent(state, server) || server.reconnectTimer !== undefined) {
    return;
  }
  const attempt = server.reconnectAttempt;
  const waitMs = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(attempt, 6));
  server.reconnectAttempt += 1;
  const next = new Date(Date.now() + waitMs).toISOString();
  state.store.orm
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
        await connect(state, server, false, revalidate);
      } catch {
        setState(state, server, 'degraded', 'reconnect_failed');
        scheduleReconnect(state, server, revalidate);
      } finally {
        release();
      }
    })().catch(() => {
      setState(state, server, 'degraded', 'reconnect_failed');
      scheduleReconnect(state, server, revalidate);
    });
  }, waitMs);
}

export function setState(
  state: McpState,
  server: ManagedServer,
  next: ManagedServer['state'],
  errorCode: string | null,
): void {
  // A stopped or replaced instance reports into the alias row only while it is
  // the published one; a late callback from an old client must not overwrite
  // the state of its replacement.
  if (!state.stopping && !isCurrent(state, server)) {
    return;
  }
  server.state = next;
  const now = new Date().toISOString();
  const hash =
    next === 'ready'
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
  state.store.orm.run(sql`
    INSERT INTO mcp_server_state(alias, state, registry_hash, reconnect_attempt, next_reconnect_at, error_code, updated_at)
    VALUES (${server.config.alias}, ${next}, ${hash}, ${BigInt(server.reconnectAttempt)}, NULL, ${errorCode}, ${now})
    ON CONFLICT(alias) DO UPDATE SET
      state = excluded.state,
      registry_hash = COALESCE(excluded.registry_hash, mcp_server_state.registry_hash),
      reconnect_attempt = excluded.reconnect_attempt,
      next_reconnect_at = excluded.next_reconnect_at,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at
  `);
}
