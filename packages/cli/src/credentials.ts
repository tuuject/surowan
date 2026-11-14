import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CLIENT_ID_PATTERN, INSTANCE_ID_PATTERN } from '@surowan/admin-surface';
import { isRecord, parseEndpoint } from './client.ts';
import { CliError, usageError } from './errors.ts';
import { type PrivateFileKind, readPrivateFile, writePrivateFile } from './private-file.ts';

/**
 * Credentials for the Admin API, stored as one 0600 file under
 * `~/.config/surowan-utils/`.
 *
 * Two forms coexist in the same file, each with an exact key set and exactly
 * one saved at a time (last writer wins):
 *
 * - `{ endpoint, apiKey }`: a programmatic `pwk_…` key, saved by `login`.
 * - `{ endpoint, client_id, instance_id }`: a paired client, saved by
 *   `auth pair`. The matching private key lives in `client-key.pem`; this file
 *   is not a secret, the key is.
 *
 * Panel username/password login was removed: account and credential management
 * stay in the browser panel or the server CLI, and a credential's mode decides
 * what the CLI may do.
 */
export interface ApiKeyCredentials {
  /** Normalized base URL, in the form `parseEndpoint` produces. */
  readonly endpoint: string;
  readonly apiKey: string;
}

export interface ClientCredentials {
  readonly endpoint: string;
  /** `admin_clients.id` as decimal text; ids never travel as numbers. */
  readonly client_id: string;
  /** The instance the client paired with; a signature is bound to it. */
  readonly instance_id: string;
}

export type Credentials = ApiKeyCredentials | ClientCredentials;

/** A credentials file is tiny; anything larger is not one this tool wrote. */
export const MAX_CREDENTIALS_BYTES = 16 * 1024;

const MAX_API_KEY_LENGTH = 4096;
/** Whitespace (including Unicode spaces) and control characters. */
const FORBIDDEN_API_KEY_CHARACTERS = /[\p{White_Space}\p{Cc}]/u;
const INVALID_CREDENTIALS = 'invalid_credentials';

const CREDENTIALS_FILE: PrivateFileKind = {
  invalidCode: INVALID_CREDENTIALS,
  writeErrorCode: 'credentials_write_failed',
  label: 'credentials file',
};

/**
 * `~/.config/surowan-utils/credentials.json` on every platform, Windows
 * included: one documented location beats an XDG/AppData guess that would hide
 * the file from users who followed the guide.
 */
export function credentialsPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'surowan-utils', 'credentials.json');
}

export function hasApiKey(credentials: Credentials): credentials is ApiKeyCredentials {
  return 'apiKey' in credentials;
}

export function hasClientSignature(credentials: Credentials): credentials is ClientCredentials {
  return 'client_id' in credentials;
}

/**
 * A key is an opaque token: no `pwk_` prefix is required, and synthetic keys
 * (including ones ending in a backslash) must round-trip unchanged. Only what
 * would corrupt a header or a log line is refused.
 */
export function validateApiKey(value: string): string {
  if (value.length < 1 || value.length > MAX_API_KEY_LENGTH || FORBIDDEN_API_KEY_CHARACTERS.test(value)) {
    throw usageError(
      'invalid_api_key',
      `API key must be 1 to ${MAX_API_KEY_LENGTH} characters with no whitespace or control characters`,
    );
  }
  return value;
}

/**
 * Reads the stored credentials, or `undefined` when nothing is stored yet.
 * Every other anomaly fails fast with a fixed `CliError`: a JSON parse error
 * quotes the surrounding text, and that text is the key.
 */
export async function readCredentials(path: string): Promise<Credentials | undefined> {
  const text = await readPrivateFile(path, CREDENTIALS_FILE, MAX_CREDENTIALS_BYTES);
  if (text === undefined) {
    return undefined;
  }
  return parseStoredCredentials(text, path);
}

/**
 * Writes the complete credential over whatever was stored before. The bytes
 * land in a freshly created 0600 file that is renamed into place, so a failed
 * write leaves the old file byte-for-byte intact.
 */
export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
  const endpoint = parseEndpoint(credentials.endpoint).href;
  const document = hasApiKey(credentials)
    ? { endpoint, apiKey: validateApiKey(credentials.apiKey) }
    : {
        endpoint,
        client_id: validateClientId(credentials.client_id),
        instance_id: validateInstanceId(credentials.instance_id),
      };
  const text = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(text) > MAX_CREDENTIALS_BYTES) {
    throw usageError('credentials_too_large', `credentials must not exceed ${MAX_CREDENTIALS_BYTES} bytes`);
  }
  await writePrivateFile(path, text, CREDENTIALS_FILE);
}

function parseStoredCredentials(text: string, path: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalidCredentials(path, 'credentials file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and "apiKey"');
  }
  const keys = Object.keys(parsed).sort().join(',');
  const { endpoint: rawEndpoint, apiKey: rawApiKey, client_id: rawClientId, instance_id: rawInstanceId } = parsed;
  if (keys === 'apiKey,endpoint') {
    if (typeof rawApiKey !== 'string' || typeof rawEndpoint !== 'string') {
      throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and "apiKey"');
    }
    const endpoint = parseStoredEndpoint(rawEndpoint, path);
    try {
      return { endpoint, apiKey: validateApiKey(rawApiKey) };
    } catch {
      throw invalidCredentials(path, 'credentials file API key is invalid');
    }
  }
  if (keys === 'client_id,endpoint,instance_id') {
    if (typeof rawClientId !== 'string' || typeof rawInstanceId !== 'string' || typeof rawEndpoint !== 'string') {
      throw invalidCredentials(path, 'credentials file must contain exactly "endpoint", "client_id" and "instance_id"');
    }
    return {
      endpoint: parseStoredEndpoint(rawEndpoint, path),
      client_id: storedClientId(rawClientId, path),
      instance_id: storedInstanceId(rawInstanceId, path),
    };
  }
  throw invalidCredentials(
    path,
    'credentials file must contain exactly "endpoint"/"apiKey" or "endpoint"/"client_id"/"instance_id"',
  );
}

function parseStoredEndpoint(raw: string, path: string): string {
  try {
    return parseEndpoint(raw).href;
  } catch {
    throw invalidCredentials(path, 'credentials file endpoint is invalid');
  }
}

function storedClientId(value: string, path: string): string {
  if (!CLIENT_ID_PATTERN.test(value)) {
    throw invalidCredentials(path, 'credentials file client_id is invalid');
  }
  return value;
}

function storedInstanceId(value: string, path: string): string {
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw invalidCredentials(path, 'credentials file instance_id is invalid');
  }
  return value;
}

function validateClientId(value: string): string {
  if (!CLIENT_ID_PATTERN.test(value)) {
    throw usageError('invalid_client_id', 'client_id must be a positive decimal id');
  }
  return value;
}

function validateInstanceId(value: string): string {
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw usageError('invalid_instance_id', 'instance_id must be an "ins_" instance id');
  }
  return value;
}

function invalidCredentials(path: string, reason: string): CliError {
  return new CliError(INVALID_CREDENTIALS, `${reason}: ${path}`);
}
