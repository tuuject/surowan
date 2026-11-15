import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { credentialsPath } from '../../packages/cli/src/credentials.ts';
import { clientKeyPath, ensureClientIdentity, readClientIdentity } from '../../packages/cli/src/identity.ts';
import { runCli } from '../../packages/cli/src/run.ts';
import {
  countRows,
  installPairingHooks,
  json,
  makeScratchDirectory,
  newIdentity,
  pairingFixture,
  pairingProof,
  parseCliDocument,
  runClientCli,
  runServerCli,
} from './fixtures.ts';
import { createAdminAccount } from '../fixtures/admin-account.ts';

installPairingHooks();

test('concurrent key creation converges on the key that is on disk', async () => {
  const directory = await makeScratchDirectory('surowan-identity-race-');
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const keyPath = clientKeyPath(home);
  const attempts = await Promise.all(Array.from({ length: 5 }, () => ensureClientIdentity(keyPath)));
  const publicKeys = new Set(attempts.map((attempt) => attempt.identity.publicKey));
  expect(publicKeys.size).toBe(1);
  // Exactly one call claims creation; the rest adopt the winner.
  expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
  const onDisk = await readClientIdentity(keyPath);
  expect(onDisk?.publicKey).toBe(attempts[0]?.identity.publicKey);
  // No temporary files leak into the directory.
  expect((await readdir(dirname(keyPath))).sort()).toEqual(['client-key.pem']);
  // A later call is idempotent and never replaces the stored key.
  const again = await ensureClientIdentity(keyPath);
  expect(again.created).toBe(false);
  expect(again.identity.publicKey).toBe(onDisk?.publicKey);
}, 60_000);

test('auth status and permissions honour explicit credentials over the file', async () => {
  const fixture = await pairingFixture();
  try {
    // Panel session + API key, so a credential exists that is not a paired client.
    await createAdminAccount(fixture.store.orm, { username: 'owner', password: 'regression-panel-password' });
    const setup = await fetch(`${fixture.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'regression-panel-password' }),
    });
    expect(setup.status).toBe(200);
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const createdResponse = await fetch(`${fixture.baseUrl}/api/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'status-key', mode: 'read' }),
    });
    const created = await json(createdResponse);
    const key = created.key;
    if (typeof key !== 'string') {
      throw new Error('key creation did not return a plaintext key');
    }

    // Nothing saved anywhere.
    const empty = await runClientCli(fixture.home, ['auth', 'status', '--json']);
    expect(empty.code).toBe(0);
    expect(parseCliDocument(empty)).toMatchObject({ status: 'not_configured' });

    // Explicit endpoint + key, no saved file: still a valid status.
    const status = await runClientCli(fixture.home, [
      'auth',
      'status',
      '--endpoint',
      fixture.baseUrl,
      '--api-key',
      key,
      '--json',
    ]);
    expect(status.code, status.stderr).toBe(0);
    expect(parseCliDocument(status)).toEqual({
      status: 'ok',
      credential: 'api_key',
      endpoint: `${fixture.baseUrl}/`,
      mode: 'read',
      permissions: { read_all: true, write_all: false, execute_paid_operations: false },
    });

    const permissions = await runClientCli(fixture.home, [
      'auth',
      'permissions',
      '--endpoint',
      fixture.baseUrl,
      '--api-key',
      key,
      '--json',
    ]);
    expect(permissions.code, permissions.stderr).toBe(0);
    expect(parseCliDocument(permissions)).toEqual({
      credential: 'api_key',
      mode: 'read',
      permissions: { read_all: true, write_all: false, execute_paid_operations: false },
    });

    // A damaged file must not block an explicitly supplied pair.
    const path = credentialsPath(fixture.home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, 'not json {', { mode: 0o600 });
    const explicit = await runClientCli(fixture.home, [
      'auth',
      'status',
      '--endpoint',
      fixture.baseUrl,
      '--api-key',
      key,
      '--json',
    ]);
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(parseCliDocument(explicit)).toMatchObject({ status: 'ok', credential: 'api_key' });

    // Environment variables take the same path as flags.
    const envOutput = { stdout: '', stderr: '' };
    const envCode = await runCli(['auth', 'status', '--json'], {
      homeDir: fixture.home,
      env: { SUROWAN_ENDPOINT: fixture.baseUrl, SUROWAN_API_KEY: key },
      io: {
        stdout: (text) => {
          envOutput.stdout += text;
        },
        stderr: (text) => {
          envOutput.stderr += text;
        },
      },
    });
    expect(envCode, envOutput.stderr).toBe(0);
    expect(JSON.parse(envOutput.stdout)).toMatchObject({ status: 'ok', credential: 'api_key', mode: 'read' });

    // Without both explicit, the file is consulted and its damage is reported.
    const damaged = await runClientCli(fixture.home, ['auth', 'status', '--api-key', key, '--json']);
    expect(damaged.code).toBe(1);
    expect(JSON.parse(damaged.stderr)).toMatchObject({ error: 'invalid_credentials' });
  } finally {
    await fixture.close();
  }
}, 60_000);

