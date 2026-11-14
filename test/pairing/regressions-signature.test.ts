import { expect, test } from 'vitest';
import { SIGNATURE_MAX_CLOCK_SKEW_SECONDS } from '@surowan/admin-surface';
import { permissionsFromMode } from '../../src/ingress/admin/api-keys.ts';
import { createPairing, ensureInstanceId, insertClient, revokeClient } from '../../src/ingress/admin/clients/index.ts';
import { publicKeyFingerprint } from '../../src/ingress/admin/clients/keys.ts';
import { claimPairing } from '../../src/ingress/admin/clients/pairing.ts';
import { authenticateClientRequest } from '../../src/ingress/admin/clients/signature.ts';
import {
  type PairingFixture,
  type TestIdentity,
  clientRow,
  countRows,
  installPairingHooks,
  json,
  newIdentity,
  pairingFixture,
  pairingProof,
  pairingRow,
  sendSigned,
  signatureHeader,
} from './fixtures.ts';

installPairingHooks();

interface RegisteredClient {
  readonly clientId: string;
  readonly identity: TestIdentity;
  readonly instanceId: string;
}

/** A client row without the pairing dance: these tests are about request authentication. */
async function registerClient(fixture: PairingFixture): Promise<RegisteredClient> {
  const identity = newIdentity();
  const fingerprint = await publicKeyFingerprint(identity.publicKey);
  if (fingerprint === null) {
    throw new Error('generated key has no fingerprint');
  }
  const item = insertClient(fixture.store.orm, {
    name: 'regression-client',
    publicKey: identity.publicKey,
    fingerprint,
    permissions: permissionsFromMode('read_write'),
  });
  return { clientId: item.id, identity, instanceId: ensureInstanceId(fixture.store.orm) };
}

