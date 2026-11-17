import { expect, test } from 'vitest';
import {
  adminFixture,
  type Fixture,
  installAdminProviderHooks,
  readJson,
  request,
  revisionOf,
  write,
} from './providers-fixtures.ts';

installAdminProviderHooks();

/** A bearer API key with write permission, obtained through the panel session. */
async function bearerKey(fixture: Fixture, mode = 'read_write'): Promise<Record<string, string>> {
  const created = await write(fixture, '/api/api-keys', 'POST', { name: 'caller', mode }, await revisionOf(fixture));
  expect(created.status).toBe(200);
  const body = (await readJson(created)) as { key: string };
  return { authorization: `Bearer ${body.key}` };
}

test('the manager lists entries with their use sites and never a value', async () => {
  const fixture = await adminFixture();
  try {
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as {
      entries: { name: string; created_at: string; restart_required: boolean; used_by?: string[] }[];
      usage: {
        file: Record<string, string[]> | null;
        active: string[];
        external: { path: string; kind: string; env?: string }[];
      };
    };
    expect(view.usage.file).not.toBeNull();
    const names = view.entries.map((entry) => entry.name).sort();
    expect(names).toContain('agent');
    expect(names).toContain('header');
    // The entry the agent provider uses is referenced by its config path.
    const agent = view.usage.file?.agent;
    expect(agent).toContain('providers.agent.api_key');
    expect(view.usage.active).toContain('agent');
    // No response ever carries a value.
    expect(JSON.stringify(view)).not.toContain('agent-secret');
    expect(JSON.stringify(view)).not.toContain('header-secret-value');
  } finally {
    fixture.store.close();
  }
});

test('the manager creates, rotates and deletes entries', async () => {
  const fixture = await adminFixture();
  try {
    const headers = { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' };
    const created = await fixture.server.handle(
      request('/api/keychain', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'spare', value: 'spare-secret' }),
      }),
    );
    expect(created.status).toBe(201);
    // Duplicate names conflict.
    const duplicate = await fixture.server.handle(
      request('/api/keychain', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'spare', value: 'again' }),
      }),
    );
    expect(duplicate.status).toBe(409);
    // A rotation triggers an apply and reports it.
    const rotated = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('agent')}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'agent-secret-v2' }),
      }),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await readJson(rotated)) as { status: string; apply: { applied: string[] } };
    expect(rotatedBody.status).toBe('rotated');
    expect(JSON.stringify(rotatedBody)).not.toContain('agent-secret-v2');

    // Deleting an entry the configuration still uses is refused.
    const used = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('agent')}`, { method: 'DELETE', headers }),
    );
    expect(used.status).toBe(409);
    expect(await readJson(used)).toMatchObject({ error: 'keychain_in_use' });

    // An unused entry goes with an explicit delete.
    const removed = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('spare')}`, { method: 'DELETE', headers }),
    );
    expect(removed.status).toBe(200);
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { entries: { name: string }[] };
    expect(view.entries.map((entry) => entry.name)).not.toContain('spare');
    // Rotating a missing entry answers 404.
    const missing = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('absent')}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      }),
    );
    expect(missing.status).toBe(404);
  } finally {
    fixture.store.close();
  }
});

test('the manager purges exactly the confirmed orphans', async () => {
  const fixture = await adminFixture();
  try {
    const headers = { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' };
    for (const name of ['orphan-a', 'orphan-b']) {
      const created = await fixture.server.handle(
        request('/api/keychain', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ name, value: `${name}-secret` }),
        }),
      );
      expect(created.status).toBe(201);
    }
    // `agent` is in use and stays; only the orphans go.
    const purged = await fixture.server.handle(
      request('/api/keychain/purge', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ names: ['orphan-a', 'orphan-b', 'agent'] }),
      }),
    );
    expect(purged.status).toBe(200);
    expect(await readJson(purged)).toEqual({ deleted: ['orphan-a', 'orphan-b'], skipped: ['agent'] });
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { entries: { name: string }[] };
    expect(view.entries.map((entry) => entry.name).sort()).toEqual([
      'agent',
      'builtin',
      'header',
      'telegram',
      'vision',
    ]);
  } finally {
    fixture.store.close();
  }
});

test('an unparsable configuration file blocks every reclaiming operation', async () => {
  const fixture = await adminFixture();
  try {
    const headers = { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fixture.configPath, '{ "version": 1, broken', { mode: 0o600 });
    const blockedDelete = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('builtin')}`, { method: 'DELETE', headers }),
    );
    expect(blockedDelete.status).toBe(409);
    expect(await readJson(blockedDelete)).toMatchObject({ error: 'keychain_unparsable' });
    const blockedPurge = await fixture.server.handle(
      request('/api/keychain/purge', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ names: ['builtin'] }),
      }),
    );
    expect(blockedPurge.status).toBe(409);
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { usage: { file: unknown } };
    // The list still works, with the usage marked unavailable.
    expect(view.usage.file).toBeNull();
  } finally {
    // The connection is already gone; only the directory cleanup remains.
    try {
      fixture.store.close();
    } catch {
      // Already closed by the test itself.
    }
  }
});

test('the keychain endpoints are invisible to programmatic credentials', async () => {
  const fixture = await adminFixture();
  try {
    const auth = await bearerKey(fixture);
    for (const [method, path, body] of [
      ['GET', '/api/keychain', undefined],
      ['POST', '/api/keychain', { name: 'x', value: 'y' }],
      ['PUT', '/api/keychain/agent', { value: 'z' }],
      ['DELETE', '/api/keychain/agent', undefined],
      ['POST', '/api/keychain/purge', { names: [] }],
    ] as const) {
      const response = await fixture.server.handle(
        request(path, {
          method,
          headers: { 'content-type': 'application/json', ...auth },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  } finally {
    fixture.store.close();
  }
});

test('a rotation that an MCP server uses reports through the hot path, not a restart', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.mcp = {
        servers: [
          {
            alias: 'notes',
            transport: 'stdio',
            command: ['node', 'server.js'],
            tools: '*',
            payload_max_bytes: 32_768,
            result_max_bytes: 32_768,
            default_tool_policy: { read_only: true, timeout_seconds: 20 },
            env: { NOTES_KEY: { jar: 'mcp-notes' } },
          },
        ],
      };
    },
  });
  try {
    const headers = { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' };
    const created = await fixture.server.handle(
      request('/api/keychain', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'mcp-notes', value: 'notes-secret' }),
      }),
    );
    expect(created.status).toBe(201);
    expect((await fixture.server.handle(request('/api/config/apply', { method: 'POST', headers }))).status).toBe(200);
    const rotated = await fixture.server.handle(
      request(`/api/keychain/${encodeURIComponent('mcp-notes')}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'notes-secret-v2' }),
      }),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await readJson(rotated)) as {
      apply: { applied: string[]; restart_required: string[] };
    };
    // The rotation reconnects the server through the hot MCP path.
    expect(rotatedBody.apply.applied).toContain('mcp.servers');
    expect(rotatedBody.apply.restart_required).toEqual([]);
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { entries: { name: string; restart_required?: boolean }[] };
    expect(view.entries.find((entry) => entry.name === 'mcp-notes')?.restart_required).toBeUndefined();
  } finally {
    fixture.store.close();
  }
});
