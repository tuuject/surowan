import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { KEY_JAR_FILE } from './config/validate.ts';

/**
 * The keychain is the upgraded key jar: every plaintext secret the
 * configuration uses is one named entry, keyed by the names `{ "jar": "<name>" }`
 * SecretRefs point at. It sits next to the file it serves, so `config.jsonc`
 * itself never carries a secret and can be read, diffed and shared without
 * exposing one. A name is the entry's identity: rotating a secret replaces the
 * value in place, and several uses may share one entry.
 */
export interface KeychainEntry {
  readonly value: string;
  readonly created_at: string;
}

export type Keychain = Readonly<Record<string, KeychainEntry>>;

/** Entry names are short labels the panel and `configure` both show. */
export const KEYCHAIN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Failure codes the Admin Panel and CLI map onto their own error surfaces. */
export type KeychainErrorCode =
  | 'keychain_exists'
  | 'keychain_missing'
  | 'keychain_in_use'
  | 'keychain_invalid_name'
  | 'keychain_invalid_value'
  | 'keychain_format'
  | 'keychain_symlink'
  | 'keychain_write_failed'
  | 'keychain_unparsable';

export class KeychainError extends Error {
  readonly code: KeychainErrorCode;

  constructor(code: KeychainErrorCode, message: string) {
    super(message);
    this.name = 'KeychainError';
    this.code = code;
  }
}

export function keychainPath(configPath: string): string {
  return join(dirname(resolve(configPath)), KEY_JAR_FILE);
}

/**
 * A legal entry name derived from where a secret is used, with characters the
 * pattern does not allow replaced and the result kept within the length limit.
 */
export function sanitizeEntryName(base: string): string {
  const cleaned = base.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return cleaned.length === 0 ? 'key' : cleaned;
}

/**
 * The first free name for a derived entry: `base`, then `base-2`, `base-3`, …
 * Explicitly chosen names are validated instead of renamed, so only this
 * helper adds suffixes. The base is truncated before the suffix is appended,
 * so a long base cannot collapse every candidate onto the same string and
 * loop forever.
 */
export function nextEntryName(base: string, taken: ReadonlySet<string>): string {
  const safe = sanitizeEntryName(base);
  if (!taken.has(safe)) {
    return safe;
  }
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = safe.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** `null` when the file does not exist. Errors never quote the file contents: a JSON parse error echoes the text around the fault, which is a secret here. */
export async function readKeychain(path: string): Promise<Keychain | null> {
  const parsed = await readAndParse(path);
  if (parsed.kind === 'absent') {
    return null;
  }
  if (parsed.kind === 'old') {
    throw new KeychainError(
      'keychain_format',
      `Key jar at ${path} still uses the old single-level format; start serve once or run configure to migrate it, then try again`,
    );
  }
  return parsed.entries;
}

type ParsedKeychainFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'new'; readonly entries: Keychain }
  | { readonly kind: 'old'; readonly jar: Readonly<Record<string, string>> };

async function readAndParse(path: string): Promise<ParsedKeychainFile> {
  let text: string;
  try {
    if (process.platform !== 'win32' && ((await stat(path)).mode & 0o777) !== 0o600) {
      throw new KeychainError('keychain_format', `Key jar must have mode 0600: ${path}`);
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof KeychainError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeychainError('keychain_format', `Key jar is not valid JSON: ${path}`);
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as { version?: unknown; entries?: unknown };
    const version = record.version;
    const entries = record.entries;
    // Only version 1 is readable: an unknown future version must fail loudly
    // instead of being rewritten as v1.
    if (version === 1 && typeof entries === 'object' && entries !== null && !Array.isArray(entries)) {
      const record = Object.create(null) as Record<string, KeychainEntry>;
      for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).value !== 'string' ||
          ((entry as Record<string, unknown>).value as string).length === 0 ||
          typeof (entry as Record<string, unknown>).created_at !== 'string'
        ) {
          throw new KeychainError(
            'keychain_format',
            `Key jar entry ${name} must be { value: string, created_at: string }: ${path}`,
          );
        }
        const value = entry as KeychainEntry;
        record[name] = { value: value.value, created_at: value.created_at };
      }
      return { kind: 'new', entries: record };
    }
    // The old format is a flat object of non-empty strings. An entry named
    // `version` is a string there, so it never reads as the format marker.
    if (
      Object.entries(parsed as Record<string, unknown>).every(
        ([, value]) => typeof value === 'string' && value.length > 0,
      )
    ) {
      return { kind: 'old', jar: parsed as Record<string, string> };
    }
  }
  throw new KeychainError(
    'keychain_format',
    `Key jar must be { "version": 1, "entries": { "<name>": { "value", "created_at" } } }: ${path}`,
  );
}

/**
 * Migrates the old flat key jar to the keychain format, in place, exactly once:
 * every entry keeps its name and gains `created_at`. A file already in the new
 * format is left alone. The write is atomic and refuses symbolic links.
 */
export async function migrateKeychain(path: string): Promise<boolean> {
  const linked = await isSymlink(path);
  if (linked) {
    throw new KeychainError('keychain_symlink', `Key jar must not be a symbolic link: ${path}`);
  }
  const parsed = await readAndParse(path);
  if (parsed.kind !== 'old') {
    return false;
  }
  const entries = Object.create(null) as Record<string, KeychainEntry>;
  const created = new Date().toISOString();
  for (const [name, value] of Object.entries(parsed.jar)) {
    entries[name] = { value, created_at: created };
  }
  await writeKeychainFile(path, { version: 1, entries });
  return true;
}

