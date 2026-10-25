import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '@node-rs/argon2';
import { parseCli } from '../../src/cli-options.ts';
import { AdminAuth } from '../../src/ingress/admin/auth.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ServeLock, SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { writeTestConfig } from '../helpers.ts';

const BIN = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[], stdin?: string, endStdin = true): Promise<CliResult> {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    if (endStdin) {
      child.stdin.end();
    }
  });
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ configPath: string; dataDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-account-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { configPath, dataDir: join(directory, 'data') };
}

const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';
const NEW_USERNAME = 'renamed-admin';

function soleUserId(store: SqliteStore): bigint {
  const row = store.db.prepare<[], { id: bigint }>('SELECT id FROM admin_users').get();
  if (row === undefined) {
    throw new Error('admin_users is empty');
  }
  return row.id;
}

function sessionCount(store: SqliteStore, userId: bigint): bigint {
  return store.db
    .prepare<[bigint], { count: bigint }>('SELECT count(*) AS count FROM admin_sessions WHERE user_id = ?')
    .get(userId)!.count;
}

function passkeyCount(store: SqliteStore, userId: bigint): bigint {
  return store.db
    .prepare<[bigint], { count: bigint }>('SELECT count(*) AS count FROM admin_passkeys WHERE user_id = ?')
    .get(userId)!.count;
}

