import { expect, test } from 'vitest';
import {
  type Fixture,
  bearer,
  fixture,
  installAdminApiKeyHooks,
  post,
  readJson,
  request,
  setupAdmin,
} from './api-keys-fixtures.ts';

installAdminApiKeyHooks();

async function createModeKey(server: Fixture['server'], cookie: string, mode: string) {
  const response = await server.handle(post('/api/api-keys', { name: `key-${mode}`, mode }, { cookie }));
  expect(response.status).toBe(200);
  return await readJson(response);
}

function modern(
  method: string,
  params: Record<string, unknown>,
  id = 1,
  headers: Record<string, string> = {},
): Request {
  return post(
    '/mcp',
    {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    },
    { 'mcp-protocol-version': '2026-07-28', ...headers },
  );
}

test('modern MCP advertises tools, permissions and skills', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createModeKey(server, cookie, 'read');
    const auth = bearer(created.key);

    const discover = await server.handle(modern('server/discover', {}, 1, auth));
    expect(discover.status).toBe(200);
    const discovered = await readJson(discover);
    expect(discovered.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']),
      capabilities: {
        tools: {},
        resources: {},
        extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } },
      },
    });

    const tools = await server.handle(modern('tools/list', {}, 2, auth));
    const listed = await readJson(tools);
    expect(listed.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'surowan_key_show' }),
        expect.objectContaining({ name: 'surowan_invocation_replay' }),
        expect.objectContaining({ name: 'surowan_harness_update' }),
      ]),
    );
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('surowan_setup');

    const skillList = await server.handle(modern('skills/list', {}, 3, auth));
    const skills = await readJson(skillList);
    expect(skills.result.skills).toHaveLength(1);
    expect(skills.result.skills[0]).toMatchObject({
      uri: 'skill://surowan-mcp/SKILL.md',
      frontmatter: { name: 'surowan-mcp' },
    });
    expect(skills.result.skills[0].resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: 'skill://surowan-mcp/references/tools.md' })]),
    );

    const read = await server.handle(modern('resources/read', { uri: 'skill://surowan-mcp/SKILL.md' }, 4, auth));
    const content = await readJson(read);
    expect(content.result.contents[0]).toMatchObject({
      uri: 'skill://surowan-mcp/SKILL.md',
      mimeType: 'text/markdown',
    });
    expect(content.result.contents[0].text).toContain('surowan_key_show');

    const key = await server.handle(modern('tools/call', { name: 'surowan_key_show', arguments: {} }, 5, auth));
    const keyResult = await readJson(key);
    expect(keyResult.result.resultType).toBe('complete');
    expect(keyResult.result.structuredContent).toMatchObject({
      mode: 'read',
      permissions: { read_all: true, write_all: false, execute_paid_operations: false },
    });

    // Read-only keys now reach ordinary audit reads.
    const overview = await server.handle(request('/api/overview', { headers: auth }));
    expect(overview.status).toBe(200);

    // But a write tool is refused with a permission error, not an unknown route.
    const denied = await server.handle(
      modern('tools/call', { name: 'surowan_harness_update', arguments: { body: {}, if_match: 'x' } }, 6, auth),
    );
    expect(await readJson(denied)).toMatchObject({
      result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Permission denied') }] },
    });

    // Account and key management remain unreachable for every key.
    const keys = await server.handle(request('/api/api-keys', { headers: auth }));
    expect(keys.status).toBe(403);
    expect(await readJson(keys)).toMatchObject({ error: 'forbidden' });
  } finally {
    store.close();
  }
});

test('mode updates and rotation change the effective permissions', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createModeKey(server, cookie, 'read');

    const listed = await readJson(await server.handle(request('/api/api-keys', { headers: { cookie } })));
    expect(listed.items[0]).toMatchObject({
      mode: 'read',
      permissions: { read_all: true, write_all: false, execute_paid_operations: false },
    });

    const updated = await server.handle(
      request(`/api/api-keys/${created.item.id}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(await readJson(updated)).toMatchObject({ item: { mode: 'all' } });

    const keyInfo = await readJson(await server.handle(request('/api/key', { headers: bearer(created.key) })));
    expect(keyInfo).toMatchObject({ mode: 'all', permissions: { write_all: true, execute_paid_operations: true } });

    const rotated = await server.handle(
      request(`/api/api-keys/${created.item.id}/rotate`, { method: 'POST', headers: { cookie } }),
    );
    expect(rotated.status).toBe(200);
    const newKey = await readJson(rotated);
    expect(newKey.key).not.toBe(created.key);
    expect((await server.handle(request('/api/key', { headers: bearer(created.key) }))).status).toBe(401);
    expect((await server.handle(request('/api/key', { headers: bearer(newKey.key) }))).status).toBe(200);
  } finally {
    store.close();
  }
});

test('invalid permission rows fail authentication and raise a standing warning', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createModeKey(server, cookie, 'read');
    store.db.prepare('UPDATE admin_api_keys SET read_all = 0 WHERE id = ?').run(BigInt(created.item.id));

    const rejected = await server.handle(request('/api/key', { headers: bearer(created.key) }));
    expect(rejected.status).toBe(401);

    const warnings = await readJson(await server.handle(request('/api/warnings', { headers: { cookie } })));
    expect(warnings.standing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'api_key_invalid_permissions',
          variables: { keys: expect.arrayContaining([expect.objectContaining({ name: 'key-read' })]) },
        }),
      ]),
    );
    // The page still renders the key list rather than failing on the bad row.
    const listed = await readJson(await server.handle(request('/api/api-keys', { headers: { cookie } })));
    expect(listed.items[0]).toMatchObject({ mode: null });
  } finally {
    store.close();
  }
});

test('legacy initialize still works and shares the tool catalog', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createModeKey(server, cookie, 'read');
    const initialized = await server.handle(
      post(
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        },
        { authorization: `Bearer ${created.key}`, accept: 'application/json, text/event-stream' },
      ),
    );
    expect(initialized.status).toBe(200);
    const body = await readJson(initialized);
    expect(body.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
        resources: {},
        extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } },
      },
    });
    const listed = await server.handle(
      post(
        '/mcp',
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        {
          authorization: `Bearer ${created.key}`,
          accept: 'application/json, text/event-stream',
          'mcp-session-id': initialized.headers.get('mcp-session-id') ?? '',
        },
      ),
    );
    expect(listed.status).toBe(200);
    expect((await readJson(listed)).result.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'surowan_key_show' })]),
    );
  } finally {
    store.close();
  }
});
