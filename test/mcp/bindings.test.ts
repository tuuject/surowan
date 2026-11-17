import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, RawConfig } from '../../src/platform/config/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { awaitServerAttempts } from '../../src/capabilities/mcp/availability.ts';
import { type InvocationContext, previewContext } from '../../src/platform/invocation-context.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import { buildModelRegistry, configuredAgentModels, modelsForTelegramChats } from '../../src/platform/providers.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { testConfigJsonc, writeTestConfig, type FixtureConfig } from '../helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const CHAT_BOUND = 111_111_111;
const CHAT_NONE = 222_222_222;
const CHAT_ALL = -100_333_333_333;
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.ts');
const BULK = join(import.meta.dirname, '..', 'fixtures', 'mcp-bulk-server.ts');

/** The fixture server's two tools, each with an explicit policy. */
function fixtureServer(alias: string): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, FIXTURE],
    tools: ['echo', 'wait'],
    payload_max_bytes: 32768,
    result_max_bytes: 32768,
    tool_policies: [
      { name: 'echo', read_only: true, timeout_seconds: 5 },
      { name: 'wait', read_only: false, timeout_seconds: 30 },
    ],
  };
}

/** A wildcard server with 40 discovered tools and one default policy. */
function bulkServer(alias: string): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, BULK, '40'],
    tools: '*',
    payload_max_bytes: 32768,
    result_max_bytes: 32768,
    default_tool_policy: { read_only: true, timeout_seconds: 5 },
  };
}

interface Harness {
  readonly manager: McpManager;
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly models: Awaited<ReturnType<typeof buildModelRegistry>>['models'];
  close(): Promise<void>;
}

async function harness(transform: (config: FixtureConfig) => void): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-bindings-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [];
      transform(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keychainPath(loaded.configPath));
  const manager = new McpManager(store, loaded.config, secrets);
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  return {
    manager,
    store,
    config: loaded.config,
    models: registry.models,
    close: async () => {
      await manager.stop();
      store.close();
    },
  };
}

function contextFor(chatId: bigint): InvocationContext {
  return { ...previewContext('telegram'), chatId };
}

