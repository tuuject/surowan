/**
 * Admin authentication: first-run setup, login, lockout, body limits and
 * session cookie hardening.
 */
import { expect, test } from 'vitest';
import { AdminAuth } from '../../src/ingress/admin/auth.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie } from './fixtures.ts';

test('admin panel demands first-run setup, then authenticates and revokes sessions', async () => {
  const { store, server } = await fixture();
  try {
    const initial = await readJson(await server.handle(request('/api/auth/session')));
    expect(initial).toEqual({
      setup_required: true,
      authenticated: false,
      username: null,
      expires_at: null,
      passkeys_enabled: false,
      has_password: null,
    });

    const unauthenticated = await server.handle(request('/api/invocations'));
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toMatchObject({ error: 'unauthenticated' });

    const weak = await server.handle(post('/api/auth/setup', { username: 'owner', password: 'short' }));
    expect(weak.status).toBe(400);
    expect(await readJson(weak)).toMatchObject({ error: 'invalid_password' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_users').get()?.count).toBe(0n);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    expect(created.status).toBe(200);
    const cookie = sessionCookie(created);
    expect(created.headers.get('set-cookie')).toContain('HttpOnly');
    expect(created.headers.get('set-cookie')).toContain('SameSite=Strict');

    const repeat = await server.handle(post('/api/auth/setup', { username: 'other', password: PASSWORD }));
    expect(repeat.status).toBe(409);
    expect(await readJson(repeat)).toMatchObject({ error: 'setup_complete' });

    const session = await readJson(await server.handle(request('/api/auth/session', { headers: { cookie } })));
    expect(session).toMatchObject({ setup_required: false, authenticated: true, username: 'owner' });

    const authorized = await server.handle(request('/api/invocations', { headers: { cookie } }));
    expect(authorized.status).toBe(200);
    expect(await readJson(authorized)).toEqual({ items: [], next_cursor: null });

    expect((await server.handle(post('/api/auth/logout', {}, cookie))).status).toBe(200);
    const afterLogout = await server.handle(request('/api/invocations', { headers: { cookie } }));
    expect(afterLogout.status).toBe(401);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_sessions').get()?.count).toBe(
      0n,
    );
  } finally {
    store.close();
  }
});

test('five consecutive username/password failures raise one warning that resets on success', async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    const call = (path: string, init: RequestInit = {}) =>
      server.handle(
        request(`/api${path}`, {
          ...init,
          headers: { cookie, origin: 'http://127.0.0.1:8899', ...init.headers },
        }),
      );

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failed = await server.handle(post('/api/auth/login', { username: 'x', password: PASSWORD }));
      expect(failed.status).toBe(401);
    }
    expect(await readJson(await call('/warnings?unread=1'))).toMatchObject({ items: [], unread_count: 0 });

    const fifth = await server.handle(post('/api/auth/login', { username: 'x', password: PASSWORD }));
    expect(fifth.status).toBe(401);
    const warned = await readJson(await call('/warnings?unread=1'));
    expect(warned.items).toHaveLength(1);
    expect(warned.items[0]).toMatchObject({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5 },
    });

    expect((await server.handle(post(`/api/warnings/${String(warned.items[0].id)}/read`, {}, cookie))).status).toBe(
      200,
    );
    const loggedIn = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(loggedIn.status).toBe(200);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await server.handle(post('/api/auth/login', { username: 'x', password: PASSWORD }));
    }
    expect(await readJson(await call('/warnings?unread=1'))).toMatchObject({ items: [], unread_count: 0 });

    await server.handle(post('/api/auth/login', { username: 'x', password: PASSWORD }));
    const again = await readJson(await call('/warnings?unread=1'));
    expect(again.items).toHaveLength(1);
    expect(again.items[0]).toMatchObject({ code: 'admin_login_failures' });
  } finally {
    store.close();
  }
});

test('admin login persists only hashes and rejects invalid credentials', async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    const token = cookie.slice(cookie.indexOf('=') + 1);

    const stored = store.db.prepare<[], { password_hash: string }>('SELECT password_hash FROM admin_users').get();
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored?.password_hash).not.toContain(PASSWORD);
    const sessionRow = store.db.prepare<[], { token_hash: string }>('SELECT token_hash FROM admin_sessions').get();
    expect(sessionRow?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionRow?.token_hash).not.toBe(token);

    const wrongPassword = await server.handle(
      post('/api/auth/login', { username: 'owner', password: 'wrong-password-value' }),
    );
    expect(wrongPassword.status).toBe(401);
    expect(await readJson(wrongPassword)).toMatchObject({ error: 'invalid_credentials' });
    const unknownUser = await server.handle(post('/api/auth/login', { username: 'ghost', password: PASSWORD }));
    expect(unknownUser.status).toBe(401);
    expect(await readJson(unknownUser)).toMatchObject({ error: 'invalid_credentials' });

    const loggedIn = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(loggedIn.status).toBe(200);
    const second = sessionCookie(loggedIn);
    expect(second).not.toBe(cookie);
    expect((await server.handle(request('/api/auth/session', { headers: { cookie: second } }))).status).toBe(200);
    expect(
      store.db.prepare<[], { last_login_at: string | null }>('SELECT last_login_at FROM admin_users').get()
        ?.last_login_at,
    ).not.toBeNull();

    const crossOrigin = await server.handle(
      request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ username: 'owner', password: PASSWORD }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });
  } finally {
    store.close();
  }
});

