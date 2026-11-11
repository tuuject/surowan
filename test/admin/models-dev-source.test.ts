import { expect, test } from 'vitest';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';
import { adminFixture, call, installAdminProviderHooks, readJson, write } from './providers-fixtures.ts';

installAdminProviderHooks();

/** A mirror serving the models.dev format, with a name that tells the two paths apart. */
function mirrorCatalog(name: string): unknown {
  return {
    mirror: {
      id: 'mirror',
      name: 'Mirror',
      models: {
        'mirror-model': {
          id: 'mirror-model',
          name,
          reasoning: false,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 64_000, output: 4_096 },
          cost: { input: 1, output: 2 },
        },
      },
    },
  };
}

test('the catalog address is a hot setting: the next lookup reads the address just saved', async () => {
  const hits: string[] = [];
  const mirror = await startFixtureServer((incoming) => {
    const path = new URL(incoming.url).pathname;
    hits.push(path);
    return Response.json(mirrorCatalog(path === '/a.json' ? 'Mirror A' : 'Mirror B'));
  });
  const base = `http://127.0.0.1:${mirror.port}`;
  const fixture = await adminFixture();
  // The default catalog must come from the seeded cache: switching back to it
  // may not download it again, here or in production.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('models.dev')) {
      return Promise.reject(new Error('the default catalog was downloaded again'));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const lookup = async () => {
    const body = await readJson(
      await write(fixture, '/api/providers/lookup-metadata', 'POST', {
        kind: 'custom',
        base_url: 'https://relay.example.test/v1',
        api: 'openai-completions',
        ids: ['mirror-model'],
      }),
    );
    expect(body.metadata_source_error).toBeNull();
    return body.models[0];
  };
  try {
    // Unset: the default catalog (seeded for the tests), which lacks the id.
    expect((await lookup()).match).toBeNull();
    const initial = await readJson(await call(fixture, '/api/developer'));
    expect(initial).toMatchObject({
      models_dev_url: null,
      active_models_dev_url: null,
      default_models_dev_url: 'https://models.dev/api.json',
    });

    const first = await write(fixture, '/api/developer', 'PUT', { models_dev_url: `${base}/a.json` }, initial.revision);
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody).toMatchObject({ models_dev_url: `${base}/a.json`, active_models_dev_url: `${base}/a.json` });
    expect(firstBody.apply.restart_required).toEqual([]);
    expect(fixture.file().models_dev).toEqual({ api_url: `${base}/a.json` });
    expect(await lookup()).toMatchObject({ name: 'Mirror A', context_window: 64_000, needs_confirmation: [] });

    // A second address is read on the very next lookup, not after the first
    // catalog's cache runs out.
    const second = await write(
      fixture,
      '/api/developer',
      'PUT',
      { models_dev_url: `${base}/b.json` },
      firstBody.revision,
    );
    const secondBody = await readJson(second);
    expect(second.status).toBe(200);
    expect((await lookup()).name).toBe('Mirror B');
    expect(hits).toEqual(['/a.json', '/b.json']);

    // Only HTTP(S) addresses are accepted; the file keeps the last good one.
    const invalid = await write(
      fixture,
      '/api/developer',
      'PUT',
      { models_dev_url: 'ftp://mirror.example.test/api.json' },
      secondBody.revision,
    );
    expect(invalid.status).toBe(422);
    expect(fixture.file().models_dev).toEqual({ api_url: `${base}/b.json` });

    // Clearing removes the whole section and the default catalog applies again.
    const cleared = await write(fixture, '/api/developer', 'PUT', { models_dev_url: null }, secondBody.revision);
    expect(cleared.status).toBe(200);
    expect(await readJson(cleared)).toMatchObject({ models_dev_url: null, active_models_dev_url: null });
    expect(fixture.file().models_dev).toBeUndefined();
    expect((await lookup()).match).toBeNull();
    expect(hits).toEqual(['/a.json', '/b.json']);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.store.close();
    await stopFixtureServer(mirror.server);
  }
});
