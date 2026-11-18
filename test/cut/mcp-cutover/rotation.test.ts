import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { keychainPath, updateKeychain } from '../../../src/platform/keychain.ts';
import { CHAT_A, CHAT_B, type Fixture, fixture } from './shared.ts';

async function rotate(f: Fixture, name: string, value: string): Promise<void> {
  await updateKeychain(keychainPath(join(f.directory, 'config.jsonc')), { replace: { [name]: value } });
}

/**
 * Rotating a keychain entry reconnects exactly the MCP servers that use it —
 * like a hot `mcp.servers` change — instead of waiting for a restart. The
 * fixture's stdio servers carry `env` jar references and the HTTP one carries a
 * `headers` jar reference; the delta server's reference is command-backed.
 */
test('rotating an env entry reconnects only the server that uses it', async () => {
  const f = await fixture();
  const alphaPid = await f.pidOf('alpha');
  const betaPid = await f.pidOf('beta');
  await rotate(f, 'alpha-key', 'alpha-key-v2');
  // The file is unchanged: the rotation alone is the published change.
  const result = await f.apply(f.configStore.current().config, new Set(['alpha']));
  expect(result.servers.replaced).toEqual(['alpha']);
  expect(result.servers.added).toEqual([]);
  expect(result.affectedChats).toContain(CHAT_A);
  await expect.poll(async () => (await f.pidOf('alpha')) !== alphaPid, { timeout: 10_000 }).toBe(true);
  expect(await f.pidOf('beta')).toBe(betaPid);
});

test('an HTTP server whose headers entry rotates is replaced too', async () => {
  const f = await fixture();
  await rotate(f, 'gamma-key', 'gamma-key-v2');
  const result = await f.apply(f.configStore.current().config, new Set(['remote']));
  expect(result.servers.replaced).toContain('remote');
  // The endpoint is unreachable: the replacement degrades with the usual backoff.
  await expect.poll(() => f.stateOf('remote')?.state).toBe('degraded');
});

test('a command-backed reference is executed zero times by the rotation check', async () => {
  const f = await fixture();
  const marker = join(f.directory, 'scripted-marker.txt');
  const before = await readFile(marker, 'utf8');
  await rotate(f, 'alpha-key', 'alpha-key-v3');
  await f.apply(f.configStore.current().config, new Set(['alpha']));
  // The digest of a `command` reference is a constant: the check never runs it.
  expect(await readFile(marker, 'utf8')).toBe(before);
});

test('a Chat bound to the rotated server goes through the cutover', async () => {
  const f = await fixture();
  const result = await f.apply(f.configStore.current().config, new Set(['beta']));
  expect(result.affectedChats).toContain(CHAT_B);
  expect(result.affectedChats).not.toContain(CHAT_A);
});
