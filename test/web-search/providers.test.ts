import { expect, test } from 'vitest';
import type { SearchProviderSpec } from '../../src/plugins/web-search/extension.ts';
import { brave } from '../../src/plugins/web-search/providers/brave.ts';
import { deepseek } from '../../src/plugins/web-search/providers/deepseek.ts';
import { exa } from '../../src/plugins/web-search/providers/exa.ts';
import { firecrawl } from '../../src/plugins/web-search/providers/firecrawl.ts';
import { searxng } from '../../src/plugins/web-search/providers/searxng.ts';
import { tavily } from '../../src/plugins/web-search/providers/tavily.ts';
import { youcom } from '../../src/plugins/web-search/providers/youcom.ts';
import { PROVIDERS } from './fixtures.ts';

interface Built {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function build(
  provider: SearchProviderSpec,
  overrides: { readonly endpoint?: string; readonly key?: string | undefined } = {},
): Built {
  const request = provider.build({
    query: 'cats',
    count: 3,
    endpoint: overrides.endpoint ?? provider.rule.defaultEndpoint ?? '',
    key: 'key' in overrides ? overrides.key : 'secret',
  });
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}

test('every bundled provider contributes exactly one rule', () => {
  expect(PROVIDERS.map((provider) => provider.rule.id)).toEqual([
    'tavily',
    'brave',
    'exa',
    'firecrawl',
    'deepseek',
    'searxng',
    'youcom',
  ]);
});

test('Tavily posts the query with a bearer token', () => {
  const built = build(tavily);
  expect(built.url).toBe('https://api.tavily.com/search');
  expect(built.method).toBe('POST');
  expect(built.headers.authorization).toBe('Bearer secret');
  expect(JSON.parse(built.body ?? '{}')).toMatchObject({ query: 'cats', max_results: 3 });
});

test('Brave sends the subscription token in its own header', () => {
  const built = build(brave);
  expect(built.url).toBe('https://api.search.brave.com/res/v1/web/search?q=cats&count=3');
  expect(built.method).toBe('GET');
  expect(built.headers['x-subscription-token']).toBe('secret');
  expect(built.body).toBeUndefined();
});

test('Exa asks for a short text and authenticates with x-api-key', () => {
  const built = build(exa);
  expect(built.url).toBe('https://api.exa.ai/search');
  expect(built.headers['x-api-key']).toBe('secret');
  expect(JSON.parse(built.body ?? '{}')).toMatchObject({ query: 'cats', numResults: 3 });
});

test('Firecrawl posts a web search with a limit', () => {
  const built = build(firecrawl);
  expect(built.url).toBe('https://api.firecrawl.dev/v2/search');
  expect(built.headers.authorization).toBe('Bearer secret');
  expect(JSON.parse(built.body ?? '{}')).toMatchObject({ query: 'cats', limit: 3, sources: ['web'] });
});

test('DeepSeek posts to its tools search API with a count and honours an override endpoint', () => {
  expect(deepseek.rule.defaultEndpoint).toBe('https://api.deepseek.com/v1/tools/search');
  const built = build(deepseek, { endpoint: 'https://relay.example/search' });
  expect(built.url).toBe('https://relay.example/search');
  expect(built.headers.authorization).toBe('Bearer secret');
  expect(JSON.parse(built.body ?? '{}')).toEqual({ query: 'cats', count: 3 });
});

test('SearXNG composes /search, asks for JSON and sends no credential or count', () => {
  const root = build(searxng, { endpoint: 'https://sx.example.com', key: undefined });
  expect(root.url).toBe('https://sx.example.com/search?q=cats&format=json');
  expect(root.headers['x-api-key']).toBeUndefined();
  expect(root.headers.authorization).toBeUndefined();
  expect(root.body).toBeUndefined();
  const trailing = build(searxng, { endpoint: 'https://sx.example.com/', key: undefined });
  expect(trailing.url).toBe('https://sx.example.com/search?q=cats&format=json');
  const prefixed = build(searxng, { endpoint: 'https://example.com/searxng', key: undefined });
  expect(prefixed.url).toBe('https://example.com/searxng/search?q=cats&format=json');
});

test('You.com sends its key in X-API-Key and requires one', () => {
  expect(youcom.rule.keyPolicy).toBe('required');
  const keyed = build(youcom);
  expect(keyed.url).toBe('https://ydc-index.io/v1/search?query=cats&count=3');
  expect(keyed.headers['x-api-key']).toBe('secret');
});

test('You.com reads the snippets array and falls back to the description', () => {
  expect(
    youcom.parse({
      results: {
        web: [
          { title: 'T', url: 'https://a.example', description: 'D', snippets: ['one', 'two'] },
          { title: 'U', url: 'https://b.example', description: 'D', snippets: [] },
        ],
      },
    }),
  ).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'one two' },
    { title: 'U', url: 'https://b.example', snippet: 'D' },
  ]);
});

test('each provider reads its own successful payload shape', () => {
  const hit = (provider: SearchProviderSpec, payload: unknown) => provider.parse(payload);
  expect(hit(tavily, { results: [{ title: 'T', url: 'https://a.example', content: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(brave, { web: { results: [{ title: 'T', url: 'https://a.example', description: 'S' }] } })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(exa, { results: [{ title: 'T', url: 'https://a.example', text: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(
    hit(firecrawl, { success: true, data: { web: [{ title: 'T', url: 'https://a.example', description: 'S' }] } }),
  ).toEqual([{ title: 'T', url: 'https://a.example', snippet: 'S' }]);
  expect(hit(firecrawl, { data: [{ title: 'T', url: 'https://a.example', description: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(deepseek, { results: [{ title: 'T', url: 'https://a.example', snippet: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(searxng, { results: [{ title: 'T', url: 'https://a.example', content: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(youcom, { results: { web: [{ title: 'T', url: 'https://a.example', description: 'S' }] } })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
  expect(hit(youcom, { hits: [{ title: 'T', url: 'https://a.example', snippet: 'S' }] })).toEqual([
    { title: 'T', url: 'https://a.example', snippet: 'S' },
  ]);
});

test('an empty result set parses to an empty list, not an error', () => {
  expect(tavily.parse({ results: [] })).toEqual([]);
  expect(brave.parse({ type: 'search', web: { results: [] } })).toEqual([]);
  // Brave drops `web` when nothing matched.
  expect(brave.parse({ type: 'search', query: { original: 'cats' } })).toEqual([]);
  expect(exa.parse({ results: [] })).toEqual([]);
  expect(firecrawl.parse({ success: true, data: { web: [] } })).toEqual([]);
  expect(firecrawl.parse({ success: true, data: {} })).toEqual([]);
  expect(firecrawl.parse({ success: true, data: [] })).toEqual([]);
  expect(deepseek.parse({ results: [] })).toEqual([]);
  expect(searxng.parse({ results: [] })).toEqual([]);
  expect(youcom.parse({ results: { web: [] } })).toEqual([]);
  expect(youcom.parse({ hits: [] })).toEqual([]);
});

test('a payload without a result list is malformed, not an empty answer', () => {
  for (const provider of PROVIDERS) {
    expect(() => provider.parse({})).toThrow('No result list');
    expect(() => provider.parse({ results: 'unexpected' })).toThrow('No result list');
  }
  expect(() => firecrawl.parse({ success: false, data: {} })).toThrow('No result list');
});