/**
 * Adds, replaces and removes entries, replacing the file atomically so a
 * concurrent resolve sees either the old file or the new one. An added name
 * must be new; a replaced name must already exist and keeps its `created_at`.
 */
export async function updateKeychain(
  path: string,
  change: {
    readonly add?: Readonly<Record<string, string>>;
    readonly replace?: Readonly<Record<string, string>>;
    readonly remove?: readonly string[];
  },
): Promise<void> {
  const linked = await isSymlink(path);
  if (linked) {
    // The rename below would replace the link with a regular file.
    throw new KeychainError('keychain_symlink', `Key jar must not be a symbolic link: ${path}`);
  }
  const parsed = await readAndParse(path);
  if (parsed.kind === 'old') {
    throw new KeychainError(
      'keychain_format',
      `Key jar at ${path} still uses the old single-level format; start serve once or run configure to migrate it, then try again`,
    );
  }
  // A missing file starts as an empty keychain: the first add creates it
  // (0600, atomic, same writer); a replace names a missing entry and a remove
  // touches nothing.
  const next: Record<string, KeychainEntry> = Object.assign(
    Object.create(null),
    parsed.kind === 'absent' ? {} : parsed.entries,
  );
  let changed = false;
  for (const name of change.remove ?? []) {
    changed ||= Object.hasOwn(next, name);
    delete next[name];
  }
  for (const [name, value] of Object.entries(change.replace ?? {})) {
    if (!KEYCHAIN_NAME_PATTERN.test(name)) {
      throw new KeychainError('keychain_invalid_name', `Invalid keychain entry name: ${name}`);
    }
    if (value.length === 0) {
      throw new KeychainError('keychain_invalid_value', `Keychain entry ${name} must not be empty`);
    }
    const existing = Object.hasOwn(next, name) ? next[name] : undefined;
    if (existing === undefined) {
      throw new KeychainError('keychain_missing', `Keychain has no entry named ${name}: ${path}`);
    }
    // Rotation replaces the value and keeps the entry's identity and age.
    next[name] = { value, created_at: existing.created_at };
    changed = true;
  }
  for (const [name, value] of Object.entries(change.add ?? {})) {
    if (!KEYCHAIN_NAME_PATTERN.test(name)) {
      throw new KeychainError('keychain_invalid_name', `Invalid keychain entry name: ${name}`);
    }
    if (value.length === 0) {
      throw new KeychainError('keychain_invalid_value', `Keychain entry ${name} must not be empty`);
    }
    if (Object.hasOwn(next, name)) {
      throw new KeychainError('keychain_exists', `Keychain already has an entry named ${name}`);
    }
    next[name] = { value, created_at: new Date().toISOString() };
    changed = true;
  }
  if (!changed) {
    // Nothing to do, and a deployment without a file must not grow an empty one.
    return;
  }
  await writeKeychainFile(path, { version: 1, entries: next });
}

async function writeKeychainFile(
  path: string,
  content: { readonly version: number; readonly entries: Keychain },
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  return await lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );
}

/** An `env` or `command` SecretRef found in the configuration file. */
export interface ExternalSecretReference {
  /** Dot-joined configuration path, e.g. `providers.gw.headers.X-Auth`. */
  readonly path: string;
  readonly kind: 'env' | 'command';
  /** The variable name for `kind: 'env'`; a command's argv is never reported. */
  readonly env?: string;
}

export interface SecretReferenceWalk {
  /** Jar entry name → every dot-joined path that references it. */
  readonly jars: ReadonlyMap<string, readonly string[]>;
  readonly external: readonly ExternalSecretReference[];
}

/**
 * Every secret reference a configuration value carries. The walk is structural
 * rather than a list of SecretRef fields, so a reference added by a later
 * configuration version is still found, and one inside a section that
 * validation would ignore still counts.
 */
export function collectSecretReferences(value: unknown): SecretReferenceWalk {
  const jars = new Map<string, string[]>();
  const external: ExternalSecretReference[] = [];
  walk(value, [], jars, external);
  return { jars, external };
}

function walk(
  value: unknown,
  path: readonly (string | number)[],
  jars: Map<string, string[]>,
  external: ExternalSecretReference[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, [...path, index], jars, external);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    const [only] = entries;
    const label = path.join('.');
    if (entries.length === 1 && only?.[0] === 'jar' && typeof only[1] === 'string') {
      const seen = jars.get(only[1]) ?? [];
      seen.push(label);
      jars.set(only[1], seen);
      return;
    }
    if (entries.length === 1 && only?.[0] === 'env' && typeof only[1] === 'string') {
      external.push({ path: label, kind: 'env', env: only[1] });
      return;
    }
    if (
      entries.length === 1 &&
      only?.[0] === 'command' &&
      Array.isArray(only[1]) &&
      only[1].length > 0 &&
      only[1].every((item) => typeof item === 'string')
    ) {
      external.push({ path: label, kind: 'command' });
      return;
    }
    for (const [key, item] of entries) {
      walk(item, [...path, key], jars, external);
    }
  }
}
