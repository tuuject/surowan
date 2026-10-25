import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, expect, vi } from 'vitest';
import { AdminAuth } from '../../src/ingress/admin/auth.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

export const origin = 'https://example.com';
export const password = 'fixture-correct-horse';
const cleanups: (() => Promise<void>)[] = [];

/** Registers the per-test cleanup every passkey file needs. */
export function installAdminPasskeyHooks(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });
}

export async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-passkeys-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        ...(enabled ? { public_url: origin } : {}),
      };
    }),
  );
  const loaded = await loadConfig(path);
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const server = new AdminServer({ store, configStore: await testConfigStore(loaded) });
  const auth = new AdminAuth(store.orm, 12);
  const token = await auth.createFirstUser({ username: 'owner', password });
  const session = auth.authenticate(token)!;
  const cookie = `plasticwan_admin=${token}`;
  return { store, server, auth, token, session, cookie };
}

export function cookie(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}
export function req(path: string, method = 'POST', cookies = '', body: unknown = {}, source: string | null = origin) {
  return new Request(`http://127.0.0.1:8899/api/auth/${path}`, {
    method,
    headers: { cookie: cookies, ...(source === null ? {} : { origin: source }), 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
export function key() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );
  return { ...pair, publicKey, id: randomBytes(32).toString('base64url') };
}
function clientData(type: string, challenge: string, clientOrigin = origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: clientOrigin, crossOrigin: false }));
}
function authData(flags: number, counter: number, rpId = 'example.com') {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), count]);
}
export function registration(
  k: ReturnType<typeof key>,
  challenge: string,
  overrides: { origin?: string; rp?: string; flags?: number } = {},
) {
  const id = Buffer.from(k.id, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const data = Buffer.concat([
    authData(overrides.flags ?? 0x45, 0, overrides.rp),
    Buffer.alloc(16),
    length,
    id,
    k.publicKey,
  ]);
  return {
    id: k.id,
    rawId: k.id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData('webauthn.create', challenge, overrides.origin).toString('base64url'),
      attestationObject: Buffer.from(
        isoCBOR.encode(
          new Map<string, string | Uint8Array | Map<string, string>>([
            ['fmt', 'none'],
            ['authData', new Uint8Array(data)],
            ['attStmt', new Map()],
          ]),
        ),
      ).toString('base64url'),
      transports: ['internal'],
    },
  };
}
export function assertion(
  k: ReturnType<typeof key>,
  challenge: string,
  userHandle: string,
  counter: number,
  overrides: { origin?: string; rp?: string; flags?: number } = {},
) {
  const client = clientData('webauthn.get', challenge, overrides.origin);
  const data = authData(overrides.flags ?? 5, counter, overrides.rp);
  return {
    id: k.id,
    rawId: k.id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: client.toString('base64url'),
      authenticatorData: data.toString('base64url'),
      userHandle,
      signature: sign(
        'sha256',
        Buffer.concat([data, createHash('sha256').update(client).digest()]),
        k.privateKey,
      ).toString('base64url'),
    },
  };
}
export async function register(f: Awaited<ReturnType<typeof fixture>>, k = key(), name = 'My passkey') {
  const response = await f.server.handle(req('passkeys/register/options', 'POST', f.cookie));
  expect(response.status).toBe(200);
  const options: any = await response.json();
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  const result = await f.server.handle(
    req('passkeys/register/verify', 'POST', `${f.cookie}; ${cookie(response)}`, {
      name,
      response: registration(k, options.challenge),
    }),
  );
  expect(result.status).toBe(200);
  return { k, userHandle: options.user.id };
}
