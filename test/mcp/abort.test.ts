import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { renderInvocationContext, sleep, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function harness(
  prefix: string,
  policies: { name: string; read_only: boolean; timeout_seconds: number }[],
): Promise<{
  store: SqliteStore;
  manager: McpManager;
  tools: (name: string) => { execute: (...args: unknown[]) => Promise<McpLikeResult> };
  serverState: () => { state: string; reconnect_attempt: bigint; next_reconnect_at: string | null } | undefined;
  toolCalls: () => { tool_name: string; state: string }[];
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.mcp = {
      servers: [
        {
          alias: 'local',
          transport: 'stdio',
          command: [process.execPath, fixturePath],
          tools: policies.map((policy) => policy.name),
          payload_max_bytes: 1048576,
          result_max_bytes: 32768,
          tool_policies: policies,
        },
      ],
    };
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore(keychainPath(loaded.configPath)));
  await manager.start();
  await awaitServerAttempts(manager);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'go',
    },
  };
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  const byName = new Map(
    manager.createTools(context, Date.now() + 60_000, loaded.config).map((tool) => [tool.name, tool]),
  );
  return {
    store,
    manager,
    tools: (name) => {
      const tool = byName.get(name);
      if (tool === undefined) {
        throw new Error(`Missing MCP tool ${name}`);
      }
      return tool as unknown as { execute: (...args: unknown[]) => Promise<McpLikeResult> };
    },
    serverState: () =>
      store.db
        .prepare<[], { state: string; reconnect_attempt: bigint; next_reconnect_at: string | null }>(
          "SELECT state, reconnect_attempt, next_reconnect_at FROM mcp_server_state WHERE alias = 'local'",
        )
        .get(),
    toolCalls: () =>
      store.db
        .prepare<[], { tool_name: string; state: string }>('SELECT tool_name, state FROM tool_calls ORDER BY id')
        .all(),
  };
}

interface McpLikeResult {
  readonly content: readonly { type: string; text?: string }[];
}

/**
 * A caller abort is the agent run being stopped, not a broken server: the server
 * may already have executed the call (so the audit row stays `outcome_unknown`),
 * but the connection is still healthy and other conversations keep using it.
 * Degrading it here would respawn the stdio process under every other in-flight
 * call on the same server.
 */
test('a caller abort leaves the server ready, does not reconnect, and keeps the same process', async () => {
  const h = await harness('surowan-mcp-abort-', [
    { name: 'echo', read_only: true, timeout_seconds: 5 },
    { name: 'wait', read_only: false, timeout_seconds: 30 },
  ]);
  try {
    const echo = h.tools('local__echo');
    const wait = h.tools('local__wait');
    // The fixture counts calls per process, so a respawn restarts at 1.
    expect(textOf(await echo.execute('mcp-before', { text: 'one' }))).toBe('1:one');

    const controller = new AbortController();
    const pending = wait.execute('mcp-abort', { ms: 5_000 }, controller.signal);
    await sleep(200);
    controller.abort(new Error('invocation_aborted'));
    await expect(pending).rejects.toThrow();
    // Give a wrongly scheduled reconnect its chance to be observed.
    await sleep(50);

    expect(h.toolCalls()).toEqual([
      { tool_name: 'local__echo', state: 'success' },
      { tool_name: 'local__wait', state: 'outcome_unknown' },
    ]);
    expect(h.serverState()).toEqual({ state: 'ready', reconnect_attempt: 0n, next_reconnect_at: null });
    // The same stdio process answers: a reconnect starts a new one whose call
    // counter is 1 again.
    expect(textOf(await echo.execute('mcp-after', { text: 'two' }))).toBe('2:two');
  } finally {
    await h.manager.stop();
    h.store.close();
  }
}, 30_000);

/** This call's own timeout is a transport failure and still tears the server down. */
test('a per-call timeout still degrades the server and schedules a reconnect', async () => {
  const h = await harness('surowan-mcp-call-timeout-', [{ name: 'wait', read_only: false, timeout_seconds: 0.1 }]);
  try {
    await expect(h.tools('local__wait').execute('mcp-timeout', { ms: 2_000 })).rejects.toThrow('timeout');
    expect(h.toolCalls()).toEqual([{ tool_name: 'local__wait', state: 'outcome_unknown' }]);
    expect(h.serverState()).toMatchObject({ state: 'degraded', reconnect_attempt: 1n });
  } finally {
    await h.manager.stop();
    h.store.close();
  }
}, 30_000);

function textOf(result: McpLikeResult): string {
  const text = result.content.find((entry) => entry.type === 'text');
  if (text === undefined || text.text === undefined) {
    throw new Error('MCP result omitted text');
  }
  // A text-only MCP answer keeps its historical JSON envelope.
  if (!text.text.startsWith('{"content"')) {
    return text.text;
  }
  const envelope = JSON.parse(text.text) as { content: { type: string; text?: string }[] };
  const inner = envelope.content.find((entry) => entry.type === 'text');
  if (inner === undefined || inner.text === undefined) {
    throw new Error('MCP envelope omitted text');
  }
  return inner.text;
}
