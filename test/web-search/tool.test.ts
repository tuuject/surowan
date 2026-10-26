import { expect, test } from 'vitest';
import { jsonResponse, searchConfig, secretStore, toolFixture } from './fixtures.ts';

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const part = result.content[0];
  if (part === undefined || part.type !== 'text' || part.text === undefined) {
    throw new Error('Expected one text part');
  }
  return part.text;
}

test('a search freezes the engine, resolves its key and formats normalized results', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, note: 'Chinese developer blogs' }]),
    () =>
      jsonResponse({
        results: [
          { title: 'Hello\nworld', url: 'https://example.com/a#frag', content: '  snippet   one  ' },
          { title: 'Second', url: 'https://example.com/b', content: 'x'.repeat(700) },
        ],
      }),
    { secrets: secretStore({ tavily: 'tvly-secret' }) },
  );
  const text = textOf(await fixture.tool.execute('call-1', { query: 'cats' }));
  expect(fixture.calls).toHaveLength(1);
  const call = fixture.calls[0];
  if (call === undefined) {
    throw new Error('Expected one request');
  }
  expect(call.url).toBe('https://api.tavily.com/search');
  expect(call.init.method).toBe('POST');
  expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer tvly-secret');
  expect(JSON.parse(String(call.init.body))).toMatchObject({ query: 'cats', max_results: 5 });

  expect(text).toContain('Untrusted web search results follow');
  expect(text).toContain('Engine: main (Tavily)');
  expect(text).toContain('Results: 2');
  // Newlines and control characters never forge an extra result line.
  expect(text).toContain('1. Hello world');
  expect(text).not.toContain('Hello\nworld');
  expect(text).toContain('URL: https://example.com/a');
  expect(text).not.toContain('#frag');
  expect(text).toContain('snippet one');
  expect(text).not.toContain('x'.repeat(601));

  const row = fixture.rows[0];
  expect(row?.state).toBe('success');
  expect(JSON.parse(row?.arguments ?? '{}')).toMatchObject({
    action: 'search',
    engine: 'main',
    provider: 'tavily',
  });
});

test('the tool description carries every engine note', () => {
  const fixture = toolFixture(
    searchConfig([
      { id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, note: 'Chinese developer blogs' },
      { id: 'docs', provider: 'exa', api_key: { jar: 'exa' }, note: 'Academic papers' },
    ]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'a', exa: 'b' }) },
  );
  expect(fixture.tool.description).toContain('main (Tavily): Chinese developer blogs');
  expect(fixture.tool.description).toContain('docs (Exa): Academic papers');
  // No provider limit or default count is baked into the description.
  expect(fixture.tool.description).not.toContain('400');
});

test('URL filters drop matching results and report the count', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }], {
      urlFilters: ['csdn'],
    }),
    () =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://blog.csdn.net/a', content: 'one' },
          { title: 'B', url: 'https://example.com/b', content: 'two' },
        ],
      }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  const text = textOf(await fixture.tool.execute('call-filter', { query: 'x' }));
  expect(text).toContain('Results: 1 (1 filtered by URL rules)');
  expect(text).not.toContain('blog.csdn.net');
  expect(text).toContain('https://example.com/b');
});

test('a backtracking-prone URL filter stays linear on a hostile URL', async () => {
  // `(a+)+$` takes exponential time on a backtracking engine; RE2 answers at once.
  const hostile = `https://evil.example/${'a'.repeat(64)}!`;
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }], {
      urlFilters: ['(a+)+$'],
    }),
    () =>
      jsonResponse({
        results: [
          { title: 'A', url: hostile, content: 'one' },
          { title: 'B', url: 'https://example.com/aaa', content: 'two' },
        ],
      }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  const started = performance.now();
  const text = textOf(await fixture.tool.execute('call-redos', { query: 'x' }));
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(text).toContain('Results: 1 (1 filtered by URL rules)');
  expect(text).toContain(hostile);
  expect(fixture.rows[0]?.state).toBe('success');
});

test('an empty result set is a successful answer', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  const result = await fixture.tool.execute('call-empty', { query: 'nothing' });
  expect(textOf(result)).toContain('No results.');
  expect(result.details.results).toBe(0);
  expect(fixture.rows[0]?.state).toBe('success');
});

test('a redirect is rejected instead of followed', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute('call-redirect', { query: 'x' })).rejects.toThrow('redirects are not followed');
  expect(fixture.rows[0]?.code).toBe('redirect_rejected');
});

test.each([
  [401, 'auth_failed'],
  [402, 'quota_exhausted'],
  [432, 'quota_exhausted'],
  [433, 'quota_exhausted'],
  [429, 'rate_limited'],
  [500, 'upstream_unavailable'],
  [418, 'request_rejected'],
])('HTTP %i is classified as %s without reading the body', async (status, code) => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => jsonResponse({ secret: 'do not echo' }, status),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute(`call-${status}`, { query: 'x' })).rejects.toThrow('web_search failed');
  expect(fixture.rows[0]?.code).toBe(code);
});

test('a keyless provider answering 403 explains the JSON output hint', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'local', provider: 'searxng', endpoint: 'https://searx.example.com' }]),
    () => jsonResponse({}, 403),
  );
  await expect(fixture.tool.execute('call-searxng', { query: 'x' })).rejects.toThrow('returns JSON output');
  expect(fixture.rows[0]?.code).toBe('endpoint_rejected');
});

test('a stalled request times out and reports the timeout code', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.init.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    { secrets: secretStore({ tavily: 'k' }), deadlineMs: 80 },
  );
  await expect(fixture.tool.execute('call-timeout', { query: 'x' })).rejects.toThrow('timed out');
  expect(fixture.rows[0]?.code).toBe('timeout');
});

