import { expect, test } from 'vitest';
import { bearerKey, httpServer, mcpAdminFixture, write } from './mcp-servers-fixtures.ts';

/**
 * The rules that separate programmatic callers (API keys, paired clients) from
 * panel sessions: no keychain-entry reuse, a moved URL needs its header
 * secrets again, and echoing the redacted origin back is not a move.
 */
test('a programmatic caller cannot reuse an existing keychain entry for a header', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const auth = await bearerKey(fixture);
    const created = await write(
      fixture,
      '/mcp-servers',
      'POST',
      {
        ...httpServer,
        headers: { authorization: { entry: 'mcp-header' } },
      },
      auth,
    );
    expect(created.status).toBe(403);
    expect(created.body).toMatchObject({ error: 'entry_not_allowed' });
    expect(fixture.file().mcp?.servers.some((server) => server.alias === 'added-http')).toBe(false);
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a programmatic caller moving a url must re-enter the header secrets', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const auth = await bearerKey(fixture);
    const before = await fixture.read();
    const moved = await write(
      fixture,
      '/mcp-servers/http-remote',
      'PUT',
      {
        url: 'https://attacker.example.test/mcp',
        tools: '*',
        payload_max_bytes: 32_768,
        result_max_bytes: 32_768,
        default_tool_policy: { read_only: true, timeout_seconds: 30 },
      },
      auth,
    );
    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({ error: 'mcp_invalid' });
    expect(moved.body.message).toContain('re-enter its header secrets');
    expect(await fixture.read()).toBe(before);

    // A session is the admin: it may keep the stored entry while moving the url.
    const sessionMoved = await write(fixture, '/mcp-servers/http-remote', 'PUT', {
      url: 'https://moved.example.test/mcp',
      tools: '*',
      payload_max_bytes: 32_768,
      result_max_bytes: 32_768,
      default_tool_policy: { read_only: true, timeout_seconds: 30 },
    });
    expect(sessionMoved.status, JSON.stringify(sessionMoved.body)).toBe(200);
    expect(fixture.file().mcp?.servers.find((server) => server.alias === 'http-remote')).toMatchObject({
      url: 'https://moved.example.test/mcp',
      headers: { authorization: { jar: 'mcp-header' } },
    });
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a programmatic read-modify-write echoing the redacted URL keeps the stored one', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const auth = await bearerKey(fixture);
    // The redacted view a programmatic client read: the origin, nothing more.
    const listed = await fixture.server.handle(new Request('http://127.0.0.1:8899/api/mcp-servers', { headers: auth }));
    const seen = (await listed.json()) as {
      servers: { alias: string; connection: { url: string; url_redacted?: boolean } }[];
    };
    expect(seen.servers.find((server) => server.alias === 'http-remote')?.connection).toMatchObject({
      url: 'http://127.0.0.1:1',
      url_redacted: true,
    });

    // Echoing that origin back with an unrelated change is NOT a URL move:
    // the stored, key-bearing URL stays and no header secret is demanded.
    const echoed = await write(
      fixture,
      '/mcp-servers/http-remote',
      'PUT',
      {
        url: 'http://127.0.0.1:1',
        tools: '*',
        payload_max_bytes: 32_768,
        result_max_bytes: 16_384,
        default_tool_policy: { read_only: true, timeout_seconds: 30 },
      },
      auth,
    );
    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
    expect(fixture.file().mcp?.servers.find((server) => server.alias === 'http-remote')).toMatchObject({
      url: 'http://127.0.0.1:1/mcp/mcp-path-secret?key=mcp-query-secret',
      result_max_bytes: 16_384,
      headers: { authorization: { jar: 'mcp-header' } },
    });
    // The response still shows the origin, not the stored URL.
    expect(echoed.body.servers?.find((server) => server.alias === 'http-remote')).toMatchObject({
      connection: { url: 'http://127.0.0.1:1', url_redacted: true },
    });

    // A genuinely different URL keeps the rule: the header secrets must come
    // along in the same request.
    const moved = await write(
      fixture,
      '/mcp-servers/http-remote',
      'PUT',
      {
        url: 'https://attacker.example.test/mcp',
        tools: '*',
        payload_max_bytes: 32_768,
        result_max_bytes: 16_384,
        default_tool_policy: { read_only: true, timeout_seconds: 30 },
      },
      auth,
    );
    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({ error: 'mcp_invalid' });
    expect(moved.body.message).toContain('re-enter its header secrets');
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});