function addPasskeys(store: SqliteStore, userId: bigint): void {
  const insert = store.db.prepare(
    `INSERT INTO admin_passkeys (user_id, credential_id, public_key, counter, rp_id, name, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  insert.run(userId, 'credential-1', 'public-key-1', 0, 'localhost', 'test-key-1', new Date().toISOString());
  insert.run(userId, 'credential-2', 'public-key-2', 0, 'localhost', 'test-key-2', new Date().toISOString());
}

function addApiKey(store: SqliteStore): void {
  store.db
    .prepare('INSERT INTO admin_api_keys (name, prefix, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('account-fixture', 'fixture', 'fixture-token-digest', new Date().toISOString());
}

async function passwordHash(store: SqliteStore): Promise<string> {
  const row = store.db.prepare<[], { password_hash: string | null }>('SELECT password_hash FROM admin_users').get();
  if (row?.password_hash == null) {
    throw new Error('admin_users has no password hash');
  }
  return row.password_hash;
}

describe('admin-account parseCli contract', () => {
  test('parses username, password-stdin and revoke-passkeys for admin-account', () => {
    const options = parseCli([
      'admin-account',
      '--config',
      'dev-data/config.jsonc',
      '--username',
      'admin',
      '--password-stdin',
      '--revoke-passkeys',
    ]);
    expect(options.command).toBe('admin-account');
    expect(options.configPath).toBe('dev-data/config.jsonc');
    expect(options.username).toBe('admin');
    expect(options.passwordStdin).toBe(true);
    expect(options.revokePasskeys).toBe(true);
  });

  test('admin-account without a username is rejected', () => {
    expect(() => parseCli(['admin-account', '--config', 'dev-data/config.jsonc'])).toThrow();
  });

  test('admin-account without --config is rejected', () => {
    expect(() => parseCli(['admin-account', '--username', 'admin'])).toThrow();
  });

  test('a username value starting with -- is rejected', () => {
    expect(() => parseCli(['admin-account', '--config', 'p', '--username', '--x'])).toThrow();
  });

  test('a duplicate username or flag is rejected', () => {
    expect(() => parseCli(['admin-account', '--config', 'p', '--username', 'a', '--username', 'b'])).toThrow();
    expect(() => parseCli(['admin-account', '--config', 'p', '--username', 'a', '--revoke-passkeys'])).not.toThrow();
    expect(() => parseCli(['admin-account', '--config', 'p', '--username', 'a', '--password-stdin'])).not.toThrow();
    expect(() =>
      parseCli(['admin-account', '--config', 'p', '--username', 'a', '--revoke-passkeys', '--revoke-passkeys']),
    ).toThrow();
    expect(() =>
      parseCli(['admin-account', '--config', 'p', '--username', 'a', '--password-stdin', '--password-stdin']),
    ).toThrow();
  });

  test('admin-reset is no longer a command', () => {
    expect(() => parseCli(['admin-reset', '--config', 'p', '--username', 'admin'])).toThrow();
  });

  test('--password-stdin is rejected outside admin-account', () => {
    expect(() => parseCli(['serve', '--config', 'p', '--password-stdin'])).toThrow();
    expect(() => parseCli(['doctor', '--config', 'p', '--password-stdin'])).toThrow();
  });

  test('--username and --revoke-passkeys are rejected outside admin-account', () => {
    expect(() => parseCli(['serve', '--config', 'p', '--username', 'admin'])).toThrow();
    expect(() => parseCli(['check-config', '--config', 'p', '--username', 'admin'])).toThrow();
    expect(() => parseCli(['serve', '--config', 'p', '--revoke-passkeys'])).toThrow();
    expect(() => parseCli(['backup', '--config', 'p', '--revoke-passkeys'])).toThrow();
  });

  test('existing command flags keep their boundaries', () => {
    expect(parseCli(['serve', '--config', 'p', '--takeover']).takeover).toBe(true);
    expect(() => parseCli(['backup', '--config', 'p', '--takeover'])).toThrow();
    expect(parseCli(['doctor', '--config', 'p', '--output-agent-prompt']).outputAgentPrompt).toBe(true);
    expect(() => parseCli(['serve', '--config', 'p', '--output-agent-prompt'])).toThrow();
    expect(() => parseCli(['unknown', '--config', 'p'])).toThrow();
  });
});

describe('admin-account password input safety', () => {
  test('an open stdin pipe times out without leaking input and releases the lock', async () => {
    const { configPath, dataDir } = await fixture();
    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', 'admin', '--password-stdin'],
      NEW_PASSWORD,
      false,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Timed out waiting');
    expect(result.stdout + result.stderr).not.toContain(NEW_PASSWORD);
    await expect(access(join(dataDir, 'serve.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  test('non-TTY stdin without --password-stdin fails immediately', async () => {
    const { configPath } = await fixture();
    const result = await runCli(['admin-account', '--config', configPath, '--username', 'admin']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--password-stdin');
  }, 60_000);

  test('stdin passwords over 800 bytes are rejected before any account is written', async () => {
    const { configPath } = await fixture();
    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', 'admin', '--password-stdin'],
      `${'x'.repeat(801)}\n`,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('800 bytes');
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    try {
      expect(store.db.prepare('SELECT count(*) FROM admin_users').get()).toEqual({ 'count(*)': 0n });
    } finally {
      store.close();
    }
  }, 60_000);
});

describe('admin-account flow', () => {
  test('creates the administrator when the table is empty, without a session', async () => {
    const { configPath, dataDir } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    addApiKey(store);
    const apiKeysBefore = store.db.prepare('SELECT * FROM admin_api_keys').all();
    store.close();

    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', 'founder', '--password-stdin'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('create');
    expect(result.stderr).toContain('kept');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', username: 'founder', created: true });
    await expect(access(join(dataDir, 'serve.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

    const reopened = await SqliteStore.open(loaded.config);
    try {
      const row = reopened.db.prepare<[], { username: string }>('SELECT username FROM admin_users').get();
      expect(row).toEqual({ username: 'founder' });
      const userId = soleUserId(reopened);
      expect(sessionCount(reopened, userId)).toBe(0n);
      expect(passkeyCount(reopened, userId)).toBe(0n);
      expect(reopened.db.prepare('SELECT * FROM admin_api_keys').all()).toEqual(apiKeysBefore);
      expect(await verify(await passwordHash(reopened), NEW_PASSWORD)).toBe(true);
      const auth = new AdminAuth(reopened.orm, 168);
      expect(auth.setupRequired()).toBe(false);
      const token = await auth.login({ username: 'founder', password: NEW_PASSWORD });
      expect(token.length).toBeGreaterThan(0);
      expect(sessionCount(reopened, userId)).toBe(1n);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('renames and rehashes the sole administrator, revoking sessions but keeping passkeys', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    await auth.login({ username: 'admin', password: OLD_PASSWORD });
    const userId = soleUserId(store);
    expect(sessionCount(store, userId)).toBe(2n);
    addPasskeys(store, userId);
    addApiKey(store);
    const apiKeysBefore = store.db.prepare('SELECT * FROM admin_api_keys').all();
    store.close();

    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', NEW_USERNAME, '--password-stdin'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('kept');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', username: NEW_USERNAME, created: false });

    const reopened = await SqliteStore.open(loaded.config);
    try {
      const row = reopened.db
        .prepare<[], { id: bigint; username: string }>('SELECT id, username FROM admin_users')
        .get();
      expect(row).toEqual({ id: userId, username: NEW_USERNAME });
      expect(sessionCount(reopened, userId)).toBe(0n);
      expect(passkeyCount(reopened, userId)).toBe(2n);
      expect(reopened.db.prepare('SELECT * FROM admin_api_keys').all()).toEqual(apiKeysBefore);
      const hash = await passwordHash(reopened);
      expect(await verify(hash, OLD_PASSWORD)).toBe(false);
      expect(await verify(hash, NEW_PASSWORD)).toBe(true);
      const reopenedAuth = new AdminAuth(reopened.orm, 168);
      expect(reopenedAuth.setupRequired()).toBe(false);
      expect((await reopenedAuth.login({ username: NEW_USERNAME, password: NEW_PASSWORD })).length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('deletes passkeys only when --revoke-passkeys is given', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    await auth.login({ username: 'admin', password: OLD_PASSWORD });
    const userId = soleUserId(store);
    addPasskeys(store, userId);
    expect(passkeyCount(store, userId)).toBe(2n);
    store.close();

    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', NEW_USERNAME, '--password-stdin', '--revoke-passkeys'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('deleted');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', username: NEW_USERNAME, created: false });

    const reopened = await SqliteStore.open(loaded.config);
    try {
      expect(passkeyCount(reopened, userId)).toBe(0n);
      expect(sessionCount(reopened, userId)).toBe(0n);
      expect(await verify(await passwordHash(reopened), NEW_PASSWORD)).toBe(true);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('refuses while another process holds the serve lock and writes nothing', async () => {
    const { configPath, dataDir } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    await auth.login({ username: 'admin', password: OLD_PASSWORD });
    const userId = soleUserId(store);
    addPasskeys(store, userId);
    store.close();

    const lock = await ServeLock.acquire(dataDir);
    try {
      const result = await runCli(
        ['admin-account', '--config', configPath, '--username', NEW_USERNAME, '--password-stdin'],
        `${NEW_PASSWORD}\n`,
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('serve.lock');
      expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);
    } finally {
      await lock.release();
    }

    const reopened = await SqliteStore.open(loaded.config);
    try {
      expect(reopened.db.prepare<[], { username: string }>('SELECT username FROM admin_users').get()).toEqual({
        username: 'admin',
      });
      expect(sessionCount(reopened, userId)).toBe(2n);
      expect(passkeyCount(reopened, userId)).toBe(2n);
      expect(await verify(await passwordHash(reopened), OLD_PASSWORD)).toBe(true);
      expect(await verify(await passwordHash(reopened), NEW_PASSWORD)).toBe(false);
    } finally {
      reopened.close();
    }
  }, 60_000);

  test('refuses when admin_users contains more than one account and writes nothing', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const auth = new AdminAuth(store.orm, 168);
    await auth.createFirstUser({ username: 'admin', password: OLD_PASSWORD });
    const userId = soleUserId(store);
    addPasskeys(store, userId);
    const now = new Date().toISOString();
    store.db
      .prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, NULL, ?, ?)')
      .run('second-admin', now, now);
    store.close();

    const result = await runCli(
      ['admin-account', '--config', configPath, '--username', NEW_USERNAME, '--password-stdin'],
      `${NEW_PASSWORD}\n`,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('single administrator');
    expect(result.stderr + result.stdout).not.toContain(NEW_PASSWORD);

    const reopened = await SqliteStore.open(loaded.config);
    try {
      expect(reopened.db.prepare('SELECT count(*) FROM admin_users').get()).toEqual({ 'count(*)': 2n });
      expect(
        reopened.db
          .prepare<[bigint], { username: string }>('SELECT username FROM admin_users WHERE id = ?')
          .get(userId),
      ).toEqual({ username: 'admin' });
      expect(sessionCount(reopened, userId)).toBe(1n);
      expect(passkeyCount(reopened, userId)).toBe(2n);
      expect(await verify(await passwordHash(reopened), OLD_PASSWORD)).toBe(true);
    } finally {
      reopened.close();
    }
  }, 60_000);
});
