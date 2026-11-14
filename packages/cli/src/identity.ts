import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_KEY_PATTERN } from '@surowan/admin-surface';
import { CliError } from './errors.ts';
import { type PrivateFileKind, createPrivateFile, readPrivateFile, removePrivateFile } from './private-file.ts';

/**
 * The client half of the pairing identity: an Ed25519 private key that never
 * leaves this machine, plus the public key, fingerprint and signing helper
 * derived from it on demand.
 *
 * The private key is stored as a PKCS#8 PEM with the same file posture as the
 * credential file, is never printed, never accepted from argv or the
 * environment, and there is deliberately no export command. Only signatures
 * (and the public key) travel to the server.
 */
const MAX_KEY_FILE_BYTES = 4 * 1_024;
const INVALID_CLIENT_KEY = 'invalid_client_key';

const CLIENT_KEY_FILE: PrivateFileKind = {
  invalidCode: INVALID_CLIENT_KEY,
  writeErrorCode: 'client_key_write_failed',
  label: 'client key file',
};

export interface ClientIdentity {
  readonly privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key, base64url without padding. */
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** `client-key.pem` sits next to `credentials.json`; one documented location. */
export function clientKeyPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'surowan-utils', 'client-key.pem');
}

/**
 * Creates the key when it is missing and leaves an existing one untouched, so
 * a re-run cannot silently orphan a paired client. `created` says which
 * happened; the caller decides how to report it.
 *
 * Publication is create-if-absent, not replace: two concurrent `auth pair`
 * runs each generate a key, only one file wins, and the loser adopts the
 * winner's key rather than pairing a key that is no longer on disk.
 */
export async function ensureClientIdentity(
  path: string,
): Promise<{ readonly identity: ClientIdentity; readonly created: boolean }> {
  const existing = await readClientIdentity(path);
  if (existing !== undefined) {
    return { identity: existing, created: false };
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  if (Buffer.byteLength(pem) > MAX_KEY_FILE_BYTES) {
    throw new CliError('client_key_too_large', `client key file must not exceed ${MAX_KEY_FILE_BYTES} bytes`);
  }
  if (await createPrivateFile(path, pem, CLIENT_KEY_FILE)) {
    return { identity: deriveIdentity(pem, path), created: true };
  }
  const winner = await readClientIdentity(path);
  if (winner === undefined) {
    throw new CliError(INVALID_CLIENT_KEY, `client key file appeared and vanished while pairing: ${path}`);
  }
  return { identity: winner, created: false };
}

/** Reads the stored key, or `undefined` when there is none yet. */
export async function readClientIdentity(path: string): Promise<ClientIdentity | undefined> {
  const pem = await readPrivateFile(path, CLIENT_KEY_FILE, MAX_KEY_FILE_BYTES);
  if (pem === undefined) {
    return undefined;
  }
  return deriveIdentity(pem, path);
}

export async function clientKeyExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

/** Deletes the private key; the server-side client is unaffected. */
export async function removeClientKey(path: string): Promise<boolean> {
  return await removePrivateFile(path);
}

/** base64url(sha256(raw key)) with a fixed prefix; shown so both sides can compare. */
export function publicKeyFingerprint(publicKey: string): string {
  const raw = Buffer.from(publicKey, 'base64url');
  return `SHA256:${createHash('sha256').update(raw).digest('base64url')}`;
}

/** Signs a canonical string with the stored key; the only place the key signs. */
export function signWithIdentity(identity: ClientIdentity, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), identity.privateKey).toString('base64url');
}

/** `base64url(sha256(text))`: the digest form the pairing proof binds. */
export function sha256Base64Url(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url');
}

/**
 * Any failure of the stored key — unparsable PEM, a non-Ed25519 key, a public
 * half that is not the raw 32 bytes — collapses into one fixed error. The PEM
 * text must never reach the message, and `createPrivateKey`'s own error can
 * quote it.
 */
function deriveIdentity(pem: string, path: string): ClientIdentity {
  let privateKey: KeyObject;
  let publicKey: string;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !PUBLIC_KEY_PATTERN.test(jwk.x)) {
      throw new Error('not an Ed25519 key');
    }
    publicKey = jwk.x;
  } catch {
    throw new CliError(
      INVALID_CLIENT_KEY,
      `client key file is not an Ed25519 PKCS#8 private key and could not be used: ${path}`,
    );
  }
  return { privateKey, publicKey, fingerprint: publicKeyFingerprint(publicKey) };
}
