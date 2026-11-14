import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { dictionaryEntries } from '../../src/store/schema/index.ts';
import { credentialsPath } from '../../packages/cli/src/credentials.ts';
import { clientKeyPath, readClientIdentity } from '../../packages/cli/src/identity.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import {
  appStateValue,
  clientRow,
  countRows,
  installPairingHooks,
  json,
  newIdentity,
  pairingFixture,
  pairingProof,
  pairingRow,
  parseCliDocument,
  runClientBin,
  runClientCli,
  runServerCli,
  sendSigned,
} from './fixtures.ts';

installPairingHooks();

type Fixture = Awaited<ReturnType<typeof pairingFixture>>;

/** Creates a ticket through the real server CLI while `serve` is listening. */
async function createCode(fixture: Fixture, extra: readonly string[] = []): Promise<Record<string, unknown>> {
  const created = await runServerCli(fixture.configPath, [
    'pairing',
    'create',
    '--name',
    'coding-agent',
    '--mode',
    'read_write',
    ...extra,
  ]);
  expect(created.code, created.stderr).toBe(0);
  return parseCliDocument(created);
}

/** Claims a code directly, for tests that do not need the client CLI. */
async function claimDirect(fixture: Fixture, code: string, identity = newIdentity()): Promise<Response> {
  return await fetch(`${fixture.baseUrl}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, public_key: identity.publicKey, proof: pairingProof(code, identity) }),
  });
}

test('a pairing code creates a read_write client that signs its requests', async () => {
  const fixture = await pairingFixture();
  try {
    const created = await createCode(fixture);
    const code = created.code;
    const instanceId = created.instance_id;
    if (typeof code !== 'string' || typeof instanceId !== 'string') {
      throw new Error('pairing create did not print a code and instance id');
    }
    expect(code).toMatch(/^pwp_[A-Za-z0-9_-]{32}$/);
    expect(instanceId).toMatch(/^ins_[A-Za-z0-9_-]{22}$/);
    expect(created).toMatchObject({
      status: 'ok',
      pairing: {
        name: 'coding-agent',
        mode: 'read_write',
        permissions: { read_all: true, write_all: true, execute_paid_operations: false },
        public_key_fingerprint: null,
      },
      admin: { host: '127.0.0.1', port: 8899, public_url: null },
    });
    expect(created.next).toContain('surowan-utils auth pair');
    // The stored ticket is the digest, never the code.
    expect(appStateValue(fixture.store, 'admin_instance_id')).toBe(instanceId);
    const pairing = fixture.store.db.prepare<[], { code_hash: string }>('SELECT code_hash FROM admin_pairings').get();
    expect(pairing?.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(pairing?.code_hash).not.toContain(code);

    const paired = await runClientCli(fixture.home, [
      'auth',
      'pair',
      '--endpoint',
      fixture.baseUrl,
      '--code',
      code,
      '--json',
    ]);
    const document = parseCliDocument(paired);
    expect(document).toMatchObject({
      status: 'paired',
      endpoint: `${fixture.baseUrl}/`,
      instance_id: instanceId,
      name: 'coding-agent',
      mode: 'read_write',
      permissions: { read_all: true, write_all: true, execute_paid_operations: false },
    });
    expect(document.fingerprint).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
    const clientId = document.client_id;
    if (typeof clientId !== 'string') {
      throw new Error('auth pair did not return a client id');
    }
    expect(clientId).toMatch(/^[1-9][0-9]*$/);

    // Client form credentials with an exact key set; no key material in the JSON.
    expect(JSON.parse(await readFile(credentialsPath(fixture.home), 'utf8'))).toEqual({
      endpoint: `${fixture.baseUrl}/`,
      client_id: clientId,
      instance_id: instanceId,
    });
    expect(await readFile(clientKeyPath(fixture.home), 'utf8')).toContain('BEGIN PRIVATE KEY');

    const row = clientRow(fixture.store, clientId);
    expect(row).toMatchObject({ name: 'coding-agent', revoked_at: null, fingerprint: document.fingerprint });
    const consumed = pairingRow(fixture.store, String((created.pairing as { id: string }).id));
    expect(consumed?.consumed_at).toEqual(expect.any(String));
    expect(consumed?.client_id?.toString()).toBe(clientId);

    const doctor = await runClientCli(fixture.home, ['doctor', '--json']);
    expect(doctor.code).toBe(0);
    expect(parseCliDocument(doctor)).toEqual({
      status: 'ok',
      endpoint: `${fixture.baseUrl}/`,
      credential: 'client_signature',
      mode: 'read_write',
      permissions: { read_all: true, write_all: true, execute_paid_operations: false },
      credential_sources: { endpoint: 'file', credential: 'file', client_key: 'file' },
    });

    // A read panel command and a real write route both succeed.
    const list = await runClientCli(fixture.home, ['invocation', 'list', '--json']);
    expect(list.code, list.stderr).toBe(0);
    const write = await runClientCli(fixture.home, [
      'dictionary',
      'create',
      '--set',
      'term=paired-client',
      '--set',
      'definition=A client that signs its requests.',
      '--set-json',
      'aliases=[]',
      '--set',
      'scope=global',
      '--set-json',
      'chat_id=null',
      '--set-json',
      'enabled=true',
      '--json',
    ]);
    expect(write.code, write.stderr).toBe(0);
    expect(fixture.store.orm.select().from(dictionaryEntries).all()).toHaveLength(1);

    // A paid route stays out of reach for a write-only grant.
    const identity = await readClientIdentity(clientKeyPath(fixture.home));
    if (identity === undefined) {
      throw new Error('the client CLI wrote no key file');
    }
    const replay = await sendSigned(fixture.baseUrl, {
      clientId,
      instanceId,
      privateKey: identity.privateKey,
      method: 'POST',
      target: '/api/invocations/1/replay',
      body: '{}',
    });
    expect(replay.status).toBe(403);
    expect(await json(replay)).toMatchObject({ error: 'forbidden' });
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a pre-bound ticket only accepts the key it was created for', async () => {
  const fixture = await pairingFixture();
  try {
    // The published entry point, spawned: the adapter chain a real user runs.
    const init = await runClientBin(fixture.home, ['auth', 'init', '--json']);
    expect(init.code, init.stderr).toBe(0);
    const initialized = parseCliDocument(init);
    const publicKey = initialized.public_key;
    if (typeof publicKey !== 'string') {
      throw new Error('auth init did not print a public key');
    }
    expect(initialized).toMatchObject({ status: 'ok', created: true, key_file: clientKeyPath(fixture.home) });

    // Idempotent: a second run reuses the same key.
    const again = await runClientCli(fixture.home, ['auth', 'init', '--json']);
    expect(parseCliDocument(again)).toMatchObject({ created: false, public_key: publicKey });

    const created = await createCode(fixture, ['--public-key', publicKey, '--ttl-seconds', '120']);
    const code = created.code;
    if (typeof code !== 'string') {
      throw new Error('pairing create did not print a code');
    }
    expect((created.pairing as { public_key_fingerprint: string }).public_key_fingerprint).toBe(
      initialized.fingerprint,
    );

    const paired = await runClientCli(fixture.home, [
      'auth',
      'pair',
      '--endpoint',
      fixture.baseUrl,
      '--code',
      code,
      '--json',
    ]);
    expect(paired.code, paired.stderr).toBe(0);
    expect(parseCliDocument(paired)).toMatchObject({ status: 'paired', mode: 'read_write' });
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('auth status, permissions and logout follow the saved credential', async () => {
  const fixture = await pairingFixture();
  try {
    const beforeStatus = await runClientCli(fixture.home, ['auth', 'status', '--json']);
    expect(beforeStatus.code).toBe(0);
    expect(parseCliDocument(beforeStatus)).toEqual({
      status: 'not_configured',
      key_file_present: false,
      fingerprint: null,
    });
    expect((await runClientCli(fixture.home, ['auth', 'permissions', '--json'])).code).toBe(2);

    const created = await createCode(fixture);
    const code = String(created.code);
    const pair = await runClientCli(fixture.home, [
      'auth',
      'pair',
      '--endpoint',
      fixture.baseUrl,
      '--code',
      code,
      '--json',
    ]);
    expect(pair.code, pair.stderr).toBe(0);
    const paired = parseCliDocument(pair);

    // A second pairing is refused without --force and leaves the credential alone.
    const second = await createCode(fixture);
    const refused = await runClientCli(fixture.home, [
      'auth',
      'pair',
      '--endpoint',
      fixture.baseUrl,
      '--code',
      String(second.code),
      '--json',
    ]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: 'already_configured' });
    expect(JSON.parse(await readFile(credentialsPath(fixture.home), 'utf8'))).toMatchObject({
      client_id: paired.client_id,
    });

    const status = await runClientCli(fixture.home, ['auth', 'status', '--json']);
    expect(status.code).toBe(0);
    expect(parseCliDocument(status)).toEqual({
      status: 'ok',
      credential: 'client_signature',
      endpoint: `${fixture.baseUrl}/`,
      client_id: paired.client_id,
      instance_id: paired.instance_id,
      fingerprint: paired.fingerprint,
      mode: 'read_write',
      permissions: { read_all: true, write_all: true, execute_paid_operations: false },
    });

    const permissions = await runClientCli(fixture.home, ['auth', 'permissions', '--json']);
    expect(parseCliDocument(permissions)).toEqual({
      credential: 'client_signature',
      mode: 'read_write',
      permissions: { read_all: true, write_all: true, execute_paid_operations: false },
    });

    const logout = await runClientCli(fixture.home, ['auth', 'logout', '--json']);
    expect(logout.code).toBe(0);
    expect(parseCliDocument(logout)).toEqual({
      status: 'logged_out',
      removed_credentials: true,
      removed_key: true,
    });
    const afterLogout = await runClientCli(fixture.home, ['auth', 'status', '--json']);
    expect(afterLogout.code).toBe(0);
    expect(parseCliDocument(afterLogout)).toMatchObject({ status: 'not_configured', key_file_present: false });
    // Logging out is local only: the server-side client survives.
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
    expect((await runClientCli(fixture.home, ['invocation', 'list', '--json'])).code).toBe(2);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('an API key identity response keeps its shape and gains kind', async () => {
  const fixture = await pairingFixture();
  try {
    const setup = await fetch(`${fixture.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
    });
    expect(setup.status).toBe(200);
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const createdResponse = await fetch(`${fixture.baseUrl}/api/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'bearer-key', mode: 'read' }),
    });
    expect(createdResponse.status).toBe(200);
    const created = await json(createdResponse);
    const key = created.key;
    const item = created.item;
    if (typeof key !== 'string' || typeof item !== 'object' || item === null) {
      throw new Error('key creation did not return a plaintext key and item');
    }
    const identity = await fetch(`${fixture.baseUrl}/api/key`, { headers: { authorization: `Bearer ${key}` } });
    expect(identity.status).toBe(200);
    expect(await json(identity)).toEqual({
      id: (item as { id: string }).id,
      name: 'bearer-key',
      mode: 'read',
      permissions: { read_all: true, write_all: false, execute_paid_operations: false },
      kind: 'api_key',
    });
  } finally {
    await fixture.close();
  }
}, 60_000);

test('clients list and revoke act on the stored identity', async () => {
  const fixture = await pairingFixture();
  try {
    const created = await createCode(fixture);
    const pair = await runClientCli(fixture.home, [
      'auth',
      'pair',
      '--endpoint',
      fixture.baseUrl,
      '--code',
      String(created.code),
      '--json',
    ]);
    const clientId = String(parseCliDocument(pair).client_id);
    expect(clientRow(fixture.store, clientId)?.last_used_at).toBeNull();

    // One signed read records usage.
    expect((await runClientCli(fixture.home, ['invocation', 'list', '--json'])).code).toBe(0);
    const listed = await runServerCli(fixture.configPath, ['clients', 'list']);
    const document = parseCliDocument(listed);
    expect(document.status).toBe('ok');
    const items = document.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: clientId,
      name: 'coding-agent',
      revoked_at: null,
      mode: 'read_write',
      permissions: { read_all: true, write_all: true, execute_paid_operations: false },
    });
    expect(items[0]?.last_used_at).toEqual(expect.any(String));
    expect(items[0]?.fingerprint).toBe(clientRow(fixture.store, clientId)?.fingerprint);

    const revoke = await runServerCli(fixture.configPath, ['clients', 'revoke', clientId]);
    expect(revoke.code, revoke.stderr).toBe(0);
    expect(parseCliDocument(revoke)).toMatchObject({ status: 'ok' });
    expect(clientRow(fixture.store, clientId)?.revoked_at).toEqual(expect.any(String));

    // Revocation takes effect on the very next request.
    const doctor = await runClientCli(fixture.home, ['doctor', '--json']);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stderr)).toMatchObject({ error: 'unauthenticated' });

    // Revoking twice is an error, not a no-op, and the row survives as audit.
    const second = await runServerCli(fixture.configPath, ['clients', 'revoke', clientId]);
    expect(second.code).toBe(1);
    expect(JSON.parse(second.stderr)).toMatchObject({ status: 'error' });
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('pairing list shows pending tickets only and cancel invalidates a code', async () => {
  const fixture = await pairingFixture();
  try {
    const first = await createCode(fixture);
    const second = await createCode(fixture);
    expect((await claimDirect(fixture, String(first.code))).status).toBe(201);

    const listed = await runServerCli(fixture.configPath, ['pairing', 'list']);
    const document = parseCliDocument(listed);
    const items = document.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual([(second.pairing as { id: string }).id]);
    expect(listed.stdout).not.toContain(String(second.code));
    expect(listed.stdout).not.toContain(String(first.code));
    expect(items[0]).toMatchObject({ name: 'coding-agent', mode: 'read_write' });

    const pairingId = String((second.pairing as { id: string }).id);
    const canceled = await runServerCli(fixture.configPath, ['pairing', 'cancel', pairingId]);
    expect(canceled.code, canceled.stderr).toBe(0);
    expect(pairingRow(fixture.store, pairingId)?.canceled_at).toEqual(expect.any(String));
    const afterCancel = parseCliDocument(await runServerCli(fixture.configPath, ['pairing', 'list']));
    expect(afterCancel.items as unknown[]).toHaveLength(0);

    const rejected = await claimDirect(fixture, String(second.code));
    expect(rejected.status).toBe(400);
    expect(await json(rejected)).toMatchObject({ error: 'pairing_code_invalid' });

    // Cancelling twice, an unknown id or a malformed id all fail.
    for (const target of [pairingId, '999999', 'not-an-id']) {
      const again = await runServerCli(fixture.configPath, ['pairing', 'cancel', target]);
      expect(again.code, target).toBe(1);
    }
  } finally {
    await fixture.close();
  }
}, 60_000);

test('the server CLI asks for serve before using a data directory without the schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-pairing-empty-'));
  try {
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(directory, configPath, testConfigJsonc(directory));
    const result = await runServerCli(configPath, ['pairing', 'list']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain('migration 058');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('pairing create validates its flags before touching the database', async () => {
  const fixture = await pairingFixture();
  try {
    for (const args of [
      ['pairing', 'create', '--name', 'agent'],
      ['pairing', 'create', '--name', 'agent', '--mode', 'superuser'],
      ['pairing', 'create', '--mode', 'read'],
      ['pairing', 'create', '--name', 'agent', '--mode', 'read', '--ttl-seconds', '30'],
      ['pairing', 'create', '--name', 'agent', '--mode', 'read', '--public-key', 'nope'],
      ['pairing', 'list', '--name', 'agent'],
      ['clients', 'revoke'],
    ]) {
      const result = await runServerCli(fixture.configPath, args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(JSON.parse(result.stderr), args.join(' ')).toMatchObject({ status: 'error' });
    }
    expect(countRows(fixture.store, 'admin_pairings')).toBe(0);
  } finally {
    await fixture.close();
  }
}, 60_000);
