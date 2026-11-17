import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  collectSecretReferences,
  KEYCHAIN_NAME_PATTERN,
  KeychainError,
  keychainPath,
  migrateKeychain,
  nextEntryName,
  readKeychain,
  sanitizeEntryName,
  updateKeychain,
} from '../../src/platform/keychain.ts';
import { afterThisTest } from '../helpers.ts';

const directories: string[] = [];

afterThisTest(
  async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  },
  () => undefined,
);

let counter = 0;

async function tempDirectory(): Promise<string> {
  counter += 1;
  const directory = await mkdtemp(join(tmpdir(), `surowan-keychain-${counter}-`));
  directories.push(directory);
  return directory;
}

async function writeOldJar(directory: string, entries: Record<string, string>): Promise<string> {
  const path = keychainPath(join(directory, 'config.jsonc'));
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
  return path;
}

test('migration turns the old flat format into the keychain format in place', async () => {
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { openrouter: 'sk-or', telegram: 'tg-token' });
  expect(await migrateKeychain(path)).toBe(true);
  const migrated = await readKeychain(path);
  expect(migrated?.openrouter).toEqual({ value: 'sk-or', created_at: expect.any(String) });
  expect(migrated?.telegram?.value).toBe('tg-token');
  expect(Object.keys(migrated ?? {})).toEqual(['openrouter', 'telegram']);
  // Idempotent: the second run leaves the file alone.
  const before = await readFile(path, 'utf8');
  expect(await migrateKeychain(path)).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(before);
});

test('an entry named version is data, not the format marker', async () => {
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { version: '1.2.3', other: 'value' });
  expect(await migrateKeychain(path)).toBe(true);
  const migrated = await readKeychain(path);
  expect(migrated?.version).toEqual({ value: '1.2.3', created_at: expect.any(String) });
});

test('a new-format file is not migrated again', async () => {
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { a: 'b' });
  await migrateKeychain(path);
  const before = await readFile(path, 'utf8');
  expect(await migrateKeychain(path)).toBe(false);
  expect(await readFile(path, 'utf8')).toBe(before);
});

test('a missing file reads as nothing to migrate', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  expect(await readKeychain(path)).toBeNull();
  expect(await migrateKeychain(path)).toBe(false);
});

test('reading the old format fails with an actionable message instead of silently converting', async () => {
  const directory = await tempDirectory();
  // A value no temp path can contain, so the leak assertion cannot match the path.
  const secret = 'old-format-secret-value';
  const path = await writeOldJar(directory, { a: secret });
  expect(await migrateKeychain(path)).toBe(true);
  // Revert the file to the old shape by hand.
  await writeFile(path, `${JSON.stringify({ a: secret }, null, 2)}\n`, { mode: 0o600 });
  const error = await readKeychain(path).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(KeychainError);
  expect((error as Error).message).toContain('migrate');
  expect((error as Error).message).toContain(path);
  expect((error as Error).message).not.toContain(secret);
});

test('a file with mode other than 0600 is refused', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { a: 'b' });
  await chmod(path, 0o644);
  await expect(migrateKeychain(path)).rejects.toThrow('0600');
  await expect(readKeychain(path)).rejects.toThrow('0600');
});

test('a symbolic link is refused instead of being replaced', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { a: 'b' });
  const target = join(directory, 'elsewhere.json');
  await writeFile(target, '{}\n', { mode: 0o600 });
  await symlink(target, path);
  await expect(migrateKeychain(path)).rejects.toThrow('symbolic link');
  // The link and its target survive.
  expect(await lstat(path)).toBeTruthy();
});

test('a corrupt file produces an error that never quotes the contents', async () => {
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { a: 'b' });
  await writeFile(path, '{"a": "sk-corrupt }', { mode: 0o600 });
  const error = await readKeychain(path).catch((caught: unknown) => caught);
  expect((error as Error).message).not.toContain('sk-corrupt');
});

test('an unreadable entry shape is named, not echoed', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, entries: { broken: { value: 42, created_at: 'x' } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await expect(readKeychain(path)).rejects.toThrow(/broken/);
});

test('add replaces remove follow the keychain rules', async () => {
  const directory = await tempDirectory();
  const path = await writeOldJar(directory, { alpha: 'one' });
  await migrateKeychain(path);
  const created = (await readKeychain(path))?.alpha?.created_at;

  await updateKeychain(path, { add: { beta: 'two' } });
  expect((await readKeychain(path))?.beta?.value).toBe('two');

  // An added name must be new.
  await expect(updateKeychain(path, { add: { alpha: 'no' } })).rejects.toMatchObject({ code: 'keychain_exists' });

  // A replaced entry keeps its age; a replaced name must exist.
  await updateKeychain(path, { replace: { alpha: 'one-v2' } });
  const replaced = await readKeychain(path);
  expect(replaced?.alpha?.value).toBe('one-v2');
  expect(replaced?.alpha?.created_at).toBe(created);
  await expect(updateKeychain(path, { replace: { gamma: 'x' } })).rejects.toMatchObject({
    code: 'keychain_missing',
  });

  await updateKeychain(path, { remove: ['beta'] });
  expect((await readKeychain(path))?.beta).toBeUndefined();

  // Names and values are validated on the way in.
  await expect(updateKeychain(path, { add: { 'bad name!': 'x' } })).rejects.toMatchObject({
    code: 'keychain_invalid_name',
  });
  await expect(updateKeychain(path, { add: { ok: '' } })).rejects.toMatchObject({
    code: 'keychain_invalid_value',
  });

  // A change that touches nothing must not create a file that was absent.
  const other = await mkdtemp(join(tmpdir(), 'surowan-keychain-absent-'));
  directories.push(other);
  const absent = keychainPath(join(other, 'config.jsonc'));
  await updateKeychain(absent, { remove: ['ghost'] });
  expect(await readKeychain(absent)).toBeNull();
});

test('entry names, derived names and the reference walk follow the keychain rules', () => {
  expect(KEYCHAIN_NAME_PATTERN.test('openrouter')).toBe(true);
  expect(KEYCHAIN_NAME_PATTERN.test('gw-X_Auth-2')).toBe(true);
  expect(KEYCHAIN_NAME_PATTERN.test('')).toBe(false);
  expect(KEYCHAIN_NAME_PATTERN.test('x'.repeat(65))).toBe(false);
  expect(sanitizeEntryName('OpenRouter / v1')).toBe('OpenRouter---v1');
  expect(sanitizeEntryName('x'.repeat(80))).toBe('x'.repeat(64));

  const taken = new Set(['openrouter', 'openrouter-2', 'openrouter-3']);
  expect(nextEntryName('openrouter', taken)).toBe('openrouter-4');
  expect(nextEntryName('brand new', taken)).toBe('brand-new');

  const walk = collectSecretReferences({
    providers: {
      a: { kind: 'custom', api_key: { jar: 'alpha' }, headers: { 'x-a': { env: 'HEADER_SECRET' } } },
    },
    telegram: { token: { command: ['secret-tool', 'lookup', 'x'] } },
    image: { credentials: { openrouter: { jar: 'alpha' } } },
    ignored: [{ api_key: { jar: 'in-array' } }],
  });
  expect([...walk.jars.entries()]).toEqual([
    ['alpha', ['providers.a.api_key', 'image.credentials.openrouter']],
    ['in-array', ['ignored.0.api_key']],
  ]);
  expect(walk.external).toEqual([
    { path: 'providers.a.headers.x-a', kind: 'env', env: 'HEADER_SECRET' },
    { path: 'telegram.token', kind: 'command' },
  ]);
});
