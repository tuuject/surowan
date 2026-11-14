/**
 * Wire format shared by a paired client and the Admin API.
 *
 * Only string layout lives here: this package compiles with `types: []`, so it
 * never touches `node:crypto` or `Buffer`. Callers hash the body, sign the
 * canonical string, and verify the signature with their own platform
 * primitives; both sides must build the exact same bytes, which is why the
 * builders are here instead of being duplicated in the CLI and the server.
 */

/** Authentication scheme name carried by `Authorization`. */
export const SIGNATURE_SCHEME = 'Surowan-Signature';
export const SIGNATURE_VERSION = '1';
/** First line of the canonical request string; a version tag, not a header. */
export const SIGNATURE_CANONICAL_PREFIX = 'SUROWAN-SIGNATURE-V1';
/** First line of the string a client signs to prove it owns the pairing key. */
export const PAIRING_PROOF_PREFIX = 'SUROWAN-PAIRING-CLAIM-V1';

/**
 * Accepted difference between the client and server clocks. A request outside
 * this window is refused with its own error code so an agent can diagnose a
 * drifting container clock instead of hunting a phantom key problem.
 */
export const SIGNATURE_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * When a nonce may be forgotten, as Unix seconds. A nonce has to block replays
 * for exactly as long as its request timestamp can still pass the window — the
 * window is compared in whole seconds, so the extra second covers `ts + 300.x`.
 * Deriving it from `ts` (not from receipt time) is what closes the replay gap
 * for a request whose clock is ahead of the server's.
 */
export function nonceExpiresAtSeconds(timestampSeconds: number): number {
  return timestampSeconds + SIGNATURE_MAX_CLOCK_SKEW_SECONDS + 1;
}

/** Raw Ed25519 public key: 32 bytes, base64url without padding. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Ed25519 signature: 64 bytes, base64url without padding. */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Positive signed 64-bit id as decimal text; ids never travel as numbers. */
export const CLIENT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const MAX_CLIENT_ID = 9_223_372_036_854_775_807n;
export const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9_-]{43}$/;
export const INSTANCE_ID_PATTERN = /^ins_[A-Za-z0-9_-]{22}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const BODY_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SignatureMaterial {
  readonly instanceId: string;
  readonly clientId: string;
  /** Capitalized HTTP method; the server sends `request.method`, which is already uppercase. */
  readonly method: string;
  /** Request path from `/api/…` plus the query string exactly as sent. */
  readonly target: string;
  /** Unix seconds as decimal text, so client and server agree on the encoding. */
  readonly timestamp: string;
  readonly nonce: string;
  /** base64url(sha256(raw body bytes)); the digest of an empty body is not exempt. */
  readonly bodyDigest: string;
}

export function canonicalSignatureString(material: SignatureMaterial): string {
  return [
    SIGNATURE_CANONICAL_PREFIX,
    material.instanceId,
    material.clientId,
    material.method.toUpperCase(),
    material.target,
    material.timestamp,
    material.nonce,
    material.bodyDigest,
  ].join('\n');
}

/**
 * The claiming client signs this with the very key it wants registered, so a
 * stolen pairing code alone cannot bind an attacker's own key.
 */
export function pairingProofString(codeDigest: string, publicKey: string): string {
  return [PAIRING_PROOF_PREFIX, codeDigest, publicKey].join('\n');
}

export interface SignatureHeaderFields {
  readonly clientId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

/** Fixed parameter order and separators; the parser below accepts nothing else. */
export function formatSignatureAuthorization(fields: SignatureHeaderFields): string {
  return `${SIGNATURE_SCHEME} v=${SIGNATURE_VERSION},client=${fields.clientId},ts=${fields.timestamp},nonce=${fields.nonce},sig=${fields.signature}`;
}

/**
 * Strictly parses the header into its fields, or returns `null`. A malformed
 * header is answered with the same fixed 401 as an unknown client: the caller
 * must never echo any part of it back.
 */
export function parseSignatureAuthorization(header: string): SignatureHeaderFields | null {
  const prefix = `${SIGNATURE_SCHEME} `;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return null;
  }
  const parts = header.slice(prefix.length).split(',');
  if (parts.length !== 5) {
    return null;
  }
  const [version, client, ts, nonce, sig] = parts;
  if (version !== `v=${SIGNATURE_VERSION}`) {
    return null;
  }
  const clientId = parameter(client, 'client');
  const timestamp = parameter(ts, 'ts');
  const nonceValue = parameter(nonce, 'nonce');
  const signature = parameter(sig, 'sig');
  if (clientId === null || timestamp === null || nonceValue === null || signature === null) {
    return null;
  }
  if (
    !CLIENT_ID_PATTERN.test(clientId) ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !NONCE_PATTERN.test(nonceValue) ||
    !SIGNATURE_PATTERN.test(signature) ||
    // Nineteen digits can still overflow SQLite's signed 64-bit range, and
    // binding such a BigInt throws: that must stay a plain 401, not a 500.
    BigInt(clientId) > MAX_CLIENT_ID
  ) {
    return null;
  }
  return { clientId, timestamp, nonce: nonceValue, signature };
}

/** Whether a value can be an Ed25519 body digest (never a proof of anything). */
export function isBodyDigest(value: string): boolean {
  return BODY_DIGEST_PATTERN.test(value);
}

function parameter(part: string | undefined, name: string): string | null {
  if (part === undefined) {
    return null;
  }
  const prefix = `${name}=`;
  return part.startsWith(prefix) ? part.slice(prefix.length) : null;
}