test('a signature is re-checked against a fresh clock after the body arrives', async () => {
  const fixture = await pairingFixture();
  try {
    const { clientId, identity, instanceId } = await registerClient(fixture);
    const start = new Date();
    const shifted = new Date(start.getTime() + (SIGNATURE_MAX_CLOCK_SKEW_SECONDS + 100) * 1_000);
    let readings = 0;
    // First reading: when the request line arrives. Every later reading: after
    // the body had time to trickle in.
    const clock = (): Date => (readings++ === 0 ? start : shifted);
    const body = '{"probe":true}';
    const header = signatureHeader({
      clientId,
      instanceId,
      privateKey: identity.privateKey,
      method: 'POST',
      target: '/api/probe',
      body,
      timestamp: Math.floor(start.getTime() / 1_000),
    });
    const request = new Request('http://127.0.0.1/api/probe', {
      method: 'POST',
      headers: { authorization: header, 'content-type': 'application/json' },
      body,
    });
    const result = await authenticateClientRequest(fixture.store.orm, request, '/api/probe', clock);
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') {
      throw new Error('expected the stale request to be rejected');
    }
    expect(result.response.status).toBe(401);
    expect(await json(result.response)).toMatchObject({ error: 'signature_clock_skew' });
    // Nothing was consumed and the client is still usable.
    expect(countRows(fixture.store, 'admin_client_nonces')).toBe(0);
    expect(clientRow(fixture.store, clientId)?.last_used_at).toBeNull();
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a client revoked while its body is streaming is not dispatched', async () => {
  const fixture = await pairingFixture();
  try {
    const { clientId, identity, instanceId } = await registerClient(fixture);
    const now = new Date();
    const body = '{"probe":true}';
    const header = signatureHeader({
      clientId,
      instanceId,
      privateKey: identity.privateKey,
      method: 'POST',
      target: '/api/probe',
      body,
      timestamp: Math.floor(now.getTime() / 1_000),
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // The revocation lands after the header check, while the body is still
        // in flight.
        revokeClient(fixture.store.orm, BigInt(clientId));
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    const request = new Request('http://127.0.0.1/api/probe', {
      method: 'POST',
      duplex: 'half',
      headers: { authorization: header, 'content-type': 'application/json' },
      body: stream,
    });
    const result = await authenticateClientRequest(fixture.store.orm, request, '/api/probe', () => now);
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') {
      throw new Error('expected the revoked client to be rejected');
    }
    expect(result.response.status).toBe(401);
    expect(await json(result.response)).toMatchObject({ error: 'unauthenticated' });
    expect(countRows(fixture.store, 'admin_client_nonces')).toBe(0);
    expect(clientRow(fixture.store, clientId)?.revoked_at).toEqual(expect.any(String));
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a nonce expires when its own timestamp leaves the window, not earlier', async () => {
  const fixture = await pairingFixture();
  try {
    const { clientId, identity, instanceId } = await registerClient(fixture);
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1_000);
    const header = signatureHeader({
      clientId,
      instanceId,
      privateKey: identity.privateKey,
      method: 'GET',
      target: '/api/key',
      timestamp: timestampSeconds,
    });
    const request = new Request('http://127.0.0.1/api/key', { headers: { authorization: header } });
    const result = await authenticateClientRequest(fixture.store.orm, request, '/api/key', () => now);
    expect(result.kind).toBe('authenticated');
    const rows = fixture.store.db
      .prepare<[], { nonce: string; expires_at: string }>('SELECT nonce, expires_at FROM admin_client_nonces')
      .all();
    expect(rows).toHaveLength(1);
    // ts + skew + one whole second: the window is compared in seconds, so the
    // row must outlive `ts + 300.x`.
    expect(rows[0]?.expires_at).toBe(
      new Date((timestampSeconds + SIGNATURE_MAX_CLOCK_SKEW_SECONDS + 1) * 1_000).toISOString(),
    );
    // A replay inside the window is still identified as a replay.
    const replay = await authenticateClientRequest(
      fixture.store.orm,
      new Request('http://127.0.0.1/api/key', { headers: { authorization: header } }),
      '/api/key',
      () => now,
    );
    expect(replay.kind).toBe('response');
    if (replay.kind !== 'response') {
      throw new Error('expected the replay to be rejected');
    }
    expect(await json(replay.response)).toMatchObject({ error: 'signature_replayed' });
  } finally {
    await fixture.close();
  }
}, 60_000);

test('a claim whose body completes after expiry consumes nothing', async () => {
  const fixture = await pairingFixture();
  try {
    const pairing = await createPairing(fixture.store.orm, {
      name: 'late-claim',
      mode: 'read_write',
      ttlSeconds: 60,
      publicKey: null,
    });
    const expiresAt = new Date(pairing.item.expires_at);
    const before = new Date(expiresAt.getTime() - 1_000);
    const after = new Date(expiresAt.getTime() + 1_000);
    let readings = 0;
    const clock = (): Date => (readings++ === 0 ? before : after);
    const identity = newIdentity();
    const body = JSON.stringify({
      code: pairing.code,
      public_key: identity.publicKey,
      proof: pairingProof(pairing.code, identity),
    });
    const request = new Request('http://127.0.0.1/api/pairing/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    await expect(claimPairing(fixture.store.orm, request, clock)).rejects.toMatchObject({
      code: 'pairing_code_expired',
    });
    // The ticket is not burned and, critically, no client was created.
    expect(countRows(fixture.store, 'admin_clients')).toBe(0);
    expect(pairingRow(fixture.store, pairing.item.id)?.consumed_at).toBeNull();
  } finally {
    await fixture.close();
  }
}, 60_000);

test('an out-of-range client id in the header is a plain 401', async () => {
  const fixture = await pairingFixture();
  try {
    const identity = newIdentity();
    // 19 digits, above the signed 64-bit maximum; binding it to SQLite would
    // throw and surface as 500 without the parser guard.
    const response = await sendSigned(fixture.baseUrl, {
      clientId: '9999999999999999999',
      instanceId: `ins_${'A'.repeat(22)}`,
      privateKey: identity.privateKey,
      method: 'GET',
      target: '/api/key',
    });
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: 'unauthenticated' });
  } finally {
    await fixture.close();
  }
}, 60_000);
