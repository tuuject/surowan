import { basename } from 'node:path';
import { expect, test } from 'vitest';
import { bearerKey, mcpAdminFixture, type McpAdminFixture, revisionOf } from './mcp-servers-fixtures.ts';

interface AdvertisedTool {
  readonly name: string;
  readonly description: string | null;
  readonly input_schema: Record<string, unknown> | null;
  readonly exposed: boolean;
  readonly policy: { readonly read_only: boolean; readonly timeout_seconds: number } | null;
}

interface ServerView {
  readonly alias: string;
  readonly transport: 'stdio' | 'streamable_http';
  readonly state: { readonly state: string; readonly error_code: string | null } | null;
  readonly connection: Record<string, unknown>;
  readonly tools: unknown;
  readonly advertised_tools: readonly AdvertisedTool[];
  readonly bound_chats: readonly { readonly chat_id: string; readonly tools: unknown }[];
}

interface View {
  readonly revision: string;
  readonly live: boolean;
  readonly servers: readonly ServerView[];
  readonly unbound_chat_ids: readonly string[];
}

async function view(fixture: McpAdminFixture, headers: Record<string, string>): Promise<View> {
  const response = await fixture.server.handle(new Request('http://127.0.0.1:8899/api/mcp-servers', { headers }));
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}

test('the list reports configuration, usage and inherited chats without any secret', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const result = await view(fixture, { cookie: fixture.cookie });
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
    // No manager runs here: the view still works and reports no live state.
    expect(result.live).toBe(false);
    expect(result.unbound_chat_ids).toEqual(['123456789']);

    const stdio = result.servers.find((server) => server.alias === 'stdio-fixture');
    expect(stdio?.transport).toBe('stdio');
    expect(stdio?.state).toBeNull();
    expect(stdio?.tools).toEqual(['echo']);
    // The argv never travels: only the program's basename and a count.
    expect(stdio?.connection).toEqual({
      kind: 'stdio',
      program: basename(process.execPath),
      argument_count: 1,
      env: [],
    });
    expect(stdio?.bound_chats).toEqual([{ chat_id: '-100777', tools: ['echo'], tool_policies: null }]);

    const http = result.servers.find((server) => server.alias === 'http-remote');
    expect(http?.transport).toBe('streamable_http');
    expect(http?.connection).toEqual({
      kind: 'streamable_http',
      url: 'http://127.0.0.1:1/mcp/mcp-path-secret?key=mcp-query-secret',
      headers: [{ name: 'authorization', source: { kind: 'entry', name: 'mcp-header' } }],
    });
    // The whole response carries neither the header's value nor the stdio argv.
    const text = JSON.stringify(result);
    expect(text).not.toContain('mcp-header-secret');
    expect(text).not.toContain('mcp-server.ts');
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('programmatic callers see header names but never their sources', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const auth = await bearerKey(fixture);
    const result = await view(fixture, auth);
    const http = result.servers.find((server) => server.alias === 'http-remote');
    expect(http?.connection).toEqual({
      kind: 'streamable_http',
      url: 'http://127.0.0.1:1',
      url_redacted: true,
      headers: [{ name: 'authorization' }],
    });
    expect(JSON.stringify(result)).not.toContain('"source"');
    expect(JSON.stringify(result)).not.toContain('mcp-path-secret');
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('URL secrets reach only panel sessions; programmatic callers get the origin', async () => {
  const fixture = await mcpAdminFixture();
  try {
    const auth = await bearerKey(fixture);
    // The session keeps the full URL: the edit form needs it verbatim.
    const sessionView = await view(fixture, { cookie: fixture.cookie });
    expect(sessionView.servers.find((server) => server.alias === 'http-remote')?.connection).toMatchObject({
      url: 'http://127.0.0.1:1/mcp/mcp-path-secret?key=mcp-query-secret',
    });

    // Hosted endpoints put tokens in the path (Zapier-style /mcp/<secret>/sse)
    // and in the query — values and bare parameter names alike — so a
    // programmatic caller gets only the origin, flagged as such.
    const programmaticView = await view(fixture, auth);
    expect(programmaticView.servers.find((server) => server.alias === 'http-remote')?.connection).toMatchObject({
      url: 'http://127.0.0.1:1',
      url_redacted: true,
    });
    // Neither secret appears anywhere in the body — not even under another field.
    expect(JSON.stringify(programmaticView)).not.toContain('mcp-path-secret');
    expect(JSON.stringify(programmaticView)).not.toContain('mcp-query-secret');
    expect(JSON.stringify(programmaticView)).not.toContain('mcp/mcp-path-secret');

    // A programmatic write response embeds the same origin-only view.
    const revision = await revisionOf(fixture);
    const written = await fixture.server.handle(
      new Request('http://127.0.0.1:8899/api/mcp-servers/http-remote', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'if-match': revision,
          ...auth,
        },
        body: JSON.stringify({
          tools: '*',
          payload_max_bytes: 32_768,
          result_max_bytes: 32_768,
          default_tool_policy: { read_only: true, timeout_seconds: 30 },
        }),
      }),
    );
    const writtenView = (await written.json()) as View;
    expect(written.status, JSON.stringify(writtenView)).toBe(200);
    expect(writtenView.servers.find((server) => server.alias === 'http-remote')?.connection).toMatchObject({
      url: 'http://127.0.0.1:1',
      url_redacted: true,
    });
    expect(JSON.stringify(writtenView)).not.toContain('mcp-path-secret');
    expect(JSON.stringify(writtenView)).not.toContain('mcp-query-secret');
  } finally {
    fixture.store.close();
    await fixture.manager?.stop();
  }
});

test('a running manager contributes live state and the full advertised tool list', async () => {
  const fixture = await mcpAdminFixture({ manager: true });
  try {
    await fixture.settled();
    const result = await view(fixture, { cookie: fixture.cookie });
    expect(result.live).toBe(true);

    const stdio = result.servers.find((server) => server.alias === 'stdio-fixture');
    expect(stdio?.state?.state).toBe('ready');
    expect(stdio?.state?.error_code).toBeNull();
    // The fixture advertises echo, wait and images; only echo is selected.
    const byName = new Map(stdio?.advertised_tools.map((tool) => [tool.name, tool]) ?? []);
    expect([...byName.keys()].sort()).toEqual(['echo', 'images', 'wait']);
    expect(byName.get('echo')).toMatchObject({
      exposed: true,
      policy: { read_only: true, timeout_seconds: 20 },
      description: 'Echo text with a server-side call count',
    });
    expect(byName.get('echo')?.input_schema).toMatchObject({ type: 'object' });
    // Hidden tools still resolve a policy through the default, which is what
    // they would run under if the operator widened the selection.
    expect(byName.get('wait')).toMatchObject({
      exposed: false,
      policy: { read_only: false, timeout_seconds: 60 },
    });
    expect(byName.get('images')).toMatchObject({ exposed: false });

    const http = result.servers.find((server) => server.alias === 'http-remote');
    expect(http?.state?.state).toBe('degraded');
    expect(http?.state?.error_code).not.toBeNull();
    expect(http?.advertised_tools).toEqual([]);
  } finally {
    await fixture.manager?.stop();
    fixture.store.close();
  }
});
