import { expect, test } from 'vitest';
import { resetModelsDevCatalogCache } from '../src/platform/models-dev.ts';
import {
  adminFixture,
  call,
  installAdminProviderHooks,
  readJson,
  revisionOf,
  rewriteFile,
  seedModelsDevCatalog,
  write,
} from './admin-providers-fixtures.ts';
import { startFixtureServer, stopFixtureServer } from './helpers.ts';

installAdminProviderHooks();

test('discovers models in saved mode from the registry connection', async () => {
  const requests: string[] = [];
  const upstream = await startFixtureServer((incoming) => {
    requests.push(new URL(incoming.url).pathname);
    expect(new URL(incoming.url).pathname).toBe('/v1/models');
    expect(incoming.headers.get('authorization')).toBe('Bearer agent-secret');
    expect(incoming.headers.get('x-route')).toBe('header-secret-value');
    return Response.json({
      object: 'list',
      data: [
        {
          id: 'agent-model',
          name: 'Agent Model',
          context_length: 200_000,
          top_provider: { max_completion_tokens: 32_768 },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['reasoning'],
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
        { id: 'fresh-model', name: 'Fresh', context_length: 100_000, top_provider: { max_completion_tokens: 4_096 } },
      ],
    });
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.base_url = `http://127.0.0.1:${upstream.port}/v1`;
    },
  });
  try {
    const discovered = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(discovered.status).toBe(200);
    const body = await readJson(discovered);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toBeNull();
    const existing = body.models.find((entry: any) => entry.id === 'agent-model');
    expect(existing).toMatchObject({ configured: true });
    // The fixture endpoint is OpenAI-shaped without extensions, so only
    // models.dev could have filled the limits, and it does not know this id.
    expect(existing.context_window).toBeNull();
    expect(existing.sources.context_window).toBe('missing');
    const fresh = body.models.find((entry: any) => entry.id === 'fresh-model');
    expect(fresh).toMatchObject({ configured: false });
    expect(fresh.needs_confirmation).toContain('input');

    // A connection change the process could not apply must never send the
    // credentials it resolved to an address that only exists in the file.
    const changed = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { base_url: `http://127.0.0.1:${upstream.port}/v2`, api_key: 'agent-secret', headers: { 'x-route': 'r' } },
      await revisionOf(fixture),
    );
    expect(changed.status).toBe(200);
    expect(requests).toEqual(['/v1/models']);

    // The file now describes another address and a pending restart-only field
    // the running process cannot adopt, so nothing of the file is applied.
    await rewriteFile(fixture, (config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent!.context!.idle_grace_seconds = 10;
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.base_url = `http://127.0.0.1:${upstream.port}/v3`;
    });
    const refused = await write(fixture, '/api/config/apply', 'POST', {}, null);
    expect(refused.status).toBe(422);
    expect(await readJson(refused)).toMatchObject({ error: 'candidate_invalid' });

    const pending = await write(fixture, '/api/providers/discover', 'POST', { alias: 'agent' });
    expect(pending.status).toBe(409);
    expect(await readJson(pending)).toMatchObject({ error: 'connection_not_applied' });
    // Nothing was sent anywhere: the saved mode refuses before it dials.
    expect(requests).toEqual(['/v1/models']);
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('redacts an upstream error that echoes the submitted key', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({ error: { message: 'invalid key: temporary-secret' } }, { status: 401 }),
  );
  const fixture = await adminFixture();
  try {
    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.error).toBe('provider_discovery_failed');
    expect(body.message).toContain('[REDACTED]');
    expect(body.message).not.toContain('temporary-secret');
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('still lists models when the models.dev catalog is unreachable', async () => {
  const upstream = await startFixtureServer(() =>
    Response.json({
      object: 'list',
      data: [{ id: 'fresh-model', name: 'Fresh' }],
    }),
  );
  const fixture = await adminFixture();
  const originalFetch = globalThis.fetch;
  try {
    resetModelsDevCatalogCache();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('models.dev')) {
        return Promise.reject(new Error('models.dev is unreachable'));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await write(fixture, '/api/providers/discover', 'POST', {
      kind: 'custom',
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api: 'openai-completions',
      api_key: 'temporary-secret',
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.endpoint).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);
    expect(body.metadata_source_error).toContain('models.dev is unreachable');
    // The listing survives; only the metadata models.dev would have supplied is
    // missing, and the admin confirms it in the edit dialog.
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ id: 'fresh-model', context_window: null });
    expect(body.models[0].needs_confirmation).toContain('context_window');

    const lookup = await write(fixture, '/api/providers/lookup-metadata', 'POST', {
      kind: 'custom',
      base_url: 'https://relay.example.test/v1',
      api: 'openai-completions',
      ids: ['some-model'],
    });
    expect(lookup.status).toBe(200);
    const lookupBody = await readJson(lookup);
    expect(lookupBody.metadata_source_error).toContain('models.dev is unreachable');
    expect(lookupBody.models[0].sources.context_window).toBe('missing');
  } finally {
    globalThis.fetch = originalFetch;
    fixture.store.close();
    await stopFixtureServer(upstream.server);
    await seedModelsDevCatalog();
  }
});

test('answers a malformed model id with a request error, not a server error', async () => {
  const fixture = await adminFixture();
  try {
    const response = await call(fixture, '/api/providers/agent/models/%ZZ', {
      method: 'DELETE',
      headers: { 'if-match': await revisionOf(fixture) },
    });
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: 'invalid_path' });
  } finally {
    fixture.store.close();
  }
});
