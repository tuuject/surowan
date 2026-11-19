import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import type { McpServerReconcileResult } from '../../src/capabilities/mcp/shared.ts';
import type { McpServerConfig, RawConfig } from '../../src/platform/config/index.ts';
import { type InvocationContext, previewContext } from '../../src/platform/invocation-context.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from '../helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
const CHAT_A = 111_111_111;
const CHAT_B = 222_222_222;
const CHAT_ANY = -100_333_333_333;

function contextFor(chatId: bigint): InvocationContext {
  return { ...previewContext('telegram'), hostChatId: chatId, internalChatId: chatId };
}

function server(alias: string, pidFile: string): McpServerConfig {
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

async function writeConfig(
  directory: string,
  name: string,
  transform: (config: FixtureConfig) => void,
): Promise<LoadedConfig> {
  const configPath = join(directory, name);
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  return await loadConfig(configPath);
}

async function fixture(): Promise<{
  directory: string;
  store: SqliteStore;
  manager: McpManager;
  loaded: LoadedConfig;
  next(name: string, transform: (config: FixtureConfig) => void): Promise<LoadedConfig>;
  reconcile(config: RawConfig): Promise<McpServerReconcileResult>;
  pidOf(alias: string): Promise<number>;
  stateOf(alias: string): { state: string; reconnect_attempt: bigint } | undefined;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-reconcile-'));
  directories.push(directory);
  const pid = (alias: string) => join(directory, `${alias}.pid`);
  const loaded = await writeConfig(directory, 'config.jsonc', (config) => {
    config.mcp = { servers: [server('alpha', pid('alpha')), server('beta', pid('beta'))] };
    config.telegram.chats = [
      { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
      { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
    ];
  });
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore(keychainPath(loaded.configPath)));
  let generation = 1;
  return {
    directory,
    store,
    manager,
    loaded,
    next: (name, transform) => writeConfig(directory, name, transform),
    reconcile: (config) => {
      generation += 1;
      return manager.reconcile({ config, generation });
    },
    pidOf: async (alias) => Number(await readFile(pid(alias), 'utf8')),
    stateOf: (alias) =>
      store.db
        .prepare<[string], { state: string; reconnect_attempt: bigint }>(
          'SELECT state, reconnect_attempt FROM mcp_server_state WHERE alias = ?',
        )
        .get(alias),
    close: async () => {
      await manager.stop();
      store.close();
    },
  };
}

test('a changed alias alone is replaced; the others keep their process', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const alphaPid = await f.pidOf('alpha');
    const betaPid = await f.pidOf('beta');
    const next = await f.next('changed.jsonc', (config) => {
      config.mcp = {
        servers: [server('alpha', join(f.directory, 'alpha.pid')), server('beta', join(f.directory, 'beta.pid'))],
      };
      config.mcp.servers[0]!.result_max_bytes = 4096;
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
      ];
    });
    const result = await f.reconcile(next.config);
    expect(result).toEqual({ added: [], replaced: ['alpha'], removed: [], failed: [], stale: false });
    expect(await f.pidOf('alpha')).not.toBe(alphaPid);
    expect(await f.pidOf('beta')).toBe(betaPid);
    expect(f.stateOf('alpha')).toMatchObject({ state: 'ready' });
    expect(f.stateOf('beta')).toMatchObject({ state: 'ready' });
  } finally {
    await f.close();
  }
}, 30_000);