test('a Chat sees only its bound servers, tools and policies; no binding means every server', async () => {
  const f = await harness((config) => {
    config.mcp = { servers: [fixtureServer('alpha'), fixtureServer('beta')] };
    config.telegram.chats = [
      {
        id: CHAT_BOUND,
        instructions_file: 'chat-instructions.md',
        mcp: [
          {
            server: 'alpha',
            tools: ['wait'],
            // A binding may restrict a tool further than its server does.
            tool_policies: [{ name: 'wait', read_only: true, timeout_seconds: 1 }],
          },
        ],
      },
      { id: CHAT_NONE, instructions_file: 'chat-instructions.md', mcp: [] },
      { id: CHAT_ALL, instructions_file: 'chat-instructions.md' },
    ];
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const bound = f.manager.createTools(contextFor(BigInt(CHAT_BOUND)), Date.now() + 30_000, f.config);
    expect(bound.map((tool) => tool.name)).toEqual(['alpha__wait']);
    // The Chat's override wins over the server's `read_only: false`.
    expect(bound[0]?.description).toContain('MCP tool (read-only)');
    expect(f.manager.createTools(contextFor(BigInt(CHAT_NONE)), Date.now() + 30_000, f.config)).toEqual([]);
    expect(
      f.manager.createTools(contextFor(BigInt(CHAT_ALL)), Date.now() + 30_000, f.config).map((tool) => tool.name),
    ).toEqual(['alpha__echo', 'alpha__wait', 'beta__echo', 'beta__wait']);
    // A Playground room never inherits MCP, whatever is configured.
    expect(f.manager.createTools(previewContext('playground'), Date.now() + 30_000, f.config)).toEqual([]);
    // `mcp_server_state` stays keyed by alias.
    expect(
      f.store.db
        .prepare<[], { alias: string; state: string }>('SELECT alias, state FROM mcp_server_state ORDER BY alias')
        .all(),
    ).toEqual([
      { alias: 'alpha', state: 'ready' },
      { alias: 'beta', state: 'ready' },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test('registry validation runs over each distinct per-Chat set, not the union', async () => {
  const f = await harness((config) => {
    config.mcp = { servers: [fixtureServer('alpha'), fixtureServer('beta')] };
    config.telegram.chats = [
      { id: CHAT_BOUND, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha', tools: ['echo'] }] },
      { id: CHAT_ALL, instructions_file: 'chat-instructions.md' },
    ];
  });
  try {
    const seen: { names: string[]; chatIds: number[] }[] = [];
    f.manager.setRegistryValidator((tools, chatIds) => {
      seen.push({ names: tools.map((tool) => tool.name), chatIds: [...chatIds] });
    });
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    expect(seen).toEqual(
      expect.arrayContaining([
        { names: ['alpha__echo'], chatIds: [CHAT_BOUND] },
        { names: ['alpha__echo', 'alpha__wait', 'beta__echo', 'beta__wait'], chatIds: [CHAT_ALL] },
      ]),
    );
  } finally {
    await f.close();
  }
}, 30_000);

test('the 61-tool cap is per resolved set: two 40-tool servers are fine when no Chat reaches both', async () => {
  const bound = await harness((config) => {
    config.mcp = { servers: [bulkServer('bulk-a'), bulkServer('bulk-b')] };
    config.telegram.chats = [
      { id: CHAT_BOUND, instructions_file: 'chat-instructions.md', mcp: [{ server: 'bulk-a' }] },
      { id: CHAT_NONE, instructions_file: 'chat-instructions.md', mcp: [{ server: 'bulk-b' }] },
    ];
  });
  try {
    await bound.manager.start();
    await awaitServerAttempts(bound.manager);
    expect(bound.manager.createTools(contextFor(BigInt(CHAT_BOUND)), Date.now() + 30_000, bound.config)).toHaveLength(
      40,
    );
  } finally {
    await bound.close();
  }

  const unbound = await harness((config) => {
    config.mcp = { servers: [bulkServer('bulk-a'), bulkServer('bulk-b')] };
    config.telegram.chats = [
      { id: CHAT_BOUND, instructions_file: 'chat-instructions.md', mcp: [{ server: 'bulk-a' }] },
      // No binding: this Chat reaches both servers, so the union has to fit.
      { id: CHAT_ALL, instructions_file: 'chat-instructions.md' },
    ];
  });
  try {
    // The 80-tool union fails validation on whichever server discovers second;
    // with no `required` left that failure degrades the server instead of
    // failing `start`.
    await unbound.manager.start();
    const states = await awaitServerAttempts(unbound.manager);
    expect(states.some((server) => server.state === 'degraded')).toBe(true);
    expect(
      unbound.store.db
        .prepare<[], { state: string; error_code: string }>(
          "SELECT state, error_code FROM mcp_server_state WHERE state = 'degraded'",
        )
        .all()
        .map((row) => row.error_code),
    ).toEqual(['initialization_failed']);
  } finally {
    await unbound.close();
  }
}, 30_000);

test('a binding that names tools on a wildcard server is checked against discovery', async () => {
  const f = await harness((config) => {
    config.mcp = {
      servers: [
        {
          alias: 'alpha',
          transport: 'stdio',
          command: [process.execPath, FIXTURE],
          tools: '*',
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          default_tool_policy: { read_only: true, timeout_seconds: 5 },
        },
      ],
    };
    config.telegram.chats = [
      {
        id: CHAT_BOUND,
        instructions_file: 'chat-instructions.md',
        mcp: [{ server: 'alpha', tools: ['echo', 'absent'] }],
      },
    ];
  });
  try {
    await f.manager.start();
    expect((await awaitServerAttempts(f.manager))[0]?.state).toBe('degraded');
    expect(
      f.store.db.prepare<[], { state: string }>("SELECT state FROM mcp_server_state WHERE alias = 'alpha'").get()
        ?.state,
    ).toBe('degraded');
  } finally {
    await f.close();
  }
}, 30_000);

test('a reload that only changes a binding rejects a tool the connected wildcard server does not expose', async () => {
  const f = await harness((config) => {
    config.mcp = {
      servers: [
        {
          alias: 'alpha',
          transport: 'stdio',
          command: [process.execPath, FIXTURE],
          tools: '*',
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          default_tool_policy: { read_only: true, timeout_seconds: 5 },
        },
      ],
    };
    config.telegram.chats = [
      { id: CHAT_BOUND, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha', tools: ['echo'] }] },
    ];
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    // The server is unchanged, so `reconcile` will not reconnect it; the
    // binding is checked against what it discovered instead of never.
    const next = structuredClone(f.config);
    next.telegram.chats[0]!.mcp = [{ server: 'alpha', tools: ['echo', 'absent'] }];
    expect(() => f.manager.toolSets(next)).toThrow(
      `MCP server alpha is missing tool absent, which chat ${CHAT_BOUND} binds`,
    );
    // The unchanged configuration still resolves its discovered tool.
    expect(f.manager.toolSets(f.config).map((set) => set.tools.map((tool) => tool.name))).toEqual([['alpha__echo']]);
  } finally {
    await f.close();
  }
}, 30_000);

test('a wildcard binding whose override names an undiscovered tool fails the connection', async () => {
  const f = await harness((config) => {
    config.mcp = {
      servers: [
        {
          alias: 'alpha',
          transport: 'stdio',
          command: [process.execPath, FIXTURE],
          tools: '*',
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          default_tool_policy: { read_only: true, timeout_seconds: 5 },
        },
      ],
    };
    config.telegram.chats = [
      {
        id: CHAT_BOUND,
        instructions_file: 'chat-instructions.md',
        mcp: [
          {
            server: 'alpha',
            tools: '*',
            tool_policies: [{ name: 'qurey', read_only: true, timeout_seconds: 5 }],
          },
        ],
      },
    ];
  });
  try {
    await f.manager.start();
    expect((await awaitServerAttempts(f.manager))[0]?.state).toBe('degraded');
    expect(
      f.store.db
        .prepare<[], { error_code: string }>("SELECT error_code FROM mcp_server_state WHERE alias = 'alpha'")
        .get()?.error_code,
    ).toBe('initialization_failed');
  } finally {
    await f.close();
  }
}, 30_000);

test('a per-chat MCP set is validated against the models its own Chats can run on', async () => {
  const f = await harness((config) => {
    config.mcp = { servers: [fixtureServer('alpha')] };
    config.telegram.chats = [
      // This Chat runs on the vision-side model through its override.
      {
        id: CHAT_BOUND,
        instructions_file: 'chat-instructions.md',
        provider: 'vision',
        model: 'vision-model',
        thinking_level: 'off',
        mcp: [{ server: 'alpha' }],
      },
      { id: CHAT_ALL, instructions_file: 'chat-instructions.md' },
    ];
  });
  try {
    const configured = configuredAgentModels(f.config, f.models).map((entry) => entry.model);
    expect(configured.map((model) => model.id).sort()).toEqual(['agent-model', 'vision-model']);
    expect(modelsForTelegramChats(f.config, configured, [CHAT_BOUND]).map((model) => model.id)).toEqual([
      'vision-model',
    ]);
    expect(modelsForTelegramChats(f.config, configured, [CHAT_ALL]).map((model) => model.id)).toEqual(['agent-model']);
    expect(
      modelsForTelegramChats(f.config, configured, [CHAT_BOUND, CHAT_ALL])
        .map((model) => model.id)
        .sort(),
    ).toEqual(['agent-model', 'vision-model']);
    // An unconfigured Chat id resolves to no model, not to every model.
    expect(modelsForTelegramChats(f.config, configured, [999])).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test('a reload that only changes a binding rejects an override the connected wildcard server does not expose', async () => {
  const f = await harness((config) => {
    config.mcp = {
      servers: [
        {
          alias: 'alpha',
          transport: 'stdio',
          command: [process.execPath, FIXTURE],
          tools: '*',
          payload_max_bytes: 32768,
          result_max_bytes: 32768,
          default_tool_policy: { read_only: true, timeout_seconds: 5 },
        },
      ],
    };
    config.telegram.chats = [
      { id: CHAT_BOUND, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha', tools: '*' }] },
    ];
  });
  try {
    await f.manager.start();
    await awaitServerAttempts(f.manager);
    const next = structuredClone(f.config);
    next.telegram.chats[0]!.mcp = [
      {
        server: 'alpha',
        tool_policies: [{ name: 'nonexistent', read_only: true, timeout_seconds: 5 }],
      },
    ];
    // The server is unchanged, so `reconcile` will not reconnect it: the
    // override has to be checked against what it discovered.
    expect(() => f.manager.toolSets(next)).toThrow(
      `MCP server alpha is missing tool nonexistent, which chat ${CHAT_BOUND} overrides`,
    );
    // A valid override on a discovered tool passes.
    const valid = structuredClone(f.config);
    valid.telegram.chats[0]!.mcp = [
      { server: 'alpha', tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 5 }] },
    ];
    expect(f.manager.toolSets(valid).map((set) => set.tools.map((tool) => tool.name))).toEqual([
      ['alpha__echo', 'alpha__wait', 'alpha__images'],
    ]);
  } finally {
    await f.close();
  }
}, 30_000);