test('an invocation that already ran out of time never sends a request', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'k' }), deadlineMs: -1_000 },
  );
  await expect(fixture.tool.execute('call-late', { query: 'x' })).rejects.toThrow('deadline');
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.rows[0]?.code).toBe('invocation_timeout');
});

test('an unresolvable key fails before any request', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'missing' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({}) },
  );
  await expect(fixture.tool.execute('call-secret', { query: 'x' })).rejects.toThrow('cannot resolve its api_key');
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.rows[0]?.code).toBe('secret_unresolved');
});

test('a long query is silently trimmed to the provider limit', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'ds', provider: 'deepseek', api_key: { jar: 'deepseek' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ deepseek: 'k' }) },
  );
  await fixture.tool.execute('call-trim', { query: '词'.repeat(200) });
  const body = JSON.parse(String(fixture.calls[0]?.init.body)) as { query: string };
  expect([...body.query]).toHaveLength(128);
});

test('requesting an engine disabled under a running invocation steers the model', async () => {
  const config = searchConfig([
    { id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } },
    { id: 'docs', provider: 'exa', api_key: { jar: 'exa' }, enabled: false },
  ]);
  const fixture = toolFixture(config, () => jsonResponse({ results: [] }), {
    secrets: secretStore({ tavily: 'a', exa: 'b' }),
  });
  await expect(fixture.tool.execute('call-disabled', { query: 'x', engine: 'docs' })).rejects.toThrow(
    'Engine "docs" is disabled',
  );
  expect(fixture.steers).toHaveLength(1);
  expect(fixture.steers[0]).toContain('"docs" is no longer enabled');
  expect(fixture.rows[0]?.code).toBe('engine_disabled');
  expect(fixture.calls).toHaveLength(0);
});

test('an unknown engine fails without steering', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute('call-unknown', { query: 'x', engine: 'nope' })).rejects.toThrow(
    'No configured engine is named',
  );
  expect(fixture.steers).toHaveLength(0);
  expect(fixture.rows[0]?.code).toBe('unknown_engine');
});

test('turning search off mid-invocation fails the call even with a stale tool', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  fixture.setConfig(searchConfig([], { enabled: false }));
  await expect(fixture.tool.execute('call-off', { query: 'x' })).rejects.toThrow('Web search is unavailable');
  expect(fixture.rows[0]?.code).toBe('search_disabled');
  expect(fixture.calls).toHaveLength(0);
});

test('disabling every engine has the same effect as the switch', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, enabled: false }]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute('call-all-off', { query: 'x' })).rejects.toThrow('Web search is unavailable');
  expect(fixture.rows[0]?.code).toBe('search_disabled');
});

test('a request keeps the settings it started with while the live config changes', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'old' }, results: 5 }]),
    () => {
      // The hot edit lands while the first request is in flight.
      fixture.setConfig(
        searchConfig([
          { id: 'main', provider: 'tavily', api_key: { jar: 'new' }, endpoint: 'https://second.example/search' },
        ]),
      );
      return jsonResponse({ results: [{ title: 'A', url: 'https://example.com/a', content: 'one' }] });
    },
    { secrets: secretStore({ old: 'old-key', new: 'new-key' }) },
  );
  await fixture.tool.execute('call-first', { query: 'x' });
  await fixture.tool.execute('call-second', { query: 'x' });
  expect(fixture.calls[0]?.url).toBe('https://api.tavily.com/search');
  expect(new Headers(fixture.calls[0]?.init.headers).get('authorization')).toBe('Bearer old-key');
  expect(fixture.calls[1]?.url).toBe('https://second.example/search');
  expect(new Headers(fixture.calls[1]?.init.headers).get('authorization')).toBe('Bearer new-key');
});

test('action "list" reports the live engines, their notes and the disabled ones', async () => {
  const fixture = toolFixture(
    searchConfig([
      { id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, note: 'Chinese developer blogs' },
      { id: 'docs', provider: 'exa', api_key: { jar: 'exa' }, enabled: false },
    ]),
    () => jsonResponse({ results: [] }),
    { secrets: secretStore({ tavily: 'a', exa: 'b' }) },
  );
  const text = textOf(await fixture.tool.execute('call-list', { action: 'list' }));
  expect(text).toContain('- main (Tavily, provider tavily): Chinese developer blogs');
  expect(text).toContain('Disabled engines: docs');
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.rows[0]?.state).toBe('success');
});

test('the result envelope never exceeds 24 KiB', async () => {
  const results = Array.from({ length: 10 }, (_, index) => ({
    title: `Result ${index + 1} ${'t'.repeat(280)}`,
    url: `https://example.com/${'p'.repeat(2_000)}-${index + 1}`,
    content: 'y'.repeat(600),
  }));
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' }, results: 10 }]),
    () => jsonResponse({ results }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  const result = await fixture.tool.execute('call-big', { query: 'x' });
  const text = textOf(result);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24 * 1024);
  expect(text).toContain('[results truncated]');
  expect(result.details.truncated).toBe(true);
});

test('an oversized response is refused instead of buffered', async () => {
  const body = new Uint8Array(300 * 1024).fill(0x61);
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute('call-oversize', { query: 'x' })).rejects.toThrow('exceeds');
  expect(fixture.rows[0]?.code).toBe('response_too_large');
});

test('a non-JSON answer is an invalid response', async () => {
  const fixture = toolFixture(
    searchConfig([{ id: 'main', provider: 'tavily', api_key: { jar: 'tavily' } }]),
    () => new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }),
    { secrets: secretStore({ tavily: 'k' }) },
  );
  await expect(fixture.tool.execute('call-html', { query: 'x' })).rejects.toThrow('did not return valid JSON');
  expect(fixture.rows[0]?.code).toBe('invalid_response');
});
