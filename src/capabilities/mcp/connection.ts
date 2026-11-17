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
  newPendingAttempt,
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
    attempt: undefined,
    generation: 0,
    reconnectAttempt: 0,
    reconnectTimer: undefined,
    stderrBytes: 0,
    payloadLimited: false,
    state: 'stopped',
    errorCode: null,
    nextReconnectAt: null,
    degradedNotified: false,
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
  const attempt = server.attempt;
  if (attempt !== undefined) {
    // An in-flight connect has no published client yet: cancel its handshake
    // and close whatever transport it already opened — otherwise a hung
    // attempt keeps its stdio child or HTTP request alive past stop().
    attempt.abort.abort(new Error('MCP server stopped'));
    if (attempt.client !== undefined) {
      await attempt.client.close().catch(() => undefined);
    }
  }
  if (client !== undefined) {
    await client.close().catch(() => undefined);
  }
  setState(state, server, 'stopped', null);
  // The attempt unwinds its own cleanup in connect's finally; stop() is done
  // only once that has run, so nothing the attempt owned outlives it.
  await attempt?.settled;
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
  // Until this attempt publishes, `server.client` stays empty — `stopServer`
  // cancels and waits on the attempt itself instead. Registered before the
  // old client's close is awaited, so a stop() landing during that close
  // still finds the attempt and waits for it.
  const attempt = newPendingAttempt();
  server.attempt = attempt;
  try {
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
                scheduleReconnect(state, server, revalidate);
              });
            },
          },
        },
      },
    );
    attempt.client = client;
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
      // A transport error that does not close the transport would otherwise
      // hide the tools forever: only `ready` servers expose any, and nothing
      // else would ever reconnect this instance.
      scheduleReconnect(state, server, revalidate);
    };
    // Every exit that does not publish this client closes it: a failed
    // discovery or validation used to leave its stdio process or HTTP session
    // running with nothing left that could find and close it.
    let published = false;
    const attemptSignal = AbortSignal.any([AbortSignal.timeout(30_000), attempt.abort.signal]);
    try {
      await client.connect(transport, {
        signal: attemptSignal,
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      const listed = await client.listTools(undefined, {
        signal: attemptSignal,
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      // stop() or a newer connect may have run while this one awaited;
      // publishing now would mark a stopped server ready with a client
      // nobody closes.
      if (state.stopping || generation !== server.generation) {
        return;
      }
      const definitions = selectTools(server, listed.tools);
      assertBindingsSatisfied(state, server.config, definitions);
      publishCandidate(server, definitions, revalidate);
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
  } finally {
    if (server.attempt === attempt) {
      server.attempt = undefined;
    }
    attempt.settle();
  }
}

/**
 * Publishes a candidate definition set in memory as `ready` so the registry
 * check — which only counts ready servers — sees it, then rolls both fields
 * back when the check fails. `setState` persists `ready` only after the check
 * has passed, so a `starting` or `degraded` server cannot slip an invalid set
 * through by being left out of its own validation.
 */
function publishCandidate(
  server: ManagedServer,
  candidate: ManagedServer['definitions'],
  revalidate: Revalidate,
): void {
  const previousDefinitions = server.definitions;
  const previousState = server.state;
  server.definitions = candidate;
  server.state = 'ready';
  try {
    revalidate();
  } catch (error) {
    server.definitions = previousDefinitions;
    server.state = previousState;
    throw error;
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
    publishCandidate(server, candidate, revalidate);
    // The refresh itself proved the connection healthy; an armed retry from
    // an earlier failure must not fire now and replace this client mid-call.
    if (server.reconnectTimer !== undefined) {
      clearTimeout(server.reconnectTimer);
      server.reconnectTimer = undefined;
    }
    server.reconnectAttempt = 0;
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
  server.nextReconnectAt = next;
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
      } catch (error) {
        // A stop() racing the attempt persisted `stopped` already; the retry
        // outcome must not overwrite it or touch a closed store.
        if (!state.stopping) {
          setState(state, server, 'degraded', 'reconnect_failed', error);
          scheduleReconnect(state, server, revalidate);
        }
      } finally {
        release();
      }
    })().catch(() => {
      if (!state.stopping) {
        setState(state, server, 'degraded', 'reconnect_failed');
        scheduleReconnect(state, server, revalidate);
      }
    });
  }, waitMs);
}

export function setState(
  state: McpState,
  server: ManagedServer,
  next: ManagedServer['state'],
  errorCode: string | null,
  detail?: unknown,
): void {
  // A stopped or replaced instance reports into the alias row only while it is
  // the published one; a late callback from an old client must not overwrite
  // the state of its replacement. During stop the only legitimate write is
  // `stopped` itself — a straggler fetch or transport callback landing after
  // `stop()` must not resurrect a row, let alone write to a closed store.
  if (state.stopping ? next !== 'stopped' : !isCurrent(state, server)) {
    return;
  }
  server.state = next;
  // A retry's `starting` keeps the failure code it is recovering from so the
  // warning stays armed and informative mid-attempt; every other state
  // records the code it was given.
  if (!(next === 'starting' && server.degradedNotified)) {
    server.errorCode = errorCode;
  }
  // `degraded` keeps the armed timer's target — an `onerror` bumping a
  // retrying server must not blank the backoff the warning page shows.
  // Anything else has no pending reconnect, so the published target clears.
  if (next !== 'degraded') {
    server.nextReconnectAt = null;
  }
  if (next === 'degraded' && !server.degradedNotified) {
    server.degradedNotified = true;
    state.log?.('mcp_server_degraded', {
      alias: server.config.alias,
      error_code: errorCode ?? 'unknown',
      // The detail helps operators fix the cause; it is redacted, and the
      // warning surface still only ever shows the code.
      ...(detail === undefined ? {} : { error: state.secrets.redactError(detail) }),
    });
  }
  if (next === 'ready' && server.degradedNotified) {
    server.degradedNotified = false;
    state.log?.('mcp_server_recovered', { alias: server.config.alias });
  }
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
    VALUES (${server.config.alias}, ${next}, ${hash}, ${BigInt(server.reconnectAttempt)}, ${server.nextReconnectAt}, ${server.errorCode}, ${now})
    ON CONFLICT(alias) DO UPDATE SET
      state = excluded.state,
      registry_hash = COALESCE(excluded.registry_hash, mcp_server_state.registry_hash),
      reconnect_attempt = excluded.reconnect_attempt,
      next_reconnect_at = excluded.next_reconnect_at,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at
  `);
}
