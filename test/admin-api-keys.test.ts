import { createHash } from 'node:crypto';
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
} from './admin-api-keys-fixtures.ts';

installAdminApiKeyHooks();

test('API keys are shown once in plaintext and stored only as a SHA-256 digest', async () => {
  const { store, server, secrets } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie, 'evaluation tool');
    expect(created.key).toMatch(/^pwk_[A-Za-z0-9_-]{43}$/);
    expect(created.item).toEqual({
      id: expect.stringMatching(/^\d+$/),
      name: 'evaluation tool',
      prefix: created.key.slice(0, 12),
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    });

    const row = store.db
      .prepare<[], { name: string; prefix: string; token_hash: string; created_at: string }>(
        'SELECT name, prefix, token_hash, created_at FROM admin_api_keys',
      )
      .get();
    expect(row?.name).toBe('evaluation tool');
    expect(row?.prefix).toBe(created.key.slice(0, 12));
    expect(row?.token_hash).toBe(createHash('sha256').update(created.key).digest('hex'));
    expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    // The key material exists nowhere in the row, only its digest.
    expect(JSON.stringify(row)).not.toContain(created.key);

    // The listing repeats the metadata but never the secret.
    const listed = await server.handle(request('/api/api-keys', { headers: { cookie } }));
    expect(listed.status).toBe(200);
    const listing = await readJson(listed);
    expect(listing.items).toHaveLength(1);
    expect(Object.keys(listing.items[0]).sort()).toEqual([
      'created_at',
      'id',
      'last_used_at',
      'name',
      'prefix',
      'revoked_at',
    ]);
    expect(JSON.stringify(listing)).not.toContain(created.key);

    // The plaintext is registered for redaction, so it cannot leak through
    // error output later in the process lifetime.
    expect(secrets.redact(`upstream rejected ${created.key} for key`)).toBe('upstream rejected [REDACTED] for key');
  } finally {
    store.close();
  }
});

test('API key creation validates the TypeBox boundary and stays session-only', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const cases: readonly [unknown, string][] = [
      [{}, 'invalid_body'],
      [{ name: '' }, 'invalid_body'],
      [{ name: 'x'.repeat(81) }, 'invalid_body'],
      [{ name: 'ok', extra: true }, 'invalid_body'],
      [[{ name: 'ok' }], 'invalid_body'],
      ['not json', 'invalid_body'],
    ];
    for (const [body, code] of cases) {
      const response = await server.handle(post('/api/api-keys', body, { cookie }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: code });
    }
    // Nothing was created by the rejected attempts.
    const count = store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_api_keys').get();
    expect(count?.count).toBe(0n);

    const unauthenticated = await server.handle(post('/api/api-keys', { name: 'nope' }));
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toMatchObject({ error: 'unauthenticated' });
  } finally {
    store.close();
  }
});

test('revocation disables a key immediately and keeps its metadata', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);

    const before = await server.handle(request('/api/invocations', { headers: bearer(created.key) }));
    expect(before.status).toBe(200);

    const revoked = await server.handle(
      request(`/api/api-keys/${created.item.id}`, { method: 'DELETE', headers: { cookie } }),
    );
    expect(revoked.status).toBe(200);
    const stored = store.db
      .prepare<[bigint], { revoked_at: string | null }>('SELECT revoked_at FROM admin_api_keys WHERE id = ?')
      .get(BigInt(created.item.id));
    expect(stored?.revoked_at).toEqual(expect.any(String));

    const after = await server.handle(request('/api/invocations', { headers: bearer(created.key) }));
    expect(after.status).toBe(401);
    expect(await readJson(after)).toMatchObject({ error: 'unauthenticated' });

    const listing = await readJson(await server.handle(request('/api/api-keys', { headers: { cookie } })));
    expect(listing.items[0]).toMatchObject({ id: created.item.id, revoked_at: expect.any(String) });
    expect(listing.items[0].last_used_at).toEqual(expect.any(String));

    // Revoking twice and revoking an unknown id are not idempotent no-ops.
    const again = await server.handle(
      request(`/api/api-keys/${created.item.id}`, { method: 'DELETE', headers: { cookie } }),
    );
    expect(again.status).toBe(404);
    const unknown = await server.handle(request('/api/api-keys/999999', { method: 'DELETE', headers: { cookie } }));
    expect(unknown.status).toBe(404);
    const malformed = await server.handle(
      request('/api/api-keys/not-a-number', { method: 'DELETE', headers: { cookie } }),
    );
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'invalid_id' });
  } finally {
    store.close();
  }
});

test('malformed Origin headers are a clean 4xx and Origin still guards only writes', async () => {
  const { store, server } = await fixture();
  try {
    const cookie = await setupAdmin(server);
    const malformed = await server.handle(
      post('/api/api-keys', { name: 'origin' }, { cookie, origin: 'not a real origin' }),
    );
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'bad_origin' });

    const crossOrigin = await server.handle(
      post('/api/api-keys', { name: 'origin' }, { cookie, origin: 'http://evil.test' }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

    // No Origin at all is the CLI/non-browser path and stays accepted.
    const created = await createKey(server, cookie, 'no-origin');
    const withMalformedOriginRead = await server.handle(
      request('/api/invocations', { headers: { ...bearer(created.key), origin: 'not a real origin' } }),
    );
    expect(withMalformedOriginRead.status).toBe(200);
  } finally {
    store.close();
  }
});
