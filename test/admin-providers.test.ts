import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  adminFixture,
  call,
  installAdminProviderHooks,
  model,
  readJson,
  revisionOf,
  write,
} from './admin-providers-fixtures.ts';

installAdminProviderHooks();

test('lists providers without leaking keys or header values', async () => {
  const fixture = await adminFixture();
  try {
    const response = await call(fixture, '/api/providers');
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const view = await readJson(response);
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(view.supervised).toBe(false);
    expect(view.agent).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
    expect(view.vision).toEqual({ provider: 'vision', model: 'vision-model' });
    expect(view.restart_required).toEqual([]);
    const agent = view.providers.find((entry: any) => entry.alias === 'agent');
    expect(agent).toMatchObject({ kind: 'custom', api: 'openai-responses', base_url: 'https://example.test/v1' });
    expect(agent.header_names).toEqual(['x-route']);
    expect(agent.models).toHaveLength(1);
    expect(agent.models[0]).toMatchObject({ id: 'agent-model', compat: { supports_developer_role: false } });

    // The whole response body, not just the fields under test.
    expect(text).not.toContain('agent-secret');
    expect(text).not.toContain('header-secret-value');
    expect(text).not.toContain('vision-secret');
  } finally {
    fixture.store.close();
  }
});

test('offers the builtin presets the configuration may reference', async () => {
  const fixture = await adminFixture();
  try {
    const view = await readJson(await call(fixture, '/api/provider-presets'));
    const ids = view.presets.map((preset: any) => preset.id);
    expect(ids).toContain('google');
    // Rejected by the preset predicate: a mixed catalog (pi 1.x ships OpenRouter
    // with openai-completions and anthropic-messages chat models, so it stays
    // configurable through an existing alias but is not offered as a preset), an
    // unsupported adapter, or no concrete base URL. xai now ships one uniform
    // supported adapter, so it qualifies.
    expect(ids).toContain('xai');
    expect(ids).not.toContain('openrouter');
    expect(ids).not.toContain('mistral');
    expect(ids).not.toContain('google-vertex');
  } finally {
    fixture.store.close();
  }
});

test('requires a revision for every provider write', async () => {
  const fixture = await adminFixture();
  try {
    const missing = await write(fixture, '/api/providers', 'POST', { alias: 'relay' });
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'revision_required' });

    const stale = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'relay-secret',
        models: [model('relay-model')],
      },
      'f'.repeat(64),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });
    expect(fixture.file().providers.relay).toBeUndefined();

    const modelPut = await call(fixture, '/api/model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'vision', model: 'vision-model' }),
    });
    expect(modelPut.status).toBe(400);
    expect(await readJson(modelPut)).toMatchObject({ error: 'revision_required' });
  } finally {
    fixture.store.close();
  }
});

