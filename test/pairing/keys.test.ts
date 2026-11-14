import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  canonicalSignatureString,
  formatSignatureAuthorization,
  parseSignatureAuthorization,
} from '@surowan/admin-surface';
import {
  bodyDigest,
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64url,
  verifyEd25519,
} from '../../src/ingress/admin/clients/keys.ts';

/**
 * The server verifies with WebCrypto while the client signs with node:crypto.
 * These tests pin the two implementations to each other, so a future port of
 * the verifier to a Web-standard runtime cannot drift away from the client.
 */
function signWithNode(privateKey: Parameters<typeof sign>[2], data: Uint8Array): string {
  return sign(null, Buffer.from(data), privateKey).toString('base64url');
}

function nodeDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

test('node:crypto signatures verify through the WebCrypto helper', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new Error('exported key has no raw public half');
  }
  const data = new TextEncoder().encode(
    canonicalSignatureString({
      instanceId: `ins_${'A'.repeat(22)}`,
      clientId: '7',
      method: 'GET',
      target: '/api/key',
      timestamp: '1700000000',
      nonce: 'nonceXXXXXXXXXXXXXXXXXXX',
      bodyDigest: await bodyDigest(new Uint8Array()),
    }),
  );
  const signature = signWithNode(privateKey, data);

  await expect(verifyEd25519(jwk.x, data, signature)).resolves.toBe(true);
  await expect(verifyEd25519(jwk.x, data, signWithNode(privateKey, new Uint8Array([1, 2, 3])))).resolves.toBe(false);

  const flippedData = new Uint8Array(data);
  flippedData[3] = (flippedData[3] ?? 0) ^ 1;
  await expect(verifyEd25519(jwk.x, flippedData, signature)).resolves.toBe(false);

  const flippedSignature = Buffer.from(signature, 'base64url');
  flippedSignature[0] = (flippedSignature[0] ?? 0) ^ 1;
  await expect(verifyEd25519(jwk.x, data, flippedSignature.toString('base64url'))).resolves.toBe(false);

  // Another key's signature is not accepted either.
  const other = generateKeyPairSync('ed25519').privateKey;
  await expect(verifyEd25519(jwk.x, data, signWithNode(other, data))).resolves.toBe(false);

  // Malformed keys and signatures are a plain rejection, never a throw.
  const foreignCharacter = `${signature.slice(0, -1)}+`;
  for (const [key, sig] of [
    ['not-a-key', signature],
    [jwk.x.slice(0, 42), signature],
    [`${jwk.x}A`, signature],
    [jwk.x, 'short'],
    [jwk.x, foreignCharacter],
    [jwk.x, `${signature}=`],
  ] as const) {
    await expect(verifyEd25519(key, data, sig), `key ${key.slice(0, 4)} sig ${sig.slice(-1)}`).resolves.toBe(false);
  }
});

test('base64url and SHA-256 helpers agree with node:crypto', async () => {
  for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 64, 255]) {
    const bytes = new Uint8Array(randomBytes(length));
    const encoded = encodeBase64Url(bytes);
    expect(encoded, `length ${length}`).toBe(Buffer.from(bytes).toString('base64url'));
    const decoded = decodeBase64Url(encoded);
    if (length === 0) {
      // An empty string is not a legal base64url value, and no caller sends one.
      expect(decoded).toBeNull();
    } else {
      expect(decoded === null ? null : Array.from(decoded)).toEqual(Array.from(bytes));
    }
    await expect(sha256Base64url(bytes)).resolves.toBe(nodeDigest(bytes));
  }
  // Strict decode rejects padding, foreign characters and an impossible length.
  for (const value of ['AAAA=', '////', 'a', 'ab+c', '']) {
    expect(decodeBase64Url(value), value).toBeNull();
  }
});

test('the Authorization header round-trips through its strict parser', () => {
  const fields = {
    clientId: '42',
    timestamp: '1700000000',
    nonce: 'nonceXXXXXXXXXXXXXXXXXXX',
    signature: 'A'.repeat(86),
  };
  const header = formatSignatureAuthorization(fields);
  expect(header).toBe(
    `Surowan-Signature v=1,client=42,ts=1700000000,nonce=nonceXXXXXXXXXXXXXXXXXXX,sig=${'A'.repeat(86)}`,
  );
  expect(parseSignatureAuthorization(header)).toEqual(fields);
  // The scheme is case-insensitive like Bearer; the parameters are not.
  expect(parseSignatureAuthorization(header.replace('Surowan-Signature', 'sUrOwAn-SiGnAtUrE'))).toEqual(fields);
  for (const malformed of [
    '',
    'Bearer pwk_key',
    header.replace('v=1,', ''),
    header.replace('v=1', 'v=2'),
    header.replace('client=42,ts=1700000000', 'ts=1700000000,client=42'),
    header.replace('client=42', 'client=0'),
    header.replace('client=42', 'client=abc'),
    header.replace('ts=1700000000', 'ts=17x0'),
    header.replace('nonce=nonceXXXXXXXXXXXXXXXXXXX', 'nonce=short'),
    header.replace(`sig=${'A'.repeat(86)}`, 'sig=short'),
    `${header} `,
    header.replaceAll(',', ', '),
  ]) {
    expect(parseSignatureAuthorization(malformed), malformed.slice(0, 40)).toBeNull();
  }
});

test('the verification helper carries no Node.js dependency', async () => {
  const source = await readFile(new URL('../../src/ingress/admin/clients/keys.ts', import.meta.url), 'utf8');
  // Comments name the APIs on purpose; only the executable text has to stay
  // runtime-agnostic for the WebCrypto port to hold.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/from\s+'node:/);
  expect(code).not.toMatch(/\bBuffer\b/);
  expect(code).not.toMatch(/\brequire\(/);
  expect(code).toContain("crypto.subtle.verify({ name: 'Ed25519' }");
});
