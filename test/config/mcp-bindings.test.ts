import { expect, test } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { affectedMcpChatIds } from '../../src/capabilities/mcp/bindings.ts';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { testConfigJsonc, writeTestConfig, type FixtureConfig } from '../helpers.ts';
import { createDirectory, loadBoth, paths } from './diff-fixtures.ts';

/** A stdio server with an explicit tool list, and a second one for bindings to point at. */
function withMcp(config: FixtureConfig): void {
  config.mcp = {
    servers: [
      {
        alias: 'search',
        transport: 'stdio',
        command: [process.execPath, 'search-server.ts'],
        required: false,
        tools: ['query', 'fetch'],
        payload_max_bytes: 32768,
        result_max_bytes: 32768,
        tool_policies: [
          { name: 'query', read_only: true, timeout_seconds: 10 },
          { name: 'fetch', read_only: false, timeout_seconds: 20 },
        ],
      },
      {
        alias: 'notes',
        transport: 'stdio',
        command: [process.execPath, 'notes-server.ts'],
        required: false,
        tools: '*',
        payload_max_bytes: 32768,
        result_max_bytes: 32768,
        default_tool_policy: { read_only: true, timeout_seconds: 5 },
      },
    ],
  };
}

async function loadWith(transform: (config: FixtureConfig) => void): Promise<void> {
  const directory = await createDirectory('surowan-config-mcp-');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      withMcp(config);
      transform(config);
    }),
  );
  await loadConfig(configPath);
}

async function loadError(transform: (config: FixtureConfig) => void): Promise<string> {
  try {
    await loadWith(transform);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the configuration to be rejected');
}

const CHAT = 123456789;

function binding(chat: FixtureConfig['telegram']['chats'][number], value: unknown): void {
  (chat as unknown as Record<string, unknown>).mcp = value;
}

test('a Chat binding narrows one server and may override its tool policies', async () => {
  await loadWith((config) => {
    binding(config.telegram.chats[0]!, [
      { server: 'search', tools: ['query'], tool_policies: [{ name: 'query', read_only: false, timeout_seconds: 30 }] },
      { server: 'notes', tools: '*' },
    ]);
  });
});

test('an empty binding list is valid and means no MCP tools', async () => {
  await loadWith((config) => {
    binding(config.telegram.chats[0]!, []);
  });
});

test('a binding must name a configured server alias', async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [{ server: 'ghost' }]);
    }),
  ).toContain(`Chat ${CHAT} MCP binding references unknown server ghost`);
});

test('a Chat cannot bind the same server twice', async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search' }, { server: 'search', tools: ['query'] }]);
    }),
  ).toContain(`Duplicate chat ${CHAT} MCP binding: search`);
});

test("a binding may not select tools the server's own list does not expose", async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query', 'delete'] }]);
    }),
  ).toContain(`Chat ${CHAT} MCP binding for search lists tool delete, which the server does not expose`);
});

test('a binding policy must name a tool it selects', async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [
        {
          server: 'search',
          tools: ['query'],
          tool_policies: [{ name: 'fetch', read_only: true, timeout_seconds: 5 }],
        },
      ]);
    }),
  ).toContain(`Chat ${CHAT} MCP binding for search policy references unselected tool fetch`);
});

test('a binding without tools may override a tool a wildcard server discovers', async () => {
  // `notes` exposes `*`: its tool names only exist after discovery, so the
  // effective selection defers there instead of being read as the string `'*'`.
  await loadWith((config) => {
    binding(config.telegram.chats[0]!, [
      { server: 'notes', tool_policies: [{ name: 'lookup', read_only: false, timeout_seconds: 5 }] },
    ]);
  });
});

test('a wildcard binding over an explicit server list is checked against that list', async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [
        {
          server: 'search',
          tools: '*',
          tool_policies: [{ name: 'qurey', read_only: true, timeout_seconds: 5 }],
        },
      ]);
    }),
  ).toContain(`Chat ${CHAT} MCP binding for search policy references unselected tool qurey`);
});

test('a binding policy list has unique names', async () => {
  expect(
    await loadError((config) => {
      binding(config.telegram.chats[0]!, [
        {
          server: 'search',
          tool_policies: [
            { name: 'query', read_only: true, timeout_seconds: 5 },
            { name: 'query', read_only: false, timeout_seconds: 5 },
          ],
        },
      ]);
    }),
  ).toContain('Duplicate chat 123456789 MCP binding tool policy of search: query');
});

// --- Hot classification ---

test('changing an MCP server is hot', async () => {
  const { active, file } = await loadBoth(withMcp, (config) => {
    withMcp(config);
    const server = config.mcp!.servers[0]!;
    if (server.transport !== 'stdio') {
      throw new Error('Expected a stdio server');
    }
    server.result_max_bytes = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toContain('mcp.servers');
  expect(diff.candidate.file.mcp?.servers[0]?.result_max_bytes).toBe(4096);
});

test('changing a Chat MCP binding is hot', async () => {
  const { active, file } = await loadBoth(withMcp, (config) => {
    withMcp(config);
    binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query'] }]);
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toEqual([`telegram.chats[${CHAT}].mcp`]);
  expect(diff.candidate.raw.telegram.chats[0]?.mcp).toEqual([{ server: 'search', tools: ['query'] }]);
});

// --- Affected Chats ---

async function configs(
  before: (config: FixtureConfig) => void,
  after: (config: FixtureConfig) => void,
): Promise<{
  previous: Awaited<ReturnType<typeof loadBoth>>['active'];
  next: Awaited<ReturnType<typeof loadBoth>>['file'];
}> {
  const { active, file } = await loadBoth(
    (config) => {
      withMcp(config);
      before(config);
    },
    (config) => {
      withMcp(config);
      after(config);
    },
  );
  return { previous: active, next: file };
}

test('widening a binding to * and overriding only a newly exposed tool is not an affecting change', async () => {
  const { previous, next } = await configs(
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query'] }]);
    },
    (config) => {
      binding(config.telegram.chats[0]!, [
        {
          server: 'search',
          tools: '*',
          tool_policies: [{ name: 'fetch', read_only: true, timeout_seconds: 5 }],
        },
      ]);
    },
  );
  expect(affectedMcpChatIds(previous.config, next.config)).toEqual([]);
});

test('changing the policy of a tool the Chat already had is affecting', async () => {
  const { previous, next } = await configs(
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query'] }]);
    },
    (config) => {
      binding(config.telegram.chats[0]!, [
        {
          server: 'search',
          tools: ['query'],
          tool_policies: [{ name: 'query', read_only: false, timeout_seconds: 5 }],
        },
      ]);
    },
  );
  expect(affectedMcpChatIds(previous.config, next.config)).toEqual([CHAT]);
});

test('narrowing a binding or changing a server is affecting; adding one is not', async () => {
  const narrowed = await configs(
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query', 'fetch'] }]);
    },
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search', tools: ['query'] }]);
    },
  );
  expect(affectedMcpChatIds(narrowed.previous.config, narrowed.next.config)).toEqual([CHAT]);

  const serverEdited = await configs(
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search' }]);
    },
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search' }]);
      config.mcp!.servers[0]!.result_max_bytes = 4096;
    },
  );
  expect(affectedMcpChatIds(serverEdited.previous.config, serverEdited.next.config)).toEqual([CHAT]);

  const serverAdded = await configs(
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search' }]);
    },
    (config) => {
      binding(config.telegram.chats[0]!, [{ server: 'search' }, { server: 'notes' }]);
    },
  );
  expect(affectedMcpChatIds(serverAdded.previous.config, serverAdded.next.config)).toEqual([]);
});
