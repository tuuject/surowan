import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { keychainPath } from '../../src/platform/keychain.ts';
import { adminFixture, installAdminProviderHooks, readJson, revisionOf, write } from './providers-fixtures.ts';

installAdminProviderHooks();

/** The `entries` map of the fixture's key.json. */
async function jarOf(configPath: string): Promise<Record<string, { value: string }>> {
  const raw = JSON.parse(await readFile(keychainPath(configPath), 'utf8')) as {
    entries: Record<string, { value: string }>;
  };
  return raw.entries;
}

test('a rejected config edit rolls back the in-place rotation it carried', async () => {
  const fixture = await adminFixture();
  try {
    // The agent provider's entry is exclusive, so the fresh key rotates it in
    // place; the same request switches the API adapter to one that rejects the
    // provider's compat field, so the edited file fails validation.
    const response = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { api: 'anthropic-messages', api_key: 'agent-new-secret' },
      await revisionOf(fixture),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await readJson(response)).toMatchObject({ error: 'config_invalid' });
    // The rotation rolled back with the rejected write.
    expect((await jarOf(fixture.configPath)).agent?.value).toBe('agent-secret');
    expect(fixture.file().providers.agent).toMatchObject({ api: 'openai-responses' });
  } finally {
    fixture.store.close();
  }
});

test('a failed apply after a replace-only rotation reports the value as written', async () => {
  const fixture = await adminFixture();
  try {
    const response = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { api_key: 'agent-rotated-secret' },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    expect((await jarOf(fixture.configPath)).agent?.value).toBe('agent-rotated-secret');
    const body = (await readJson(response)) as { apply: { applied: readonly string[] } };
    expect(body.apply.applied).toContain('providers.agent.api_key');
  } finally {
    fixture.store.close();
  }
});
