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

test('read keys reach every read surface but no write or paid route', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie, 'read-only', 'read');
    const auth = bearer(created.key);

    for (const path of [
      '/api/invocations',
      '/api/models',
      '/api/overview',
      '/api/usage',
      '/api/contexts',
      '/api/messages',
      '/api/stickers',
      '/api/alarms',
      '/api/config/view',
    ]) {
      const response = await server.handle(request(path, { headers: auth }));
      expect(response.status, path).toBe(200);
    }
    expect(
      JSON.stringify(await readJson(await server.handle(request('/api/models', { headers: auth })))),
    ).not.toContain('base_url');
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await server.handle(
        request('/api/invocations', { headers: { authorization: `${scheme} ${created.key}` } }),
      );
      expect(response.status).toBe(200);
    }

    // Paid operations and writes are refused by permission, not by route.
    for (const [method, path, body] of [
      ['POST', '/api/invocations/1/replay', {}],
      ['PUT', '/api/harness', {}],
      ['POST', '/api/wake', undefined],
      ['POST', '/api/providers/health-check', {}],
    ] as const) {
      const response = await server.handle(
        request(path, {
          method,
          headers: { 'content-type': 'application/json', ...auth },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await readJson(response), `${method} ${path}`).toMatchObject({ error: 'forbidden' });
    }

    // Account and key management stay unreachable.
    for (const [method, path] of [
      ['GET', '/api/api-keys'],
      ['POST', '/api/api-keys'],
      ['DELETE', '/api/api-keys/1'],
      ['GET', '/api/auth/session'],
      ['POST', '/api/auth/credentials'],
      ['GET', '/api/unknown-route'],
    ] as const) {
      const response = await server.handle(
        request(path, {
          method,
          headers: { 'content-type': 'application/json', ...auth },
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await readJson(response), `${method} ${path}`).toMatchObject({ error: 'forbidden' });
    }
    const count = store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_api_keys').get();
    expect(count?.count).toBe(1n);
  } finally {
    store.close();
  }
});

test('paid and write grants are independent and both apply at once', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const paid = await createKey(server, cookie, 'paid', 'read_paid');
    const write = await createKey(server, cookie, 'write', 'read_write');

    // Paid replay passes the permission gate; the fixture has no engine.
    const replay = await server.handle(post('/api/invocations/1/replay', {}, bearer(paid.key)));
    expect(replay.status).toBe(503);
    expect(await readJson(replay)).toMatchObject({ error: 'replay_unavailable' });

    // A write route passes the permission gate but needs the unwired reloader.
    const harness = await server.handle(
      request('/api/harness', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...bearer(write.key) },
        body: JSON.stringify({}),
      }),
    );
    expect(harness.status).not.toBe(403);

    // The write grant does not buy a paid route.
    const deniedReplay = await server.handle(post('/api/invocations/1/replay', {}, bearer(write.key)));
    expect(deniedReplay.status).toBe(403);
  } finally {
    store.close();
  }
});

test('an Authorization header never falls back to the cookie and cannot be upgraded by one', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie, 'read-only', 'read');

    const both = await server.handle(
      request('/api/invocations', { headers: { cookie, ...bearer('pwk_definitely-not-a-key') } }),
    );
    expect(both.status).toBe(401);
    expect(await readJson(both)).toMatchObject({ error: 'unauthenticated' });

    // Valid session + valid read key keeps the key's permissions.
    const upgraded = await server.handle(request('/api/overview', { headers: { cookie, ...bearer(created.key) } }));
    expect(upgraded.status).toBe(200);
    const writeUpgrade = await server.handle(
      request('/api/harness', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json', ...bearer(created.key) },
        body: '{}',
      }),
    );
    expect(writeUpgrade.status).toBe(403);

    const keyManagement = await server.handle(
      post('/api/api-keys', { name: 'via-bearer', mode: 'read' }, { cookie, ...bearer(created.key) }),
    );
    expect(keyManagement.status).toBe(403);

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
