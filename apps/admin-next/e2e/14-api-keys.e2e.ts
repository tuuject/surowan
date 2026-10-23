import { type APIRequestContext, expect, test } from '@playwright/test';
import { bearer, signIn } from './api-key-helpers.ts';
import { adminUrl } from './helpers.ts';

/**
 * Programmatic API keys against the real AdminServer: session-only management,
 * one-time plaintext, a Bearer surface limited to inspection and invocation routes,
 * immediate revocation, and the unwired replay engine answering 503. The
 * fixture seeds invocation 4001 (see test/fixtures/admin-seed.ts).
 *
 * The management UI lives in `14-api-keys-ui.e2e.ts`,
 * `14-api-keys-ui-revoke.e2e.ts` and `14-api-keys-ui-failures.e2e.ts`; every
 * spec in this group signs in itself (see `api-key-helpers.ts`) instead of
 * relying on the shared storage state, so each also passes when run on its own
 * (`pnpm run admin:test:e2e 14-api-keys`) before the auth spec has written that
 * state.
 */
// Playwright also saves an ARIA error snapshot even with trace/screenshots off.
// This page displays a live key; failure artifacts must not capture its value.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', screenshot: 'off', video: 'off' });

let cookie = '';

test.beforeAll(async ({ request }) => {
  cookie = (await signIn(request)).cookie;
});

async function createKey(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(await adminUrl('/api/api-keys'), {
    headers: { cookie },
    data: { name },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { key: string }).key;
}

test('API keys are managed by the session and only shown once', async ({ request }) => {
  const created = await request.post(await adminUrl('/api/api-keys'), {
    headers: { cookie },
    data: { name: 'e2e-cli' },
  });
  expect(created.status()).toBe(200);
  const createdBody = (await created.json()) as { key: string; item: { id: string; prefix: string } };
  expect(/^pwk_[A-Za-z0-9_-]{43}$/.test(createdBody.key)).toBe(true);
  expect(createdBody.item.prefix === createdBody.key.slice(0, 12)).toBe(true);

  // The listing repeats metadata but never the key itself.
  const listed = await request.get(await adminUrl('/api/api-keys'), { headers: { cookie } });
  expect(listed.status()).toBe(200);
  const listing = (await listed.json()) as { items: Array<{ id: string; name: string; revoked_at: string | null }> };
  expect(
    listing.items.some(
      (item) => item.id === createdBody.item.id && item.name === 'e2e-cli' && item.revoked_at === null,
    ),
  ).toBe(true);
  expect(JSON.stringify(listing).includes(createdBody.key)).toBe(false);

  // The Bearer surface covers invocation reads and the explicit inspection allowlist.
  const key = createdBody.key;
  const invocations = await request.get(await adminUrl('/api/invocations?limit=1'), { headers: bearer(key) });
  expect(invocations.status()).toBe(200);
  const detail = await request.get(await adminUrl('/api/invocations/4001'), { headers: bearer(key) });
  expect(detail.status()).toBe(200);
  for (const source of ['active', 'file']) {
    const configuration = await request.get(await adminUrl(`/api/config/view?source=${source}`), {
      headers: bearer(key),
    });
    expect(configuration.status()).toBe(200);
    const view = (await configuration.json()) as { source: string; config: Record<string, unknown> };
    expect(view.source).toBe(source);
    expect(JSON.stringify(view.config).includes('"api_key"')).toBe(false);
    for (const scope of ['global', 'group']) {
      const query = scope === 'group' ? `source=${source}&chat=123456789` : `source=${source}`;
      const response = await request.get(await adminUrl(`/api/prompts/${scope}?${query}`), { headers: bearer(key) });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ source, scope, core_read_only: true });
    }
  }

  // It does not cover other audits, key management, or the wider session
  // surface — not even when the request also carries the session cookie.
  for (const path of ['/api/overview', '/api/messages', '/api/api-keys', '/api/config/status']) {
    const response = await request.get(await adminUrl(path), { headers: { cookie, ...bearer(key) } });
    expect(response.status(), path).toBe(403);
  }

  // Replay is not wired into the E2E fixture.
  const replay = await request.post(await adminUrl('/api/invocations/4001/replay'), {
    headers: bearer(key),
    data: { global_prompt: 'What if?' },
  });
  expect(replay.status()).toBe(503);
  expect(((await replay.json()) as { error: string }).error).toBe('replay_unavailable');

  // Revocation via the session disables the key on its next use.
  const revoked = await request.delete(await adminUrl(`/api/api-keys/${createdBody.item.id}`), {
    headers: { cookie },
  });
  expect(revoked.status()).toBe(200);
  const afterRevoke = await request.get(await adminUrl('/api/invocations'), { headers: bearer(key) });
  expect(afterRevoke.status()).toBe(401);
  const relisted = (await (await request.get(await adminUrl('/api/api-keys'), { headers: { cookie } })).json()) as {
    items: Array<{ id: string; revoked_at: string | null }>;
  };
  expect(relisted.items.some((item) => item.id === createdBody.item.id && typeof item.revoked_at === 'string')).toBe(
    true,
  );
});

test('a present Authorization header never falls back to the session cookie', async ({ request }) => {
  const garbage = await request.get(await adminUrl('/api/invocations'), {
    headers: { cookie, ...bearer('pwk_not-a-real-key') },
  });
  expect(garbage.status()).toBe(401);

  // A valid key plus the cookie is still restricted to inspection and invocation routes.
  const key = await createKey(request, 'e2e-boundary');
  const upgraded = await request.get(await adminUrl('/api/memories'), { headers: { cookie, ...bearer(key) } });
  expect(upgraded.status()).toBe(403);

  // The session cookie itself is still intact.
  const session = await request.get(await adminUrl('/api/invocations'), { headers: { cookie } });
  expect(session.status()).toBe(200);
});