test('creates, updates, and deletes a provider through the configuration file', async () => {
  const fixture = await adminFixture();
  try {
    const created = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1/',
        api: 'openai-completions',
        api_key: 'relay-secret',
        headers: { 'x-route': 'relay-header' },
        models: [model('relay-model', { input: ['text', 'image'] })],
      },
      await revisionOf(fixture),
    );
    expect(created.status).toBe(200);
    const createdView = await readJson(created);
    expect(createdView.apply).toMatchObject({ applied: ['providers.relay'], restart_required: [] });
    const relay = createdView.providers.find((entry: any) => entry.alias === 'relay');
    expect(relay).toMatchObject({
      kind: 'custom',
      api: 'openai-completions',
      base_url: 'https://relay.example.test/v1',
      header_names: ['x-route'],
    });
    // Plaintext goes into key.json; the config file only names the entries, and
    // neither is echoed back.
    const text = await fixture.read();
    expect(text).not.toContain('relay-secret');
    expect(text).not.toContain('relay-header');
    const createdRelay = fixture.file().providers.relay;
    expect(createdRelay?.api_key).toEqual({ jar: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(fixture.secret(createdRelay?.api_key)).toBe('relay-secret');
    expect(createdRelay?.kind === 'custom' && fixture.secret(createdRelay.headers?.['x-route'])).toBe('relay-header');
    expect(JSON.stringify(createdView)).not.toContain('relay-secret');
    expect(JSON.stringify(createdView)).not.toContain('relay-header');
    expect(JSON.stringify(createdView)).not.toContain(JSON.stringify(createdRelay?.api_key));

    const duplicate = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'relay',
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        api_key: 'other',
        models: [model('relay-model')],
      },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'provider_exists' });

    // Changing the address forces the credentials to be re-entered (C5).
    const withoutKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { base_url: 'https://attacker.example.test/v1' },
      await revisionOf(fixture),
    );
    expect(withoutKey.status).toBe(400);
    expect(await readJson(withoutKey)).toMatchObject({ error: 'credentials_required' });
    expect(fixture.file().providers.relay).toMatchObject({ base_url: 'https://relay.example.test/v1' });

    const withKey = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      {
        base_url: 'https://relay.example.test/v2',
        api_key: 'relay-secret-2',
        headers: { 'x-route': 'relay-header-2' },
      },
      await revisionOf(fixture),
    );
    expect(withKey.status).toBe(200);
    // The connection change is hot: the same reload adopts the new address, key
    // and headers, and the registry serves them from now on.
    const withKeyView = await readJson(withKey);
    expect(withKeyView.apply).toMatchObject({
      applied: ['providers.relay.api_key.jar', 'providers.relay.base_url', 'providers.relay.headers.x-route.jar'],
      restart_required: [],
    });
    expect(fixture.configStore.current().models.getProvider('relay')?.baseUrl).toBe('https://relay.example.test/v2');
    const updated = fixture.file().providers.relay;
    expect(updated).toMatchObject({ base_url: 'https://relay.example.test/v2' });
    expect(fixture.secret(updated?.api_key)).toBe('relay-secret-2');
    expect(updated?.kind === 'custom' && fixture.secret(updated.headers?.['x-route'])).toBe('relay-header-2');
    // A replaced secret gets a new entry, and the one it replaced is gone.
    expect(updated?.api_key).not.toEqual(createdRelay?.api_key);
    expect(Object.values(JSON.parse(await readFile(join(fixture.directory, 'key.json'), 'utf8')))).not.toContain(
      'relay-secret',
    );

    // A header is dropped with `null`; the key stays when it is omitted.
    const dropped = await write(
      fixture,
      '/api/providers/relay',
      'PUT',
      { headers: { 'x-route': null } },
      await revisionOf(fixture),
    );
    expect(dropped.status).toBe(200);
    expect(fixture.file().providers.relay).not.toHaveProperty('headers');
    expect(fixture.file().providers.relay?.api_key).toEqual(updated?.api_key);
    expect(fixture.secret(updated?.api_key)).toBe('relay-secret-2');

    const removed = await write(fixture, '/api/providers/relay', 'DELETE', {}, await revisionOf(fixture));
    expect(removed.status).toBe(200);
    expect(fixture.file().providers.relay).toBeUndefined();
    // Only the entries the fixture configuration itself references are left.
    expect(fixture.jarNames()).toEqual(['agent', 'builtin', 'header', 'telegram', 'vision']);
  } finally {
    fixture.store.close();
  }
});

test('refuses a builtin provider edit that is not its key', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.builtin = {
        kind: 'builtin',
        provider: 'openrouter',
        api_key: { jar: 'builtin' },
        models: [model('deepseek/deepseek-v4-flash-0731')],
      };
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/providers'));
    const builtin = view.providers.find((entry: any) => entry.alias === 'builtin');
    expect(builtin).toMatchObject({
      kind: 'builtin',
      provider: 'openrouter',
      api: 'openai-completions',
      base_url: 'https://openrouter.ai/api/v1',
      header_names: [],
    });

    const rejected = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api: 'anthropic-messages' },
      await revisionOf(fixture),
    );
    expect(rejected.status).toBe(400);
    expect(await readJson(rejected)).toMatchObject({ error: 'immutable_field' });

    const key = await write(
      fixture,
      '/api/providers/builtin',
      'PUT',
      { api_key: 'rotated' },
      await revisionOf(fixture),
    );
    expect(key.status).toBe(200);
    expect(fixture.secret(fixture.file().providers.builtin?.api_key)).toBe('rotated');
    expect(fixture.jarNames()).not.toContain('builtin');
  } finally {
    fixture.store.close();
  }
});
