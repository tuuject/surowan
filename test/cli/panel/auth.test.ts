import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, loginPanel, PASSWORD, panelFixture, runCli, storedSession, USERNAME } from './fixtures.ts';

describe('surowan-utils panel sessions and credentials', () => {
  it('creates the first administrator from the CLI without any stored credential', async () => {
    const fixture = await panelFixture();
    try {
      const fresh = await runCli(['session', 'show', '--endpoint', fixture.baseUrl, '--json'], fixture);
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(JSON.parse(fresh.stdout)).toMatchObject({ setup_required: true, authenticated: false });

      const setup = await runCli(
        ['setup', '--endpoint', fixture.baseUrl, '--file', '-', '--json'],
        fixture,
        {},
        { stdin: JSON.stringify({ username: USERNAME, password: PASSWORD }) },
      );
      expect(setup.code, setup.stderr).toBe(0);
      // The setup route rotates in a session like any login, so it is stored.
      expect(storedSession(fixture).length).toBeGreaterThan(0);

      const after = await runCli(['session', 'show', '--json'], fixture);
      expect(after.code, after.stderr).toBe(0);
      expect(JSON.parse(after.stdout)).toMatchObject({ setup_required: false, authenticated: true });

      // One credentials file, one credential kind: mixing them is refused.
      const mixed = await runCli(
        ['login', '--endpoint', fixture.baseUrl, '--username', USERNAME, '--password', PASSWORD],
        fixture,
        { SUROWAN_API_KEY: 'pwk_synthetic' },
      );
      expect(mixed.code).toBe(2);
      expect(errorCode(mixed)).toBe('conflicting_credentials');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('logs in with the panel password and reads a session-only audit page', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      expect(setup.status).toBe(200);
      await loginPanel(fixture);

      const overview = await runCli(['overview', '--json'], fixture);
      expect(overview.code, overview.stderr).toBe(0);
      expect(JSON.parse(overview.stdout)).toMatchObject({ runtime_status: { sleeping: false } });

      // The saved credential is a session token, not an API key.
      const stored = JSON.parse(
        await readFile(join(fixture.home, '.config', 'surowan-utils', 'credentials.json'), 'utf8'),
      );
      expect(Object.keys(stored).sort()).toEqual(['endpoint', 'session']);
      expect(overview.stdout).not.toContain(stored.session);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('keeps API keys on the narrow surface and refuses panel writes with one', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      const cookie = setup.headers.getSetCookie()[0] ?? '';
      const created = await fetch(`${fixture.baseUrl}/api/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'cli' }),
      });
      const key = (await created.json()) as { key: string };

      const env = { SUROWAN_ENDPOINT: fixture.baseUrl, SUROWAN_API_KEY: key.key };
      const harness = await runCli(['harness', 'show', '--json'], fixture, env);
      expect(harness.code).toBe(1);
      expect(errorCode(harness)).toBe('forbidden');

      // The same key still reaches the inspection allowlist it was issued for.
      const models = await runCli(['models', 'list', '--json'], fixture, env);
      expect(models.code, models.stderr).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('persists the rotated session after a credential change and clears it on logout', async () => {
    const fixture = await panelFixture();
    try {
      const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      expect(setup.status).toBe(200);
      await loginPanel(fixture);
      const storedPath = join(fixture.home, '.config', 'surowan-utils', 'credentials.json');
      const first = JSON.parse(await readFile(storedPath, 'utf8')) as { session: string };

      // Changing the password revokes every session and issues a new token.
      const changed = await runCli(
        ['account', 'update', '--set', `username=${USERNAME}`, '--set', `password=${'{{SECRET_9hgm2vkd}}'}`, '--json'],
        fixture,
      );
      expect(changed.code, changed.stderr).toBe(0);
      const second = JSON.parse(await readFile(storedPath, 'utf8')) as { session: string };
      expect(second.session).not.toBe(first.session);
      expect(changed.stdout).not.toContain(second.session);

      // The new token is the one that works; the old one is dead.
      const overview = await runCli(['overview', '--json'], fixture);
      expect(overview.code, overview.stderr).toBe(0);
      const stale = await runCli(['overview', '--json'], fixture, { SUROWAN_SESSION: first.session });
      expect(stale.code).toBe(1);
      expect(errorCode(stale)).toBe('unauthenticated');

      const logout = await runCli(['logout', '--json'], fixture);
      expect(logout.code, logout.stderr).toBe(0);
      await expect(readFile(storedPath, 'utf8')).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('passes the exact-Origin check of the passkey and password routes', async () => {
    const fixture = await panelFixture({ publicUrl: true });
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      // A passkey can only be registered by a browser authenticator, so two
      // rows for this website stand in for it.
      const insert = fixture.store.db.prepare(
        `INSERT INTO admin_passkeys (user_id, credential_id, public_key, counter, rp_id, name, created_at)
         SELECT id, ?, 'cGs', 0, 'localhost', ?, ? FROM admin_users`,
      );
      const createdAt = new Date().toISOString();
      insert.run('credential-a', 'Laptop', createdAt);
      insert.run('credential-b', 'Phone', createdAt);

      // The password route rotates the session; the stored one must keep working.
      const password = await runCli(['password', 'delete', '--yes', '--json'], fixture);
      expect(password.code, password.stderr).toBe(0);
      const listed = await runCli(['passkey', 'list', '--json'], fixture);
      expect(listed.code, listed.stderr).toBe(0);
      const keys = JSON.parse(listed.stdout) as { items: readonly { id: string }[]; has_password: boolean };
      expect(keys.has_password).toBe(false);
      expect(keys.items).toHaveLength(2);

      const removed = await runCli(['passkey', 'delete', keys.items[0]?.id ?? '', '--yes', '--json'], fixture);
      expect(removed.code, removed.stderr).toBe(0);
      const after = await runCli(['passkey', 'list', '--json'], fixture);
      expect((JSON.parse(after.stdout) as { items: readonly unknown[] }).items).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('leaves the stored credential alone when a supplied session is rotated or ended', async () => {
    const fixture = await panelFixture();
    try {
      await fetch(`${fixture.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      await loginPanel(fixture);
      const storedPath = join(fixture.home, '.config', 'surowan-utils', 'credentials.json');
      const stored = await readFile(storedPath, 'utf8');
      // A second browser-style login yields a token the file knows nothing about.
      const signIn = async (): Promise<string> => {
        const response = await fetch(`${fixture.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        });
        return response.headers.getSetCookie()[0]?.split(';')[0]?.split('=')[1] ?? '';
      };

      const logout = await runCli(['logout', '--json'], fixture, { SUROWAN_SESSION: await signIn() });
      expect(logout.code, logout.stderr).toBe(0);
      expect(await readFile(storedPath, 'utf8')).toBe(stored);
      const stillValid = await runCli(['overview', '--json'], fixture);
      expect(stillValid.code, stillValid.stderr).toBe(0);

      const changed = await runCli(
        ['account', 'update', '--set', `username=${USERNAME}`, '--set', 'password=another-horse-battery', '--json'],
        fixture,
        { SUROWAN_SESSION: await signIn() },
      );
      expect(changed.code, changed.stderr).toBe(0);
      expect(JSON.parse(changed.stderr)).toMatchObject({ warning: 'session_not_stored' });
      expect(await readFile(storedPath, 'utf8')).toBe(stored);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