test('the login lockout cannot be dodged by rotating X-Forwarded-For or usernames', async () => {
  const { store, server } = await fixture();
  try {
    await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await server.handle(
        request('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${attempt}` },
          body: JSON.stringify({ username: `guess${attempt}`, password: 'wrong-password-value' }),
        }),
      );
      expect(failed.status).toBe(401);
    }
    const locked = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(await readJson(locked)).toMatchObject({ error: 'too_many_attempts' });
    // Another transport peer has its own bucket.
    expect(
      (await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }), '198.51.100.7')).status,
    ).toBe(200);
  } finally {
    store.close();
  }
}, 30_000);

test('concurrent failures all count, and an expired lockout starts a fresh count', async () => {
  const { store } = await fixture();
  try {
    const auth = new AdminAuth(store.orm, 12);
    const start = new Date('2026-09-26T00:00:00.000Z');
    await auth.createFirstUser({ username: 'owner', password: PASSWORD }, start);
    const wrong = (at: Date) => auth.login({ username: 'owner', password: 'wrong-password-value' }, at, 'peer');
    // Two at once used to compute the same next count from one snapshot.
    await Promise.allSettled([wrong(start), wrong(start)]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(wrong(start)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(auth.login({ username: 'owner', password: PASSWORD }, start, 'peer')).rejects.toMatchObject({
      code: 'too_many_attempts',
    });

    // After the lockout the count starts over instead of re-locking on the
    // very next mistake.
    const later = new Date(start.getTime() + 15 * 60_000 + 1);
    await expect(wrong(later)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(wrong(later)).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(typeof (await auth.login({ username: 'owner', password: PASSWORD }, later, 'peer'))).toBe('string');
  } finally {
    store.close();
  }
}, 30_000);

test('request bodies are limited by bytes as they stream in', async () => {
  const { store, server } = await fixture();
  try {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4_096).fill(0x20));
      },
    });
    const chunked = await server.handle(
      request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: endless,
        duplex: 'half',
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(10);

    // 3,000 three-byte characters are ~9 KiB but only ~3,000 UTF-16 units.
    const multibyte = await server.handle(post('/api/auth/login', { username: '\u4e2d'.repeat(3_000), password: 'x' }));
    expect(multibyte.status).toBe(413);
  } finally {
    store.close();
  }
});

test('session cookies are Secure when the browser is on HTTPS', async () => {
  const { store, server } = await fixture();
  try {
    const plain = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    expect(plain.headers.get('set-cookie')).not.toContain('Secure');

    // Behind a TLS-terminating proxy only the Origin shows the page is on HTTPS.
    const https = (path: string, body: unknown): Request =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://127.0.0.1:8899' },
        body: JSON.stringify(body),
      });
    const login = await server.handle(https('/api/auth/login', { username: 'owner', password: PASSWORD }));
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/; Secure(;|$)/);
    const logout = await server.handle(https('/api/auth/logout', {}));
    expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(logout.headers.get('set-cookie')).toContain('Secure');
  } finally {
    store.close();
  }
});

test('login verifies a legacy Bun.password hash with the argon2 runtime', async () => {
  const { store, server } = await fixture();
  try {
    // PHC fixture generated by Bun 1.4.0 with
    // `Bun.password.hash('legacy-admin-passphrase', { algorithm: 'argon2id' })`.
    // Accounts created before the @node-rs/argon2 switch must keep logging in.
    const legacyHash =
      '$argon2id$v=19$m=65536,t=2,p=1$qqFrECrTOHeD0MZPyFSrw5qy1PwJmdOjo25xGu12zo0$xBM+zfhLz2zdpwT8CwseqbDa0Y9/3K4B7RRxYwmSzEc';
    const now = new Date().toISOString();
    store.db
      .prepare(
        'INSERT INTO admin_users (username, password_hash, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy', legacyHash, now, now, now);

    const ok = await server.handle(
      post('/api/auth/login', { username: 'legacy', password: 'legacy-admin-passphrase' }),
    );
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({ status: 'ok' });

    const wrong = await server.handle(
      post('/api/auth/login', { username: 'legacy', password: 'not-the-legacy-passphrase' }),
    );
    expect(wrong.status).toBe(401);
    expect(await readJson(wrong)).toMatchObject({ error: 'invalid_credentials' });
  } finally {
    store.close();
  }
});

test('admin can change username and password from an authenticated session', async () => {
  const { store, server } = await fixture();
  try {
    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    const otherLogin = await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }));
    const otherCookie = sessionCookie(otherLogin);
    const updated = await server.handle(
      post('/api/auth/credentials', { username: 'new-owner', password: 'new-correct-horse-battery' }, cookie),
    );
    expect(updated.status).toBe(200);
    const refreshedCookie = sessionCookie(updated);
    expect(refreshedCookie).not.toBe(cookie);

    const currentSession = await readJson(
      await server.handle(request('/api/auth/session', { headers: { cookie: refreshedCookie } })),
    );
    expect(currentSession).toMatchObject({ authenticated: true, username: 'new-owner' });
    expect((await server.handle(request('/api/invocations', { headers: { cookie: otherCookie } }))).status).toBe(401);
    expect((await server.handle(post('/api/auth/login', { username: 'owner', password: PASSWORD }))).status).toBe(401);
    expect(
      (await server.handle(post('/api/auth/login', { username: 'new-owner', password: 'new-correct-horse-battery' })))
        .status,
    ).toBe(200);

    const stored = store.db
      .prepare<[], { username: string; password_hash: string }>('SELECT username, password_hash FROM admin_users')
      .get();
    expect(stored?.username).toBe('new-owner');
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored?.password_hash).not.toContain('new-correct-horse-battery');
  } finally {
    store.close();
  }
});
