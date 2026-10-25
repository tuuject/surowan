import { describe, expect, test } from 'vitest';
import { resetModelsDevCatalogCache, loadModelsDevCatalog } from '../../src/platform/models-dev.ts';
import { assertBaseUrl, fetchProviderModels, planModelsEndpoint } from '../../src/platform/provider-models.ts';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';

describe('provider model listing', () => {
  test('plans the endpoint per API and keeps the Vercel gateway special case first', () => {
    expect(planModelsEndpoint({ baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' }).endpoint).toBe(
      'https://api.anthropic.com/v1/models',
    );
    expect(
      planModelsEndpoint({
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'https://ai-gateway.vercel.sh',
        api: 'anthropic-messages',
      }),
    ).toMatchObject({ endpoint: 'https://ai-gateway.vercel.sh/v1/models', auth: 'bearer', format: 'vercel' });
    expect(planModelsEndpoint({ baseUrl: 'https://ai-gateway.vercel.sh', api: 'openai-completions' })).toMatchObject({
      format: 'vercel',
      endpoint: 'https://ai-gateway.vercel.sh/v1/models',
    });
    expect(
      planModelsEndpoint({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' }),
    ).toMatchObject({
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: 'x-goog-api-key',
      paginated: true,
    });
    expect(planModelsEndpoint({ baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' })).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1/models',
      format: 'openrouter',
      auth: 'bearer',
    });
    expect(planModelsEndpoint({ baseUrl: 'https://example.test/v1', api: 'openai-responses' })).toMatchObject({
      endpoint: 'https://example.test/v1/models',
      format: 'openai',
      auth: 'bearer',
    });
    expect(() => assertBaseUrl('https://example.test/v1')).not.toThrow();
    expect(() => assertBaseUrl('not-a-url')).toThrow();
  });

  test('follows Gemini pagination and keeps only generateContent models', async () => {
    const pages: string[] = [];
    const server = await startFixtureServer((request) => {
      const url = new URL(request.url);
      pages.push(`${url.pathname}?${url.searchParams.toString()}`);
      const pageToken = url.searchParams.get('pageToken');
      if (pageToken === null) {
        return Response.json({
          models: [
            {
              name: 'models/gemini-3.7-flash',
              displayName: 'Gemini 3.7 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'page-2',
        });
      }
      return Response.json({
        models: [{ name: 'models/gemini-3.7-pro', thinking: true, supportedGenerationMethods: ['generateContent'] }],
      });
    });
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${server.port}/v1beta`,
        api: 'google-generative-ai',
        apiKey: 'gemini-key',
      });
      expect(listing.models.map((model) => model.id)).toEqual(['gemini-3.7-flash', 'gemini-3.7-pro']);
      expect(pages).toEqual(['/v1beta/models?pageSize=1000', '/v1beta/models?pageSize=1000&pageToken=page-2']);
      const pro = listing.models.find((model) => model.id === 'gemini-3.7-pro');
      expect(pro?.extension).toMatchObject({ format: 'gemini', payload: { thinking: true } });
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('authenticates the Vercel gateway listing and drops non-language models', async () => {
    let authorization = '';
    let path = '';
    const server = await startFixtureServer((request) => {
      path = new URL(request.url).pathname;
      authorization = request.headers.get('authorization') ?? '';
      return Response.json({
        object: 'list',
        data: [
          { id: 'anthropic/claude-sonnet-4.5', type: 'language', context_window: 1000000 },
          { id: 'openai/text-embedding-3', type: 'embedding' },
        ],
      });
    });
    try {
      const listing = await fetchProviderModels({
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: `http://127.0.0.1:${server.port}`,
        api: 'anthropic-messages',
        apiKey: 'gateway-key',
      });
      expect(path).toBe('/v1/models');
      expect(authorization).toBe('Bearer gateway-key');
      expect(listing.models.map((model) => model.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('follows Anthropic pagination with the x-api-key header', async () => {
    const requests: string[] = [];
    const server = await startFixtureServer((request) => {
      const url = new URL(request.url);
      requests.push(`${url.searchParams.get('after_id') ?? '-'}|${request.headers.get('x-api-key') ?? ''}`);
      const after = url.searchParams.get('after_id');
      if (after === null) {
        return Response.json({
          data: [{ id: 'claude-a', display_name: 'Claude A' }],
          has_more: true,
          last_id: 'claude-a',
        });
      }
      return Response.json({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' });
    });
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${server.port}`,
        api: 'anthropic-messages',
        apiKey: 'anthropic-key',
      });
      expect(requests).toEqual(['-|anthropic-key', 'claude-a|anthropic-key']);
      expect(listing.models).toEqual([
        { id: 'claude-a', name: 'Claude A', extension: { format: 'anthropic' } },
        { id: 'claude-b', name: null, extension: { format: 'anthropic' } },
      ]);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  // OpenRouter's own listing was 737 KB on 2026-09-21 and grows with every model
  // it adds, so a megabyte-sized page must go through.
  test('reads a listing larger than one megabyte', async () => {
    const filler = 'd'.repeat(1_400);
    const server = await startFixtureServer(() =>
      Response.json({
        data: Array.from({ length: 1_000 }, (_, index) => ({
          id: `vendor/model-${String(index)}`,
          description: filler,
        })),
      }),
    );
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        api: 'openai-completions',
        apiKey: 'key',
      });
      expect(listing.models).toHaveLength(1_000);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('stops reading an oversized listing that declares no length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1_048_576));
    let produced = 0;
    const server = await startFixtureServer(
      () =>
        new Response(
          // No content-length: the cap only holds if the bytes are counted as
          // they arrive. The producer stops on its own so the test cannot hang.
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 1;
              if (produced > 64) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    try {
      await expect(
        fetchProviderModels({
          baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
          api: 'openai-completions',
          apiKey: 'key',
        }),
      ).rejects.toThrow(/exceeds/);
      expect(produced).toBeLessThan(64);
    } finally {
      await stopFixtureServer(server.server);
    }
  });
});

describe('models.dev catalog cache', () => {
  test('caches the catalog and does not cache failures', async () => {
    resetModelsDevCatalogCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          openrouter: { id: 'openrouter', name: 'OpenRouter', models: { 'a/b': { id: 'a/b', name: 'AB' } } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const first = await loadModelsDevCatalog({ fetchImpl, ttlMs: 60_000 });
    const second = await loadModelsDevCatalog({ fetchImpl, ttlMs: 60_000 });
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.openrouter?.models['a/b']?.modalities.input).toEqual(['text']);

    resetModelsDevCatalogCache();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(loadModelsDevCatalog({ fetchImpl: failing })).rejects.toThrow('offline');
    await expect(loadModelsDevCatalog({ fetchImpl: failing })).rejects.toThrow('offline');
  });
});
