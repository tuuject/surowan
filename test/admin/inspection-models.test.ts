import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { createApiKey } from '../../src/ingress/admin/api-keys.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import { auth, fixture, request } from './inspection-fixtures.ts';

test('the models listing is a read-only active-snapshot projection for keys and sessions', async () => {
  const f = await fixture();
  const before = await readFile(f.configPath, 'utf8');
  for (const headers of [auth(f.key), { cookie: f.cookie }]) {
    const response = await f.server.handle(request('/api/models', { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toEqual({
      source: 'active',
      generation: 1,
      models: [
        {
          provider: 'agent',
          model: 'faux-1',
          name: 'Faux Model',
          context_window: 128_000,
          max_tokens: 16_384,
          input: ['text', 'image'],
          reasoning: false,
          thinking_levels: ['off'],
        },
      ],
    });
    const encoded = JSON.stringify(body);
    // No secrets, connection URLs, headers or credential references escape.
    for (const forbidden of [f.secret, 'api_key', 'example.test', 'base_url', 'headers', 'x-private']) {
      expect(encoded).not.toContain(forbidden);
    }
  }
  // The listing takes no query parameters and requires authentication.
  expect((await f.server.handle(request('/api/models?limit=1', { headers: auth(f.key) }))).status).toBe(400);
  expect((await f.server.handle(request('/api/models'))).status).toBe(401);
  expect(await readFile(f.configPath, 'utf8')).toBe(before);
  expect(f.modelCalls()).toBe(0);
});

test('the models listing filters image-only models and follows the active generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-models-listing-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.providers.clip = {
        kind: 'custom',
        base_url: 'https://example.test/clip/v1',
        api: 'openai-responses',
        api_key: { jar: 'clip' },
        models: [
          {
            id: 'clip-model',
            reasoning: false,
            input: ['image'],
            context_window: 8_000,
            max_tokens: 100,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
      config.providers.reason = {
        kind: 'custom',
        base_url: 'https://example.test/reason/v1',
        api: 'openai-responses',
        api_key: { jar: 'reason' },
        models: [
          {
            id: 'reason-model',
            reasoning: true,
            input: ['text'],
            context_window: 200_000,
            max_tokens: 4_096,
            cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          },
        ],
      };
    }),
  );
  const loaded = await loadConfig(configPath);
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', reasoning: false, input: ['text'], contextWindow: 200_000, maxTokens: 1_024 }],
  });
  const clipFaux = fauxProvider({
    provider: 'clip',
    models: [{ id: 'clip-model', reasoning: false, input: ['image'], contextWindow: 8_000, maxTokens: 100 }],
  });
  const reasonFaux = fauxProvider({
    provider: 'reason',
    models: [{ id: 'reason-model', reasoning: true, input: ['text'], contextWindow: 200_000, maxTokens: 4_096 }],
  });
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(clipFaux.provider);
  models.setProvider(reasonFaux.provider);
  const configStore = await testConfigStore(loaded, { models, visionModel: agentFaux.getModel() });
  const store = await SqliteStore.open(loaded.config);
  try {
    const server = new AdminServer({ store, configStore });
    const key = createApiKey(store.orm, 'models-listing').key;
    const response = await server.handle(request('/api/models', { headers: auth(key) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: 'active',
      generation: 1,
      models: [
        {
          provider: 'agent',
          model: 'agent-model',
          name: 'agent-model',
          context_window: 200_000,
          max_tokens: 1_024,
          input: ['text'],
          reasoning: false,
          thinking_levels: ['off'],
        },
        {
          provider: 'reason',
          model: 'reason-model',
          name: 'reason-model',
          context_window: 200_000,
          max_tokens: 4_096,
          input: ['text'],
          reasoning: true,
          thinking_levels: ['off', 'minimal', 'low', 'medium', 'high'],
        },
      ],
    });
    const encoded = JSON.stringify(await (await server.handle(request('/api/models', { headers: auth(key) }))).json());
    for (const forbidden of ['example.test', 'base_url', 'headers', 'api_key']) {
      expect(encoded).not.toContain(forbidden);
    }
    // A republished snapshot is what the listing follows.
    const current = configStore.current();
    configStore.publish({
      models: current.models,
      visionModel: current.visionModel,
      config: current.config,
      hash: current.hash,
    });
    const republished = await server.handle(request('/api/models', { headers: auth(key) }));
    expect(await republished.json()).toMatchObject({ source: 'active', generation: 2 });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