test('auth-only flags are refused on every other command', async () => {
  const directory = await makeScratchDirectory('surowan-auth-flags-');
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const io = { stdout: '', stderr: '' };
  const run = async (argv: readonly string[]): Promise<{ readonly code: number; readonly stderr: string }> => {
    io.stdout = '';
    io.stderr = '';
    const code = await runCli(argv, {
      homeDir: home,
      env: {},
      io: {
        stdout: (text) => {
          io.stdout += text;
        },
        stderr: (text) => {
          io.stderr += text;
        },
      },
    });
    return { code, stderr: io.stderr };
  };
  for (const argv of [
    ['login', '--force', '--endpoint', 'http://127.0.0.1:1', '--api-key', 'k'],
    ['doctor', '--code', 'pwp_test'],
    ['invocation', 'replay', '1', '--force'],
    ['chat', 'list', '--force'],
    ['auth', 'status', '--code', 'pwp_test'],
    ['auth', 'pair', '--endpoint', 'http://127.0.0.1:1'],
  ]) {
    const result = await run(argv);
    expect(result.code, argv.join(' ')).toBe(2);
    expect(JSON.parse(result.stderr), argv.join(' ')).toMatchObject({
      error: expect.stringMatching(/unexpected|missing/),
    });
  }
}, 60_000);

test('a non-canonical key spelling is refused everywhere', async () => {
  const fixture = await pairingFixture();
  try {
    const identity = newIdentity();
    const canonical = identity.publicKey;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = canonical.length - 1;
    const nonCanonical = `${canonical.slice(0, last)}${alphabet.charAt(alphabet.indexOf(canonical.charAt(last)) | 1 || 0)}`;
    expect(nonCanonical).not.toBe(canonical);
    expect(nonCanonical).toHaveLength(43);

    // The server refuses to bind any ticket to it.
    const ticket = await runServerCli(fixture.configPath, [
      'pairing',
      'create',
      '--name',
      'non-canonical',
      '--mode',
      'read',
      '--public-key',
      nonCanonical,
    ]);
    expect(ticket.code).toBe(1);
    expect(JSON.parse(ticket.stderr)).toMatchObject({ status: 'error' });
    expect(countRows(fixture.store, 'admin_pairings')).toBe(0);

    // A claim body with the non-canonical spelling is rejected as invalid, and
    // the ticket survives for the canonical key.
    const created = await runServerCli(fixture.configPath, [
      'pairing',
      'create',
      '--name',
      'canonical',
      '--mode',
      'read_write',
    ]);
    const code = String(parseCliDocument(created).code);
    const bad = await fetch(`${fixture.baseUrl}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        public_key: nonCanonical,
        proof: pairingProof(code, { ...identity, publicKey: nonCanonical }),
      }),
    });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: 'invalid_body' });
    expect(countRows(fixture.store, 'admin_clients')).toBe(0);

    const good = await fetch(`${fixture.baseUrl}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, public_key: canonical, proof: pairingProof(code, identity) }),
    });
    expect(good.status).toBe(201);
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('the server CLI starts nothing when the database file does not exist', async () => {
  const directory = await makeScratchDirectory('surowan-no-database-');
  const { testConfigJsonc, writeTestConfig } = await import('../helpers.ts');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory));
  const database = join(directory, 'surowan.sqlite');
  for (const args of [
    ['pairing', 'list'],
    ['clients', 'list'],
  ]) {
    const result = await runServerCli(configPath, args);
    expect(result.code, args.join(' ')).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.status).toBe('error');
    expect(error.error).toContain('start (or restart) `serve`');
    // The CLI must not leave an empty database behind: `serve` would treat it
    // as an existing one and skip (or misread) its first migration.
    await expect(access(database)).rejects.toThrow();
  }
}, 60_000);

test('pairing create hints at the loopback tunnel or the public URL', async () => {
  // Bind on all interfaces but keep the hint loopback: the config host is not
  // a URL a client may use for plaintext HTTP.
  const loopback = await pairingFixture({ bindHost: '0.0.0.0' });
  try {
    const created = await runServerCli(loopback.configPath, [
      'pairing',
      'create',
      '--name',
      'tunnel',
      '--mode',
      'read',
    ]);
    const document = parseCliDocument(created);
    expect(document.next).toContain('--endpoint http://127.0.0.1:8899/');
    expect(document.admin).toMatchObject({ host: '0.0.0.0', port: 8899, public_url: null });
  } finally {
    await loopback.close();
  }

  const publicUrl = 'https://panel.example.com/';
  const exposed = await pairingFixture({ publicUrl });
  try {
    const created = await runServerCli(exposed.configPath, ['pairing', 'create', '--name', 'public', '--mode', 'read']);
    const document = parseCliDocument(created);
    expect(document.next).toContain(`--endpoint ${publicUrl}`);
    expect(document.admin).toMatchObject({ public_url: publicUrl });
  } finally {
    await exposed.close();
  }
}, 60_000);
