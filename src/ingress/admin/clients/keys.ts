import { PUBLIC_KEY_PATTERN, SIGNATURE_PATTERN, pairingProofString } from '@surowan/admin-surface';

/**
 * Ed25519 and SHA-256 primitives for paired clients, on WebCrypto only.
 *
 * This file deliberately imports nothing from `node:` and uses no `Buffer`:
 * signature and proof verification is the part of the Admin API that must also
 * run on a Web-standard runtime (Cloudflare Workers) later, and a helper that
 * quietly pulls in `node:crypto` would block that move. The server only ever
 * handles public data here — the private key is created and kept by the client.
 */
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PAIRING_CODE_PREFIX = 'pwp_';
const PAIRING_CODE_BYTES = 24;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_VALUES: ReadonlyMap<string, number> = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

/** Unpadded base64url, the only encoding either side puts on the wire. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = '';
  let index = 0;
  while (index + 2 < bytes.length) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    encoded +=
      BASE64URL_ALPHABET.charAt((chunk >> 18) & 63) +
      BASE64URL_ALPHABET.charAt((chunk >> 12) & 63) +
      BASE64URL_ALPHABET.charAt((chunk >> 6) & 63) +
      BASE64URL_ALPHABET.charAt(chunk & 63);
    index += 3;
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    encoded += BASE64URL_ALPHABET.charAt((chunk >> 18) & 63) + BASE64URL_ALPHABET.charAt((chunk >> 12) & 63);
  } else if (remaining === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    encoded +=
      BASE64URL_ALPHABET.charAt((chunk >> 18) & 63) +
      BASE64URL_ALPHABET.charAt((chunk >> 12) & 63) +
      BASE64URL_ALPHABET.charAt((chunk >> 6) & 63);
  }
  return encoded;
}

/** Strict unpadded decode; `null` for padding, foreign characters or a dangling sextet. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL_VALUES.get(character);
    if (index === undefined) {
      return null;
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export async function sha256Base64url(bytes: Uint8Array): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', toWebBytes(bytes))));
}

/**
 * A `Uint8Array` view the WebCrypto types accept: ArrayBuffer-backed, never a
 * SharedArrayBuffer. A DOM-free TypeScript config cannot spell `BufferSource`
 * here, so the copy is the portable, cast-free way to satisfy it.
 */
function toWebBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Verifies a detached Ed25519 signature over `data`. Malformed input returns
 * `false` rather than throwing: callers answer one fixed 401 and must never
 * turn a bad key or signature into an exception that could quote it.
 */
export async function verifyEd25519(publicKey: string, data: Uint8Array, signature: string): Promise<boolean> {
  const rawKey = PUBLIC_KEY_PATTERN.test(publicKey) ? decodeBase64Url(publicKey) : null;
  const rawSignature = SIGNATURE_PATTERN.test(signature) ? decodeBase64Url(signature) : null;
  if (
    rawKey === null ||
    rawKey.byteLength !== PUBLIC_KEY_BYTES ||
    rawSignature === null ||
    rawSignature.byteLength !== SIGNATURE_BYTES
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, rawSignature, toWebBytes(data));
  } catch {
    return false;
  }
}

/** `SHA256:` plus base64url of the raw key, or `null` when the key is malformed. */
export async function publicKeyFingerprint(publicKey: string): Promise<string | null> {
  const raw = PUBLIC_KEY_PATTERN.test(publicKey) ? decodeBase64Url(publicKey) : null;
  if (raw === null || raw.byteLength !== PUBLIC_KEY_BYTES) {
    return null;
  }
  return `SHA256:${await sha256Base64url(raw)}`;
}

export function isValidPublicKey(value: string): boolean {
  if (!PUBLIC_KEY_PATTERN.test(value)) {
    return false;
  }
  const raw = decodeBase64Url(value);
  // The last character carries two unused bits, so one key has four spellings.
  // Only the canonical one is accepted: the active-key unique index and the
  // pre-bound comparison both compare text, not key bytes.
  return raw !== null && raw.byteLength === PUBLIC_KEY_BYTES && encodeBase64Url(raw) === value;
}

/** `base64url(sha256(bytes))`: the body digest bound into every signed request. */
export function bodyDigest(bytes: Uint8Array): Promise<string> {
  return sha256Base64url(bytes);
}

/** Digest of a pairing code, stored in the claim proof and sent by the client. */
export function codeDigest(code: string): Promise<string> {
  return sha256Base64url(new TextEncoder().encode(code));
}

/** What the claiming client signs; the server rebuilds it byte for byte. */
export async function buildPairingProof(code: string, publicKey: string): Promise<string> {
  return pairingProofString(await codeDigest(code), publicKey);
}

/** `pwp_` plus 24 random bytes: short-lived, single-use, and never stored. */
export function generatePairingCode(): string {
  return `${PAIRING_CODE_PREFIX}${encodeBase64Url(crypto.getRandomValues(new Uint8Array(PAIRING_CODE_BYTES)))}`;
}
