import { chmodSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { credentialsPath } from '../../packages/cli/src/credentials.ts';
import { clientKeyPath, readClientIdentity } from '../../packages/cli/src/identity.ts';
import {
  allRowsText,
  claimPairing,
  cliOutput,
  clientRow,
  countRows,
  installPairingHooks,
  json,
  newIdentity,
  pairingFixture,
  pairingProof,
  pairingRow,
  parseCliDocument,
  runClientCli,
  runServerCli,
  sendSigned,
  signatureHeader,
} from './fixtures.ts';

installPairingHooks();

type Fixture = Awaited<ReturnType<typeof pairingFixture>>;

async function createTicket(fixture: Fixture, extra: readonly string[] = []): Promise<Record<string, unknown>> {
  const created = await runServerCli(fixture.configPath, [
    'pairing',
    'create',
    '--name',
    'security-agent',
    '--mode',
    'read_write',
    ...extra,
  ]);
  expect(created.code, created.stderr).toBe(0);
  return parseCliDocument(created);
}

/** Pairs the client CLI and returns the ids and code a signed request needs. */
async function pairClient(fixture: Fixture): Promise<{
  readonly clientId: string;
  readonly instanceId: string;
  readonly code: string;
  readonly fingerprint: string;
}> {
  const created = await createTicket(fixture);
  const code = String(created.code);
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
  const document = parseCliDocument(paired);
  return {
    clientId: String(document.client_id),
    instanceId: String(document.instance_id),
    code,
    fingerprint: String(document.fingerprint),
  };
}

test('expired and reused pairing codes fail with stable codes', async () => {
  const fixture = await pairingFixture();
  try {
    const expired = await createTicket(fixture);
    // An always-past expiry, so this can never become a time bomb.
    fixture.store.db
      .prepare('UPDATE admin_pairings SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', BigInt(String((expired.pairing as { id: string }).id)));
    const identity = newIdentity();
    const expiredResponse = await claimPairing(fixture.baseUrl, { code: String(expired.code), identity });
    expect(expiredResponse.status).toBe(400);
    expect(await json(expiredResponse)).toMatchObject({ error: 'pairing_code_expired' });

    const used = await createTicket(fixture);
    const first = await claimPairing(fixture.baseUrl, { code: String(used.code), identity });
    expect(first.status).toBe(201);
    const second = await claimPairing(fixture.baseUrl, { code: String(used.code), identity });
    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({ error: 'pairing_code_used' });
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
    expect(pairingRow(fixture.store, String((used.pairing as { id: string }).id))?.consumed_at).toEqual(
      expect.any(String),
    );
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a pre-bound ticket survives a wrong key and still matches the right one', async () => {
  const fixture = await pairingFixture();
  try {
    const bound = newIdentity();
    const other = newIdentity();
    const ticket = await createTicket(fixture, ['--public-key', bound.publicKey]);
    const code = String(ticket.code);

    const mismatch = await claimPairing(fixture.baseUrl, { code, identity: other });
    expect(mismatch.status).toBe(401);
    expect(await json(mismatch)).toMatchObject({ error: 'pairing_public_key_mismatch' });
    // A wrong key does not burn the ticket.
    const pairingId = String((ticket.pairing as { id: string }).id);
    expect(pairingRow(fixture.store, pairingId)?.consumed_at).toBeNull();

    const accepted = await claimPairing(fixture.baseUrl, { code, identity: bound });
    expect(accepted.status).toBe(201);
    const acceptedBody = await json(accepted);
    const clientId = String((acceptedBody.client as { id: string }).id);
    expect(clientRow(fixture.store, clientId)?.public_key).toBe(bound.publicKey);
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
  } finally {
    await fixture.close();
  }
}, 60_000);

test('two concurrent claims of one code produce exactly one client', async () => {
  const fixture = await pairingFixture();
  try {
    const ticket = await createTicket(fixture);
    const code = String(ticket.code);
    const responses = await Promise.all(
      [newIdentity(), newIdentity()].map((identity) => claimPairing(fixture.baseUrl, { code, identity })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(countRows(fixture.store, 'admin_clients')).toBe(1);
    expect(countRows(fixture.store, 'admin_pairings')).toBe(1);
    expect(pairingRow(fixture.store, String((ticket.pairing as { id: string }).id))?.consumed_at).toEqual(
      expect.any(String),
    );
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a signed request is bound to instance, method, target, query, body, time and nonce', async () => {
  const fixture = await pairingFixture();
  try {
    const { clientId, instanceId } = await pairClient(fixture);
    const identity = await readClientIdentity(clientKeyPath(fixture.home));
    if (identity === undefined) {
      throw new Error('the client CLI wrote no key file');
    }
    const base = { clientId, instanceId, privateKey: identity.privateKey };

    // Replay: the same header twice, then again after a server restart.
    const header = signatureHeader({ ...base, method: 'GET', target: '/api/key' });
    const first = await sendSigned(fixture.baseUrl, {
      ...base,
      method: 'GET',
      target: '/api/key',
      authorization: header,
    });
    expect(first.status).toBe(200);
    const replay = await sendSigned(fixture.baseUrl, {
      ...base,
      method: 'GET',
      target: '/api/key',
      authorization: header,
    });
    expect(replay.status).toBe(401);
    expect(await json(replay)).toMatchObject({ error: 'signature_replayed' });

    const restarted = await fixture.restart();
    const afterRestart = await sendSigned(restarted, {
      ...base,
      method: 'GET',
      target: '/api/key',
      authorization: header,
    });
    expect(afterRestart.status).toBe(401);
    expect(await json(afterRestart)).toMatchObject({ error: 'signature_replayed' });

    // Method, target, query and body are all bound into the signature.
    const tampered: ReadonlyArray<readonly [string, Response]> = [
      [
        'method',
        await sendSigned(fixture.baseUrl, {
          ...base,
          method: 'POST',
          target: '/api/key',
          authorization: signatureHeader({ ...base, method: 'GET', target: '/api/key' }),
        }),
      ],
      [
        'target',
        await sendSigned(fixture.baseUrl, {
          ...base,
          method: 'GET',
          target: '/api/overview',
          authorization: signatureHeader({ ...base, method: 'GET', target: '/api/key' }),
        }),
      ],
      [
        'query',
        await sendSigned(fixture.baseUrl, {
          ...base,
          method: 'GET',
          target: '/api/invocations?limit=2',
          authorization: signatureHeader({ ...base, method: 'GET', target: '/api/invocations?limit=1' }),
        }),
      ],
      [
        'body',
        await sendSigned(fixture.baseUrl, {
          ...base,
          method: 'POST',
          target: '/api/dictionary',
          body: '{"term":"tampered"}',
          authorization: signatureHeader({
            ...base,
            method: 'POST',
            target: '/api/dictionary',
            body: '{"term":"signed"}',
          }),
        }),
      ],
    ];
    for (const [label, response] of tampered) {
      expect(response.status, label).toBe(401);
      expect(await json(response), label).toMatchObject({ error: 'unauthenticated' });
    }

    // Clock drift has its own code so an agent can diagnose it.
    const nowSeconds = Math.floor(Date.now() / 1_000);
    for (const drift of [-400, 400]) {
      const skewed = await sendSigned(fixture.baseUrl, {
        ...base,
        method: 'GET',
        target: '/api/key',
        authorization: signatureHeader({
          ...base,
          method: 'GET',
          target: '/api/key',
          timestamp: nowSeconds + drift,
        }),
      });
      expect(skewed.status, `drift ${drift}`).toBe(401);
      expect(await json(skewed), `drift ${drift}`).toMatchObject({ error: 'signature_clock_skew' });
    }

    // Another instance's identity signs nothing acceptable here.
    const foreign = await sendSigned(fixture.baseUrl, {
      ...base,
      instanceId: `ins_${'B'.repeat(22)}`,
      method: 'GET',
      target: '/api/key',
    });
    expect(foreign.status).toBe(401);
    expect(await json(foreign)).toMatchObject({ error: 'unauthenticated' });

    // A nonce is only recorded for a signature that verified: the tampered
    // requests above left only the one nonce the valid request consumed.
    const nonceRow = fixture.store.db
      .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM admin_client_nonces')
      .get();
    expect(Number(nonceRow?.count ?? 0n)).toBe(1);
    const unconsumed = await sendSigned(fixture.baseUrl, {
      ...base,
      method: 'GET',
      target: '/api/other',
      authorization: signatureHeader({ ...base, method: 'GET', target: '/api/key', nonce: 'nonceXXXXXXXXXXXXXXXXXXX' }),
    });
    expect(unconsumed.status).toBe(401);
    const afterInvalid = fixture.store.db
      .prepare<[string], { nonce: string }>('SELECT nonce FROM admin_client_nonces WHERE nonce = ?')
      .get('nonceXXXXXXXXXXXXXXXXXXX');
    expect(afterInvalid).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 60_000);

test('nothing prints the private key and nothing stores the pairing code', async () => {
  const fixture = await pairingFixture();
  try {
    const init = await runClientCli(fixture.home, ['auth', 'init', '--json']);
    expect(init.code, init.stderr).toBe(0);
    const paired = await pairClient(fixture);
    expect((await runClientCli(fixture.home, ['doctor', '--json'])).code).toBe(0);

    const pem = await readFile(clientKeyPath(fixture.home), 'utf8');
    const body = pem
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
      .join('');
    expect(body.length).toBeGreaterThan(0);
    const combined = cliOutput.join('\n');
    expect(combined).not.toContain('PRIVATE KEY');
    expect(combined).not.toContain(body);

    // The plaintext code exists only in the create output, never in the database.
    const database = allRowsText(fixture.store);
    expect(database).not.toContain(paired.code);
    expect(database).not.toContain(body);
    expect(database).not.toContain('PRIVATE KEY');

    // Rejected claims and requests never echo the code, key or header.
    const identity = newIdentity();
    const ticket = await createTicket(fixture);
    const code = String(ticket.code);
    const wrongProof = await claimPairing(fixture.baseUrl, {
      code,
      identity,
      proof: pairingProof(`pwp_${'A'.repeat(32)}`, identity),
    });
    const wrongProofText = await wrongProof.text();
    expect(wrongProof.status).toBe(401);
    expect(wrongProofText).not.toContain(code);
    expect(wrongProofText).not.toContain(identity.publicKey);

    const header = signatureHeader({
      clientId: paired.clientId,
      instanceId: paired.instanceId,
      privateKey: identity.privateKey,
      method: 'GET',
      target: '/api/key',
    });
    const rejected = await fetch(`${fixture.baseUrl}/api/key`, { headers: { authorization: header } });
    const rejectedText = await rejected.text();
    expect(rejected.status).toBe(401);
    expect(rejectedText).not.toContain(header);
    expect(rejectedText).not.toContain('sig=');
    expect(rejectedText).not.toContain('nonce=');
  } finally {
    await fixture.close();
  }
}, 60_000);

test.skipIf(process.platform === 'win32')(
  'the client key file is private and refuses tampering',
  async () => {
    const fixture = await pairingFixture();
    try {
      const init = await runClientCli(fixture.home, ['auth', 'init', '--json']);
      expect(init.code, init.stderr).toBe(0);
      const keyPath = clientKeyPath(fixture.home);
      expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(keyPath)).mode & 0o777).toBe(0o700);

      await pairClient(fixture);
      expect((await runClientCli(fixture.home, ['auth', 'status', '--json'])).code).toBe(0);

      chmodSync(keyPath, 0o640);
      const groupReadable = await runClientCli(fixture.home, ['auth', 'status', '--json']);
      expect(groupReadable.code).toBe(1);
      expect(JSON.parse(groupReadable.stderr)).toMatchObject({ error: 'invalid_client_key' });
      expect(groupReadable.stderr).toContain('0600');

      const moved = `${keyPath}.real`;
      renameSync(keyPath, moved);
      symlinkSync(moved, keyPath);
      const symlinked = await runClientCli(fixture.home, ['auth', 'status', '--json']);
      expect(symlinked.code).toBe(1);
      const symlinkError = JSON.parse(symlinked.stderr);
      expect(symlinkError).toMatchObject({ error: 'invalid_client_key' });
      expect(symlinkError.message).toContain('symbolic link');
      expect(symlinkError.message).not.toContain('BEGIN PRIVATE KEY');
    } finally {
      await fixture.close();
    }
  },
  60_000,
);

test('an unreadable saved key is a credential failure, not a silent re-pair', async () => {
  const fixture = await pairingFixture();
  try {
    await pairClient(fixture);
    const keyPath = clientKeyPath(fixture.home);
    await writeFile(keyPath, 'not a key\n', { mode: 0o600 });
    const status = await runClientCli(fixture.home, ['auth', 'status', '--json']);
    expect(status.code).toBe(1);
    const error = JSON.parse(status.stderr);
    expect(error).toMatchObject({ error: 'invalid_client_key' });
    expect(error.message).not.toContain('not a key');
    // The credential pair is still saved; the CLI never silently forgets it.
    expect(JSON.parse(await readFile(credentialsPath(fixture.home), 'utf8'))).toMatchObject({
      client_id: expect.any(String),
    });
  } finally {
    await fixture.close();
  }
}, 60_000);
