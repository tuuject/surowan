import { afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import type { McpServerConfig } from '../../src/platform/config/index.ts';
import { type InvocationContext, previewContext } from '../../src/platform/invocation-context.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { seedChat, seedInvocation } from '../memo/fixtures.ts';
import { testConfigJsonc, writeTestConfig, type FixtureConfig } from '../helpers.ts';

/** Temp directories this suite's helpers created; cleaned up after the file. */
export const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
export const FLAP = join(import.meta.dirname, '..', 'fixtures', 'mcp-flap.ts');
export const CHAT = 111_111_111;

export function server(alias: string, pidFile: string): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, FIXTURE, pidFile],
    tools: ['echo'],
    payload_max_bytes: 32768,
    result_max_bytes: 32768,
    tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 5 }],
  };
}

/** A `tools: '*'` flap server; `default_tool_policy` covers every discovered tool. */
export function flapServer(
  alias: string,
  directory: string,
  args: { readonly garbageAt?: number; readonly expandAt?: number; readonly handshakeDelay?: number } = {},
): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [
      process.execPath,
      FLAP,
      join(directory, `${alias}.pid`),
      String(args.garbageAt ?? 0),
      String(args.expandAt ?? 0),
      String(args.handshakeDelay ?? 0),
    ],
    tools: '*',
    payload_max_bytes: 32768,
    result_max_bytes: 32768,
    default_tool_policy: { read_only: true, timeout_seconds: 5 },
  };
}

export async function writeConfig(
  directory: string,
  transform: (config: FixtureConfig) => void,
): Promise<LoadedConfig> {
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  return await loadConfig(configPath);
}

export async function harness(transform: (config: FixtureConfig, directory: string) => void): Promise<{
  directory: string;
  store: SqliteStore;
  manager: McpManager;
  loaded: LoadedConfig;
  context: InvocationContext;
  pidOf(alias: string): Promise<number>;
  stateOf(alias: string): { state: string; reconnect_attempt: bigint } | undefined;
  toolCalls(): { tool_name: string; state: string; error_code: string | null }[];
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-availability-'));
  directories.push(directory);
  const loaded = await writeConfig(directory, (config) => {
    transform(config, directory);
    config.telegram.chats = [{ id: CHAT, instructions_file: 'chat-instructions.md' }];
  });
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore(keyJarPath(loaded.configPath)));
  const seeded = seedChat(store, BigInt(CHAT));
  const invocationId = seedInvocation(store, seeded.conversationId);
  const context: InvocationContext = {
    ...previewContext('telegram'),
    invocationId,
    conversationId: seeded.conversationId,
    chatId: BigInt(CHAT),
    internalChatId: seeded.chatId,
  };
  const pid = (alias: string) => join(directory, `${alias}.pid`);
  return {
    directory,
    store,
    manager,
    loaded,
    context,
    pidOf: async (alias) => Number(await readFile(pid(alias), 'utf8')),
    stateOf: (alias) =>
      store.db
        .prepare<[string], { state: string; reconnect_attempt: bigint }>(
          'SELECT state, reconnect_attempt FROM mcp_server_state WHERE alias = ?',
        )
        .get(alias),
    toolCalls: () =>
      store.db
        .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
          'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
    close: async () => {
      await manager.stop();
      store.close();
    },
  };
}

/** Polls until the fixture has written its own pid file. */
export async function waitForPid(path: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return Number(await readFile(path, 'utf8'));
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`No pid file at ${path}`);
      }
      await delay(50);
    }
  }
}

/** Polls the live states until `alias` leaves `expected`, for a reconnect cycle. */
export async function waitForState(
  manager: McpManager,
  alias: string,
  expected: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = manager.serverStates().find((server) => server.alias === alias)?.state;
    if (state === expected) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Server ${alias} never reached ${expected}; it is ${state}`);
    }
    await delay(50);
  }
}