test('a removed server is stopped on its own and disappears from the Chat that bound it', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const next = await f.next('removed.jsonc', (config) => {
      config.mcp = { servers: [server('alpha', join(f.directory, 'alpha.pid'))] };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [] },
      ];
    });
    const result = await f.reconcile(next.config);
    expect(result).toEqual({ added: [], replaced: [], removed: ['beta'], failed: [], stale: false });
    expect(f.stateOf('beta')?.state).toBe('stopped');
    expect(f.manager.toolNamesForChat({ hostKind: 'telegram', hostChatId: BigInt(CHAT_B) }, next.config)).toEqual([]);
    expect(f.manager.toolNamesForChat({ hostKind: 'telegram', hostChatId: BigInt(CHAT_A) }, next.config)).toEqual([
      'alpha__echo',
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test('an added server connects and reaches the Chats that resolve to it', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const next = await f.next('added.jsonc', (config) => {
      config.mcp = {
        servers: [
          server('alpha', join(f.directory, 'alpha.pid')),
          server('beta', join(f.directory, 'beta.pid')),
          server('gamma', join(f.directory, 'gamma.pid')),
        ],
      };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
        { id: CHAT_ANY, instructions_file: 'chat-instructions.md' },
      ];
    });
    expect(await f.reconcile(next.config)).toEqual({
      added: ['gamma'],
      replaced: [],
      removed: [],
      failed: [],
      stale: false,
    });
    expect(f.stateOf('gamma')?.state).toBe('ready');
    // A Chat without a binding reaches every server, including the new one.
    expect(f.manager.toolNamesForChat({ hostKind: 'telegram', hostChatId: BigInt(CHAT_ANY) }, next.config)).toEqual([
      'alpha__echo',
      'beta__echo',
      'gamma__echo',
    ]);
    expect(f.manager.createTools(contextFor(BigInt(CHAT_ANY)), Date.now() + 30_000, next.config)).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 30_000);

test('a hot-changed server that cannot start is degraded and retried, not fatal', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const next = await f.next('broken.jsonc', (config) => {
      config.mcp = {
        servers: [
          {
            alias: 'alpha',
            transport: 'stdio',
            command: [process.execPath, join(f.directory, 'missing-server.ts')],
            tools: ['echo'],
            payload_max_bytes: 32768,
            result_max_bytes: 32768,
            tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 5 }],
          },
          server('beta', join(f.directory, 'beta.pid')),
        ],
      };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
      ];
    });
    const result = await f.reconcile(next.config);
    expect(result.replaced).toEqual(['alpha']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.alias).toBe('alpha');
    // The report carries the redacted failure so the reload log can name it.
    expect(result.failed[0]?.error).toMatch(/Connection closed|missing-server/);
    expect(f.stateOf('alpha')).toMatchObject({ state: 'degraded', reconnect_attempt: 1n });
    expect(f.stateOf('beta')?.state).toBe('ready');
  } finally {
    await f.close();
  }
}, 30_000);

test('a reconcile that belongs to an older published generation changes nothing', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const next = await f.next('newer.jsonc', (config) => {
      config.mcp = { servers: [server('alpha', join(f.directory, 'alpha.pid'))] };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [] },
      ];
    });
    const newer = await f.manager.reconcile({ config: next.config, generation: 5 });
    expect(newer).toMatchObject({ removed: ['beta'], stale: false });
    expect(f.stateOf('beta')?.state).toBe('stopped');

    // A handed-off cutover finishing now must not roll the instances back.
    const stale = await f.manager.reconcile({ config: f.loaded.config, generation: 4 });
    expect(stale).toEqual({ added: [], replaced: [], removed: [], failed: [], stale: true });
    expect(f.stateOf('beta')?.state).toBe('stopped');
    expect(f.stateOf('alpha')?.state).toBe('ready');
  } finally {
    await f.close();
  }
}, 30_000);

test('flipping the deprecated required key alone is a no-op: same process, same tools', async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const alphaPid = await f.pidOf('alpha');
    const next = await f.next('required.jsonc', (config) => {
      config.mcp = {
        servers: [
          { ...server('alpha', join(f.directory, 'alpha.pid')), required: true },
          { ...server('beta', join(f.directory, 'beta.pid')), required: false },
        ],
      };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
      ];
    });
    // The config loads with the deprecated key and still warns about it.
    const result = await f.reconcile(next.config);
    expect(result).toEqual({ added: [], replaced: [], removed: [], failed: [], stale: false });
    expect(await f.pidOf('alpha')).toBe(alphaPid);
    expect(f.stateOf('alpha')?.state).toBe('ready');
    expect(f.manager.toolNamesForChat({ hostKind: 'telegram', hostChatId: BigInt(CHAT_A) }, next.config)).toEqual([
      'alpha__echo',
    ]);
    expect(f.manager.createTools(contextFor(BigInt(CHAT_A)), Date.now() + 30_000, next.config)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30_000);
