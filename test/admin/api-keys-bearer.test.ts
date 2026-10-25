import { expect, test } from 'vitest';
import {
  bearer,
  createKey,
  fixture,
  installAdminApiKeyHooks,
  post,
  readJson,
  request,
  setupAdmin,
} from './api-keys-fixtures.ts';

installAdminApiKeyHooks();

test('Bearer keys reach only the invocation read/replay surface', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const auth = bearer(created.key);

    const list = await server.handle(request('/api/invocations', { headers: auth }));
    expect(list.status).toBe(200);
    expect(await readJson(list)).toEqual({ items: [], next_cursor: null });

    // The read-only model directory is part of the exact key surface.
    const models = await server.handle(request('/api/models', { headers: auth }));
    expect(models.status).toBe(200);
    expect(await readJson(models)).toMatchObject({
      source: 'active',
      generation: 1,
      models: expect.arrayContaining([expect.objectContaining({ provider: 'agent', model: 'agent-model' })]),
    });
    expect(
      JSON.stringify(await readJson(await server.handle(request('/api/models', { headers: auth })))),
    ).not.toContain('base_url');
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await server.handle(
        request('/api/invocations', {
          headers: { authorization: `${scheme} ${created.key}` },
        }),
      );
      expect(response.status).toBe(200);
    }

    const missing = await server.handle(request('/api/invocations/999999', { headers: auth }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
    const badId = await server.handle(request('/api/invocations/not-a-number', { headers: auth }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });

    // No replay engine is wired in this fixture.
    const replay = await server.handle(post('/api/invocations/1/replay', {}, auth));
    expect(replay.status).toBe(503);
    expect(await readJson(replay)).toMatchObject({ error: 'replay_unavailable' });

    // Every other route is refused, including key management, other audits and
    // every write surface of the panel.
    const forbidden: readonly [string, string][] = [
      ['GET', '/api/overview'],
      ['GET', '/api/usage'],
      ['GET', '/api/contexts'],
      ['GET', '/api/messages'],
      ['GET', '/api/stickers'],
      ['GET', '/api/alarms'],
      ['GET', '/api/memories'],
      ['GET', '/api/admins'],
      ['GET', '/api/developer'],
      ['GET', '/api/harness'],
      ['PUT', '/api/harness'],
      ['GET', '/api/config/status'],
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys'],
      ['DELETE', '/api/api-keys/1'],
      ['POST', '/api/invocations/1'],
      ['GET', '/api/invocations/1/replay'],
      ['PUT', '/api/model'],
      ['POST', '/api/config/apply'],
      ['POST', '/api/auth/credentials'],
      ['DELETE', '/api/developer/model-payloads'],
      ['POST', '/api/wake'],
      ['POST', '/api/models'],
      ['GET', '/api/unknown-route'],
    ];
    for (const [method, path] of forbidden) {
      const init: RequestInit =
        method === 'GET'
          ? { headers: auth }
          : { method, headers: { 'content-type': 'application/json', ...auth }, body: '{}' };
      const response = await server.handle(request(path, init));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await readJson(response), `${method} ${path}`).toMatchObject({ error: 'forbidden' });
    }
    // The refusal did not consume the cookie or create anything.
    const count = store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_api_keys').get();
    expect(count?.count).toBe(1n);
  } finally {
    store.close();
  }
});

test('an Authorization header never falls back to the cookie and cannot be upgraded by one', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);

    // Valid session + invalid key: the key wins, so the request is rejected
    // instead of silently using the cookie.
    const both = await server.handle(
      request('/api/invocations', { headers: { cookie, ...bearer('pwk_definitely-not-a-key') } }),
    );
    expect(both.status).toBe(401);
    expect(await readJson(both)).toMatchObject({ error: 'unauthenticated' });

    // Valid session + valid key is still limited to the key surface.
    const upgraded = await server.handle(request('/api/memories', { headers: { cookie, ...bearer(created.key) } }));
    expect(upgraded.status).toBe(403);
    expect(await readJson(upgraded)).toMatchObject({ error: 'forbidden' });

    const upgradedKeyManagement = await server.handle(
      post('/api/api-keys', { name: 'via-bearer' }, { cookie, ...bearer(created.key) }),
    );
    expect(upgradedKeyManagement.status).toBe(403);

    const basic = await server.handle(
      request('/api/invocations', { headers: { cookie, authorization: 'Basic dXNlcjpwYXNz' } }),
    );
    expect(basic.status).toBe(401);
    const empty = await server.handle(request('/api/invocations', { headers: { cookie, authorization: '' } }));
    expect(empty.status).toBe(401);
    const rawKey = await server.handle(
      request('/api/invocations', { headers: { cookie, authorization: created.key } }),
    );
    expect(rawKey.status).toBe(401);
    const unknown = await server.handle(request('/api/invocations', { headers: bearer('pwk_unknown') }));
    expect(unknown.status).toBe(401);
    expect(await readJson(unknown)).toEqual({
      error: 'unauthenticated',
      message: 'A valid API key is required',
    });
  } finally {
    store.close();
  }
});
