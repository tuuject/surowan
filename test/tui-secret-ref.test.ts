import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { keychainPath, readKeychain, updateKeychain } from '../src/platform/keychain.ts';

const directories: string[] = [];

afterEach(async () => {
  vi.doUnmock('@inquirer/prompts');
  vi.resetModules();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function keychainDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-tui-secret-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeFile(configPath, '{ "version": 1 }\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600);
  }
  return keychainPath(configPath);
}

test('a typed secret derives its entry name from where it is used', async () => {
  // The shared registry may already hold the real @inquirer/prompts bindings;
  // reset before mocking so the dynamic import re-evaluates against the spies.
  vi.resetModules();
  const keychainFile = await keychainDirectory();
  const select = vi.fn(async () => 'new');
  const password = vi.fn(async () => 'typed-secret');
  const input = vi.fn(async (options: { default?: string; validate?: (value: string) => unknown }) => {
    // The wizard prefills the derived name; the test keeps it.
    const name = options.default ?? '';
    expect(await options.validate?.(name)).toBe(true);
    return name;
  });
  vi.doMock('@inquirer/prompts', () => ({ select, password, input, search: vi.fn(), checkbox: vi.fn() }));
  const { promptSecretRef } = await import('../src/tui/prompts.ts');
  const reference = await promptSecretRef('API key', keychainFile, { suggestedName: 'openrouter' });
  expect(input.mock.calls[0]?.[0]?.default).toBe('openrouter');
  expect(reference).toEqual({ jar: 'openrouter' });
  const jar = await readKeychain(keychainFile);
  expect(jar?.openrouter).toEqual({ value: 'typed-secret', created_at: expect.any(String) });
});

test('a header secret is offered `<alias>-<header>` and a taken name cannot be stored', async () => {
  vi.resetModules();
  const keychainFile = await keychainDirectory();
  await updateKeychain(keychainFile, { add: { 'openrouter-x-auth': 'taken' } });
  const select = vi.fn(async () => 'new');
  const password = vi.fn(async () => 'header-secret');
  const input = vi.fn(async (options: { default?: string; validate?: (value: string) => unknown }) => {
    // The wizard prefilled `<alias>-<header>`; the scan suffixed it because the
    // derived name was already taken by another entry.
    const name = options.default ?? '';
    expect(name).toBe('openrouter-x-auth-2');
    // The unsuffixed derived name collides: the validate callback refuses it.
    expect(options.validate?.('openrouter-x-auth')).toBe('Keychain already has an entry named openrouter-x-auth');
    expect(await options.validate?.(name)).toBe(true);
    return name;
  });
  vi.doMock('@inquirer/prompts', () => ({ select, password, input, search: vi.fn(), checkbox: vi.fn() }));
  const { promptSecretRef } = await import('../src/tui/prompts.ts');
  const reference = await promptSecretRef('Value for "x-auth"', keychainFile, {
    suggestedName: 'openrouter-x-auth',
  });
  expect(reference).toEqual({ jar: 'openrouter-x-auth-2' });
  const jar = await readKeychain(keychainFile);
  expect(jar?.['openrouter-x-auth-2']?.value).toBe('header-secret');
  expect(jar?.['openrouter-x-auth']?.value).toBe('taken');
});
