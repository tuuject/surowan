import { afterAll, expect, test, vi } from 'vitest';
import { createWebFetchTool } from '../../src/plugins/web-fetch/web-fetch.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { cleanupWebFetchDirectories, fixture, htmlResponse } from './fixtures.ts';

afterAll(cleanupWebFetchDirectories);

function articlePage(): string {
  // The article sits past the first 32 KiB, where a result-sized read would cut it off.
  const navigation = Array.from({ length: 400 }, (_, index) => `<li><a href="/nav/${index}">Section ${index}</a></li>`);
  return [
    '<!doctype html><html><head><title>Plastic bowls explained</title>',
    `<script>${'var tracking = 1;'.repeat(2_000)}</script></head><body>`,
    `<nav><ul>${navigation.join('')}</ul></nav>`,
    '<article><h1>Plastic bowls explained</h1>',
    '<p>A plastic bowl is light, cheap and hard to break. This paragraph carries the article body that must survive extraction.</p>',
    '<p>See the <a href="/care">care guide</a> for washing instructions.</p>',
    '<img src="/photo.jpg" alt="bowl photo"></article>',
    '<footer>Copyright footer</footer></body></html>',
  ].join('');
}

test('web_fetch converts HTML main content to Markdown by default and audits it', async () => {
  const { store, context } = await fixture();
  try {
    const html = articlePage();
    expect(Buffer.byteLength(html)).toBeGreaterThan(32_768);
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => htmlResponse(html),
    });
    const result = await tool.execute('web-md', { url: 'https://public.example/bowls' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text.startsWith('Untrusted web content follows.')).toBe(true);
    expect(text).toContain('Format: main content converted to Markdown');
    expect(text).toContain('Title: Plastic bowls explained');
    expect(text).toContain('A plastic bowl is light, cheap and hard to break.');
    expect(text).toContain('[care guide](https://public.example/care)');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('Section 399');
    expect(text).not.toContain('var tracking');
    // Images stay as absolute links; without an image store there is no viewing hint.
    expect(text).toContain('![bowl photo](https://public.example/photo.jpg)');
    expect(text).not.toContain('Images: linked as');
    expect(result.details).toEqual({
      url: 'https://public.example/bowls',
      status: 200,
      format: 'markdown',
      truncated: false,
    });
    expect(
      store.db
        .prepare<[], { state: string; result_text: string }>(
          "SELECT state, result_text FROM tool_calls WHERE tool_call_id = 'web-md'",
        )
        .get(),
    ).toEqual({ state: 'success', result_text: text });
  } finally {
    store.close();
  }
});

test('web_fetch truncates converted Markdown to the result budget on a UTF-8 boundary', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () =>
        htmlResponse(
          `<html><head><title>长文</title></head><body><article><p>${'碗'.repeat(20_000)}</p></article></body></html>`,
        ),
    });
    const result = await tool.execute('web-long', { url: 'https://public.example/long' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    expect(text.endsWith('碗\n[content truncated]')).toBe(true);
    expect(result.details).toMatchObject({ format: 'markdown', truncated: true });
  } finally {
    store.close();
  }
});

test('web_fetch HTML conversion makes no network requests of its own', async () => {
  const { store, context } = await fixture();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return htmlResponse('<html><head><title>video</title></head><body></body></html>');
      },
    });
    // Both URLs match Defuddle extractors that call YouTube/X APIs when async extraction is on.
    await tool.execute('web-youtube', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    await tool.execute('web-x', { url: 'https://x.com/someone/status/123' });
    expect(requests).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    store.close();
  }
});

test('web_fetch asks for Markdown and passes site-served Markdown through unchanged', async () => {
  const { store, context } = await fixture();
  try {
    const accepts: string[] = [];
    const markdown = '# Workers\n\n<p>Served as Markdown, not converted.</p>\n';
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async (_url, _address, { accept }) => {
        accepts.push(accept);
        return accept.startsWith('text/markdown')
          ? new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
          : htmlResponse('<html><body><p>html body</p></body></html>');
      },
    });
    const served = await tool.execute('web-served-md', { url: 'https://docs.example/workers' });
    const text = served.content[0]?.type === 'text' ? served.content[0].text : '';
    expect(text).toContain('Content-Type: text/markdown; charset=utf-8');
    expect(text).toContain('Format: Markdown served by the site');
    expect(text.endsWith(markdown)).toBe(true);
    expect(served.details).toMatchObject({ format: 'markdown', truncated: false });

    const raw = await tool.execute('web-served-raw', { url: 'https://docs.example/workers', raw: true });
    const rawText = raw.content[0]?.type === 'text' ? raw.content[0].text : '';
    expect(rawText).toContain('<p>html body</p>');
    expect(raw.details).toMatchObject({ format: 'raw' });

    expect(accepts[0]?.startsWith('text/markdown, text/html;q=0.9')).toBe(true);
    expect(accepts[1]).not.toContain('text/markdown');
  } finally {
    store.close();
  }
});

test('web_fetch.accept_markdown false loads and stops advertising Markdown', async () => {
  const { store, config, context } = await fixture((file) => {
    file.web_fetch = { accept_markdown: false };
  });
  try {
    expect(config.web_fetch).toEqual({ accept_markdown: false });
    const accepts: string[] = [];
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      acceptMarkdown: false,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async (_url, _address, { accept }) => {
        accepts.push(accept);
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    await tool.execute('web-no-md', { url: 'https://docs.example/' });
    expect(accepts).toEqual(['text/html, application/xhtml+xml, application/json, text/plain;q=0.9, */*;q=0.1']);
  } finally {
    store.close();
  }
});
