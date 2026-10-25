import { expect, test } from 'vitest';
import { createApiKey } from '../../src/ingress/admin/api-keys.ts';
import { adminPublicOrigin } from '../../src/platform/config/semantics.ts';
import { fixture, installAdminPasskeyHooks, req } from './passkeys-fixtures.ts';

installAdminPasskeyHooks();

test('public URL is opt-in and validates secure canonical origins', async () => {
  for (const value of [
    'https://example.com',
    'https://example.com/',
    'https://example.com:8443',
    'http://localhost:1234',
  ]) {
    expect(adminPublicOrigin(value)).toBe(new URL(value).origin);
  }
  for (const value of [
    'http://127.0.0.1:1234',
    'https://127.0.0.1',
    'https://192.0.2.1',
    'http://[::1]:1234',
    'https://[::1]',
    'https://[2001:db8::1]',
    'http://example.com',
    'ftp://example.com',
    'https://a:b@example.com',
    'https://example.com/path',
    'https://example.com?q=x',
    'https://example.com/#x',
    'bad',
    ' https://example.com',
    'https://example.com/?',
    'https://example.com/#',
  ]) {
    expect(() => adminPublicOrigin(value)).toThrow('admin.public_url');
  }
  const f = await fixture(false);
  expect(await (await f.server.handle(req('session', 'GET', f.cookie))).json()).toMatchObject({
    passkeys_enabled: false,
    has_password: true,
  });
  expect((await f.server.handle(req('passkeys/login/options', 'POST', '', {}, 'http://127.0.0.1:8899'))).status).toBe(
    404,
  );
  expect((await f.server.handle(req('password', 'DELETE', f.cookie, {}, 'http://127.0.0.1:8899'))).status).toBe(404);
});

test('enforces configured origin, session-only management, bearer exclusion and bounded bodies', async () => {
  const f = await fixture();
  for (const source of [null, 'https://evil.test', 'http://example.com', 'https://example.com:8443']) {
    expect((await f.server.handle(req('passkeys/login/options', 'POST', '', {}, source))).status).toBe(403);
  }
  for (const path of ['setup', 'login', 'passkeys/login/options']) {
    const rejected = await f.server.handle(req(path, 'POST', '', {}, 'https://example.com:8443'));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      error: 'bad_origin',
      message: expect.stringContaining('admin.public_url'),
    });
  }
  expect((await f.server.handle(req('passkeys/register/options'))).status).toBe(401);
  const apiKey = createApiKey(f.store.orm, 'fixture');
  const bearer = req('passkeys/register/options', 'POST', f.cookie);
  bearer.headers.set('authorization', `Bearer ${apiKey.key}`);
  expect((await f.server.handle(bearer)).status).toBe(403);
  const oversized = req('passkeys/login/verify', 'POST', '', { junk: 'x'.repeat(70_000) });
  expect((await f.server.handle(oversized)).status).toBe(413);
});
