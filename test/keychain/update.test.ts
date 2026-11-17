import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { collectSecretReferences, keychainPath, readKeychain, updateKeychain } from '../../src/platform/keychain.ts';
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
  const directory = await mkdtemp(join(tmpdir(), `surowan-keychain-update-${counter}-`));
  directories.push(directory);
  return directory;
}

test('the first add on a fresh directory creates the keychain file', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  expect(await readKeychain(path)).toBeNull();
  await updateKeychain(path, { add: { first: 'first-secret' } });
  const created = await readKeychain(path);
  expect(created?.first).toEqual({ value: 'first-secret', created_at: expect.any(String) });
  if (process.platform !== 'win32') {
    expect(((await import('node:fs/promises')) as typeof import('node:fs/promises')).stat && undefined).toBeUndefined();
  }
});

test('replace against an absent keychain is refused instead of silently skipped', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  await expect(updateKeychain(path, { replace: { ghost: 'x' } })).rejects.toMatchObject({
    code: 'keychain_missing',
  });
  // Nothing was created by the refused replace.
  expect(await readKeychain(path)).toBeNull();
});

test('remove against an absent keychain stays a no-op and grows no file', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  await updateKeychain(path, { remove: ['ghost'] });
  expect(await readKeychain(path)).toBeNull();
});

test('entry names may be Object.prototype keys: constructor and __proto__ round-trip', async () => {
  const directory = await tempDirectory();
  const path = keychainPath(join(directory, 'config.jsonc'));
  // Computed keys: an object literal's `__proto__:` would set the prototype
  // instead of creating the entry.
  await updateKeychain(path, {
    add: { constructor: 'ctor-secret', ['__proto__']: 'proto-secret' } as Record<string, string>,
  });
  const entryOf = (jar: Record<string, { value: string }> | null, name: string) =>
    // Object.entries, not property access: `jar.__proto__` reads the prototype.
    Object.entries(jar ?? {}).find(([key]) => key === name)?.[1];
  const stored = await readKeychain(path);
  expect(entryOf(stored ?? null, 'constructor')).toEqual({ value: 'ctor-secret', created_at: expect.any(String) });
  expect(entryOf(stored ?? null, '__proto__')).toEqual({ value: 'proto-secret', created_at: expect.any(String) });
  expect(Object.keys(stored ?? {}).sort()).toEqual(['__proto__', 'constructor'].sort());

  await updateKeychain(path, { remove: ['constructor'] });
  const after = await readKeychain(path);
  expect(entryOf(after ?? null, 'constructor')).toBeUndefined();
  expect(entryOf(after ?? null, '__proto__')?.value).toBe('proto-secret');

  // The reference walk still finds a jar ref named like a prototype key.
  const walk = collectSecretReferences({ providers: { a: { api_key: { jar: '__proto__' } } } });
  expect([...walk.jars.keys()]).toEqual(['__proto__']);
});

test('a written config can reference an entry named like a prototype key', async () => {
  const directory = await tempDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      data_dir: join(directory, 'data'),
      timezone: 'UTC',
      admin: { host: '127.0.0.1', port: 1 },
      retention: { online_days: 30, backup_copies: 1 },
      paths: {
        database: join(directory, 'data', 'db.sqlite'),
        media_cache: join(directory, 'data', 'media'),
        backups: join(directory, 'data', 'backups'),
      },
      telegram: { bucket_window_seconds: 15, chats: [] },
      providers: {},
    })}\n`,
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600);
  }
  await updateKeychain(keychainPath(configPath), { add: { ['__proto__']: 'proto-secret' } });
  const stored = await readKeychain(keychainPath(configPath));
  expect(Object.entries(stored ?? {}).find(([key]) => key === '__proto__')?.[1]?.value).toBe('proto-secret');
  void readFile;
});
