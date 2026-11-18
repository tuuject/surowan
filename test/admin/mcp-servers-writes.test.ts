import { expect, test } from 'vitest';
import { httpServer, mcpAdminFixture, revisionOf, write } from './mcp-servers-fixtures.ts';

/**
 * Session-facing write flows of the MCP servers page: adding servers, editing
 * what the panel may own, revision pinning and the delete rules.
 */
test('adding an HTTP server writes the file with follow_redirects false and hot-applies it', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const created = await write(fixture, '/mcp-servers', 'POST', {
      ...httpServer,
      headers: { 'x-api-key': 'added-plain-secret' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.apply?.applied).toEqual(['mcp.servers']);

    const file = fixture.file();
    const server = file.mcp?.servers.find((entry) => entry.alias === 'added-http');
    expect(server).toMatchObject({
      transport: 'streamable_http',
      url: 'https://added.example.test/mcp',
      follow_redirects: false,
      tools: '*',
      payload_max_bytes: 65_536,
      result_max_bytes: 16_384,
      default_tool_policy: { read_only: true, timeout_seconds: 25 },
    });
    // The plaintext went to the keychain; the file only names the entry.
    const headers = (server as { headers?: Record<string, unknown> }).headers;
    expect(headers).toEqual({ 'x-api-key': { jar: 'mcp-added-http-x-api-key' } });
    expect(fixture.secret(headers?.['x-api-key'])).toBe('added-plain-secret');
    expect(await fixture.read()).not.toContain('added-plain-secret');

    // Hot-applied: the running configuration carries the new server, not just the file.
    expect(fixture.runtime().mcp?.servers.some((server) => server.alias === 'added-http')).toBe(true);
    const listed = await write(fixture, '/mcp-servers', 'GET', undefined);
    expect(listed.body.servers?.map((server) => server.alias)).toContain('added-http');
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('adding a stdio server is refused with a pointer to the configuration file', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const before = await fixture.read();
    const created = await write(fixture, '/mcp-servers', 'POST', {
      alias: 'nope',
      transport: 'stdio',
      command: ['node', 'server.js'],
      tools: '*',
      payload_max_bytes: 32_768,
      result_max_bytes: 32_768,
      default_tool_policy: { read_only: true, timeout_seconds: 20 },
    });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: 'mcp_invalid' });
    expect(created.body.message).toContain('config.jsonc');
    expect(await fixture.read()).toBe(before);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a stdio server edits only its tools, limits and policies', async () => {
  const fixture = await mcpAdminFixture();
  try {
    for (const [label, body] of [
      ['command', { tools: ['echo'], payload_max_bytes: 32_768, result_max_bytes: 32_768, command: ['curl', 'evil'] }],
      ['env', { tools: ['echo'], payload_max_bytes: 32_768, result_max_bytes: 32_768, env: { X: 'y' } }],
      [
        'transport',
        {
          tools: ['echo'],
          payload_max_bytes: 32_768,
          result_max_bytes: 32_768,
          transport: 'streamable_http',
          url: 'https://moved.example.test/mcp',
        },
      ],
    ] as const) {
      const before = await fixture.read();
      const response = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', body);
      expect(response.status, label).toBe(400);
      expect(response.body).toMatchObject({ error: 'mcp_invalid' });
      expect(await fixture.read()).toBe(before);
    }

    const edited = await write(fixture, '/mcp-servers/stdio-fixture', 'PUT', {
      tools: ['echo', 'wait'],
      payload_max_bytes: 16_384,
      result_max_bytes: 8_192,
      tool_policies: [
        { name: 'echo', read_only: true, timeout_seconds: 10 },
        { name: 'wait', read_only: false, timeout_seconds: 5 },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.apply?.applied).toEqual(['mcp.servers']);
    const server = fixture.file().mcp?.servers.find((entry) => entry.alias === 'stdio-fixture');
    expect(server).toMatchObject({
      transport: 'stdio',
      tools: ['echo', 'wait'],
      payload_max_bytes: 16_384,
      result_max_bytes: 8_192,
      tool_policies: [
        { name: 'echo', read_only: true, timeout_seconds: 10 },
        { name: 'wait', read_only: false, timeout_seconds: 5 },
      ],
    });
    // The connection stays exactly as the file had it.
    expect((server as { command?: unknown }).command).toEqual([
      process.execPath,
      expect.stringContaining('mcp-server.ts'),
    ]);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('writes are pinned to the revision the caller read', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const stale = await revisionOf(fixture);
    // A first write moves the file on.
    const first = await write(fixture, '/mcp-servers', 'POST', httpServer);
    expect(first.status).toBe(200);
    const response = await fixture.server.handle(
      new Request('http://127.0.0.1:8899/api/mcp-servers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'if-match': stale,
          cookie: fixture.cookie,
        },
        body: JSON.stringify({ ...httpServer, alias: 'conflicted' }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'config_conflict' });

    const missing = await fixture.server.handle(
      new Request('http://127.0.0.1:8899/api/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: fixture.cookie },
        body: JSON.stringify({ ...httpServer, alias: 'no-revision' }),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'revision_required' });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a no-op write still refuses a stale If-Match', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const stale = await revisionOf(fixture);
    // The body trickles in: the route's early revision check passes while the
    // file still is at `stale`, another writer commits before the body and the
    // parsed snapshot exist, and the unchanged edit would otherwise be a no-op.
    const encoder = new TextEncoder();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"tools":["echo"],"payload_max_bytes":32768,"resu'));
      },
      async pull(controller) {
        await gate;
        controller.enqueue(
          encoder.encode(
            'lt_max_bytes":32768,"tool_policies":[{"name":"echo","read_only":true,"timeout_seconds":20}]}',
          ),
        );
        controller.close();
      },
    });
    const request = fixture.server.handle(
      new Request('http://127.0.0.1:8899/api/mcp-servers/stdio-fixture', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': stale, cookie: fixture.cookie },
        body,
        duplex: 'half',
      }),
    );
    const interlude = await write(fixture, '/mcp-servers', 'POST', { ...httpServer, alias: 'raced-writer' });
    expect(interlude.status, JSON.stringify(interlude.body)).toBe(200);
    release();
    const response = await request;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'config_conflict' });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('deleting a bound server is refused with the chat ids; an unbound one is removed', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const before = await fixture.read();
    const bound = await write(fixture, '/mcp-servers/stdio-fixture', 'DELETE', undefined);
    expect(bound.status).toBe(409);
    expect(bound.body).toMatchObject({ error: 'mcp_server_in_use' });
    expect(bound.body.message).toContain('-100777');
    expect(await fixture.read()).toBe(before);

    // The HTTP server has no explicit binding (only the inheriting chats reach it).
    const removed = await write(fixture, '/mcp-servers/http-remote', 'DELETE', undefined);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.apply?.applied).toEqual(['mcp.servers']);
    const file = fixture.file();
    expect(file.mcp?.servers.map((server) => server.alias)).toEqual(['stdio-fixture']);
    expect(file.telegram.chats.find((chat) => chat.id === -100_777)?.mcp).toEqual([{ server: 'stdio-fixture' }]);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});
