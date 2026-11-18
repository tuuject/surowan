import { expect, test } from 'vitest';
import { httpServer, mcpAdminFixture, write } from './mcp-servers-fixtures.ts';

/**
 * Policy and shape semantics of the MCP server writes: `null` really removes,
 * the file's own tolerances (empty explicit tool list) hold, awkward header
 * names neither vanish nor become dead config, and candidates validate against
 * the deployment's registered search providers.
 */
test('null removes a policy field instead of silently keeping it', async () => {
  const fixture = await mcpAdminFixture();
  try {
    // The seeded wildcard server carries a per-tool override next to its default.
    expect(fixture.file().mcp?.servers.find((server) => server.alias === 'http-remote')).toMatchObject({
      tool_policies: [{ name: 'query', read_only: true, timeout_seconds: 5 }],
    });

    const cleared = await write(fixture, '/mcp-servers/http-remote', 'PUT', {
      result_max_bytes: 16_384,
      tools: '*',
      payload_max_bytes: 32_768,
      tool_policies: null,
      default_tool_policy: { read_only: true, timeout_seconds: 30 },
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const http = fixture.file().mcp?.servers.find((server) => server.alias === 'http-remote');
    expect(http).not.toHaveProperty('tool_policies');
    expect(http).toMatchObject({ result_max_bytes: 16_384, default_tool_policy: { timeout_seconds: 30 } });

    // An explicit-list server may drop its unused default policy the same way.
    const noDefault = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', {
      tools: ['echo'],
      payload_max_bytes: 32_768,
      result_max_bytes: 32_768,
      tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }],
      default_tool_policy: null,
    });
    expect(noDefault.status, JSON.stringify(noDefault.body)).toBe(200);
    const stdio = fixture.file().mcp?.servers.find((server) => server.alias === 'stdio-fixture');
    expect(stdio).not.toHaveProperty('default_tool_policy');
    expect(stdio).toMatchObject({ tool_policies: [{ name: 'echo', read_only: true, timeout_seconds: 20 }] });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('an empty explicit tool list is as legal as in the file', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const created = await write(fixture, '/mcp-servers', 'POST', {
      ...httpServer,
      alias: 'empty-tools',
      tools: [],
      default_tool_policy: undefined,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(fixture.file().mcp?.servers.find((server) => server.alias === 'empty-tools')).toMatchObject({
      tools: [],
    });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a header named __proto__ is refused instead of silently vanishing', async () => {
  const fixture = await mcpAdminFixture();
  try {
    // A literal `{ __proto__: ... }` would set the object's prototype, so the
    // awkward header name is assembled as an own property the way JSON would.
    const awkwardHeaders = Object.create(null) as Record<string, string>;
    Object.defineProperty(awkwardHeaders, '__proto__', {
      value: 'proto-header-secret',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const before = await fixture.read();
    const created = await write(fixture, '/mcp-servers', 'POST', {
      ...httpServer,
      alias: 'proto-http',
      headers: awkwardHeaders,
    });
    // The runtime's own JSONC parser drops that name on every read, so a
    // written `__proto__` header would be dead config; the panel refuses it
    // instead of accepting a header that can never reach the server.
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: 'mcp_invalid' });
    expect(created.body.message).toContain("'__proto__'");
    expect(await fixture.read()).toBe(before);

    // Other awkward-but-survivable names round trip through create and edit.
    const oddHeaders = Object.create(null) as Record<string, string>;
    Object.defineProperty(oddHeaders, 'constructor', {
      value: 'odd-header-secret',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    oddHeaders['x-normal'] = 'normal-header-secret';
    const stored = await write(fixture, '/mcp-servers', 'POST', {
      ...httpServer,
      alias: 'proto-http',
      headers: oddHeaders,
    });
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    const file = fixture.file();
    const server = file.mcp?.servers.find((entry) => entry.alias === 'proto-http') as
      | { headers?: Record<string, unknown> }
      | undefined;
    expect(server?.headers?.constructor).toEqual({ jar: 'mcp-proto-http-constructor' });
    expect(server?.headers?.['x-normal']).toEqual({ jar: 'mcp-proto-http-x-normal' });
    expect(fixture.secret(server?.headers?.constructor)).toBe('odd-header-secret');

    // An edit merges onto the stored headers; the awkward name survives that too.
    const edited = await write(fixture, '/mcp-servers/proto-http', 'PUT', {
      url: 'https://proto.example.test/mcp',
      tools: '*',
      payload_max_bytes: 32_768,
      result_max_bytes: 32_768,
      default_tool_policy: { read_only: true, timeout_seconds: 30 },
      headers: { 'x-extra': 'extra-header-secret' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = fixture.file().mcp?.servers.find((entry) => entry.alias === 'proto-http') as
      | { headers?: Record<string, unknown> }
      | undefined;
    expect(after?.headers?.constructor).toEqual({ jar: 'mcp-proto-http-constructor' });
    expect(after?.headers?.['x-extra']).toEqual({ jar: 'mcp-proto-http-x-extra' });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('MCP writes validate against the deployment registered search providers', async () => {
  const fixture = await mcpAdminFixture({ customSearch: true });
  try {
    // The web_search section references a plugin-registered provider; the MCP
    // candidate must validate with that provider, not the built-in catalog.
    const edited = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', {
      tools: ['echo', 'wait'],
      payload_max_bytes: 32_768,
      result_max_bytes: 32_768,
      tool_policies: [
        { name: 'echo', read_only: true, timeout_seconds: 20 },
        { name: 'wait', read_only: false, timeout_seconds: 10 },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});
