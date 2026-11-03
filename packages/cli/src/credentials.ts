import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isRecord, parseEndpoint } from './client.ts';
import { CliError, usageError } from './errors.ts';

/**
 * Credentials for the Admin API, stored as one 0600 file under
 * `~/.config/surowan-utils/`. Reading and writing share the same posture:
 * the file must be a regular file that group/other cannot read or write, its
 * bytes never reach an error message, and a replacement is renamed into place
 * so a failure cannot damage the previous pair.
 *
 * A file holds exactly one credential kind:
 *
 * - `apiKey`: a programmatic `pwk_…` key. The server limits it to the
 *   inspection allowlist and Invocation replay, so it cannot change anything.
 * - `session`: a panel session token, obtained by logging in with the panel
 *   password. It authorizes exactly what the browser panel authorizes, which
 *   is what makes the panel write surface reachable from here.
 */
export interface Credentials {
  /** Normalized base URL, in the form `parseEndpoint` produces. */
  readonly endpoint: string;
  /** Programmatic API key, when the file was written by an API-key login. */
  readonly apiKey?: string;
  /** Panel session token, when the file was written by a panel login. */
  readonly session?: string;
}

/** A credentials file is tiny; anything larger is not one this tool wrote. */
export const MAX_CREDENTIALS_BYTES = 16 * 1024;

const MAX_API_KEY_LENGTH = 4096;
/** Whitespace (including Unicode spaces) and control characters. */
const FORBIDDEN_API_KEY_CHARACTERS = /[\p{White_Space}\p{Cc}]/u;
const INVALID_CREDENTIALS = 'invalid_credentials';

/**
 * `~/.config/surowan-utils/credentials.json` on every platform, Windows
 * included: one documented location beats an XDG/AppData guess that would hide
 * the file from users who followed the guide.
 */
export function credentialsPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'surowan-utils', 'credentials.json');
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

/** Session tokens are opaque 32-byte base64url values; the same character rules apply. */
export function validateSessionToken(value: string): string {
  if (value.length < 1 || value.length > MAX_API_KEY_LENGTH || FORBIDDEN_API_KEY_CHARACTERS.test(value)) {
    throw usageError(
      'invalid_session_token',
      `session token must be 1 to ${MAX_API_KEY_LENGTH} characters with no whitespace or control characters`,
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
  const info = await inspectCredentialsFile(path);
  if (info === undefined) {
    return undefined;
  }
  if (info.size > MAX_CREDENTIALS_BYTES) {
    throw invalidCredentials(path, `credentials file must not exceed ${MAX_CREDENTIALS_BYTES} bytes`);
  }
  await assertCredentialsDirectory(dirname(path), path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw invalidCredentials(path, 'credentials file could not be read');
  }
  return parseStoredCredentials(text, path);
}

/**
 * Writes the complete pair over whatever was stored before. The bytes land in
 * a freshly created 0600 file that is renamed into place, so a failed write
 * leaves the old file byte-for-byte intact. An existing symlink or an
 * over-permissive file or directory is refused rather than replaced. No lock
 * is taken: two concurrent logins are last-writer-wins.
 */
export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
  const endpoint = parseEndpoint(credentials.endpoint).href;
  const text = `${JSON.stringify(storedDocument(endpoint, credentials))}\n`;
  if (Buffer.byteLength(text) > MAX_CREDENTIALS_BYTES) {
    throw usageError('credentials_too_large', `credentials must not exceed ${MAX_CREDENTIALS_BYTES} bytes`);
  }
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertCredentialsDirectory(directory, path);
    await inspectCredentialsFile(path);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    // The filesystem message is dropped: it can name the temporary file, and
    // the caller only ever needs to know that the write did not happen.
    throw new CliError('credentials_write_failed', `credentials file could not be written: ${path}`);
  }
}

/**
 * Removes the stored credential after the server invalidated it (logout, or a
 * revoked session). A missing file is already the desired state, so it is not
 * an error; anything that is present must still be safe to unlink.
 */
export async function clearCredentials(path: string): Promise<void> {
  const info = await inspectCredentialsFile(path);
  if (info === undefined) {
    return;
  }
  await assertCredentialsDirectory(dirname(path), path);
  try {
    await unlink(path);
  } catch {
    throw new CliError('credentials_write_failed', `credentials file could not be removed: ${path}`);
  }
}

/**
 * In-place inspection shared by both directions. `undefined` means nothing is
 * stored; anything that is present must be a regular file that group and other
 * cannot read or write (POSIX modes; on Windows the home ACL is inherited).
 */
async function inspectCredentialsFile(path: string): Promise<Stats | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw invalidCredentials(path, 'credentials file could not be inspected');
  });
  if (info === undefined) {
    return undefined;
  }
  if (info.isSymbolicLink()) {
    throw invalidCredentials(path, 'credentials file must not be a symbolic link');
  }
  if (!info.isFile()) {
    throw invalidCredentials(path, 'credentials file must be a regular file');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalidCredentials(path, 'credentials file permissions must be 0600 or narrower');
  }
  return info;
}

/** The containing directory must be real (not a symlink) and not group/other accessible. */
async function assertCredentialsDirectory(directory: string, path: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw invalidCredentials(path, 'credentials directory must be a real directory');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw invalidCredentials(path, 'credentials directory permissions must be 0700 or narrower');
  }
}

/**
 * A file holds exactly one credential kind. Both shapes are read, so a stored
 * API key keeps working, and the session shape is what a panel login writes.
 */
function storedDocument(endpoint: string, credentials: Credentials): Record<string, string> {
  const hasApiKey = credentials.apiKey !== undefined;
  const hasSession = credentials.session !== undefined;
  if (hasApiKey === hasSession) {
    throw usageError('invalid_credentials', 'credentials must hold exactly one of an API key or a session token');
  }
  if (credentials.apiKey !== undefined) {
    return { endpoint, apiKey: validateApiKey(credentials.apiKey) };
  }
  return { endpoint, session: validateSessionToken(credentials.session ?? '') };
}

function parseStoredCredentials(text: string, path: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalidCredentials(path, 'credentials file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and one credential');
  }
  const { endpoint: rawEndpoint, apiKey: rawApiKey, session: rawSession } = parsed;
  const keys = Object.keys(parsed).sort().join(',');
  const validShape =
    (keys === 'apiKey,endpoint' && typeof rawApiKey === 'string' && rawSession === undefined) ||
    (keys === 'endpoint,session' && typeof rawSession === 'string' && rawApiKey === undefined);
  if (!validShape || typeof rawEndpoint !== 'string') {
    throw invalidCredentials(path, 'credentials file must contain exactly "endpoint" and one credential');
  }
  let endpoint: string;
  try {
    endpoint = parseEndpoint(rawEndpoint).href;
  } catch {
    throw invalidCredentials(path, 'credentials file endpoint is invalid');
  }
  if (rawApiKey !== undefined) {
    try {
      return { endpoint, apiKey: validateApiKey(rawApiKey) };
    } catch {
      throw invalidCredentials(path, 'credentials file API key is invalid');
    }
  }
  try {
    return { endpoint, session: validateSessionToken(rawSession as string) };
  } catch {
    throw invalidCredentials(path, 'credentials file session token is invalid');
  }
}

function invalidCredentials(path: string, reason: string): CliError {
  return new CliError(INVALID_CREDENTIALS, `${reason}: ${path}`);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
