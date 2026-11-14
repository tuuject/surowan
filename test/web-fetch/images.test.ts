import sharp from 'sharp';
import { afterAll, expect, test } from 'vitest';
import { localImageAssets } from '../../src/capabilities/media/local-assets.ts';
import { ingestToolImage } from '../../src/capabilities/media/tool-image-store.ts';
import { toolImageMarker } from '../../src/platform/tool-images.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { definePlugin, loadPlugins } from '../../src/plugins/plugin.ts';
import { createWebFetchTool } from '../../src/plugins/web-fetch/web-fetch.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { cleanupWebFetchDirectories, type Fixture, fixture, htmlResponse } from './fixtures.ts';

afterAll(cleanupWebFetchDirectories);

async function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 10 } } })
    .png()
    .toBuffer();
}

function imageStoreFor(fixed: Fixture) {
  const assets = localImageAssets(fixed.store.orm, fixed.config.data_dir);
  return (bytes: Uint8Array, signal: AbortSignal) =>
    ingestToolImage(assets, fixed.context.internalChatId, bytes, signal);
}

test('web_fetch keeps page images as absolute links, hints at viewing them and drops inline data images', async () => {
  const fixed = await fixture();
  const { store, context } = fixed;
  try {
    const page = [
      '<html><head><title>Gallery</title></head><body><article><h1>Gallery</h1>',
      '<p>The gallery page has enough prose to count as main content for the extraction heuristics, so it stays.</p>',
      '<p><img src="/images/cat.jpg" alt="A cat"></p>',
      `<p><img src="data:image/png;base64,${'A'.repeat(40_000)}" alt="inline"></p>`,
      '<p>More prose that keeps the article long enough to be considered the main content of this page.</p>',
      '</article></body></html>',
    ].join('');
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      storeImage: imageStoreFor(fixed),
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async () => htmlResponse(page),
    });
    expect(tool.label).toBe('Fetch a web page or image');
    expect(tool.description).toContain('comes back as an attached image');
    const result = await tool.execute('web-gallery', { url: 'https://public.example/gallery/' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Images: linked as ![alt](url)');
    expect(text).toContain('![A cat](https://public.example/images/cat.jpg)');
    expect(text).toContain('![inline](inline data image omitted)');
    expect(text).not.toContain('AAAA');
    expect(result.details).toEqual({
      url: 'https://public.example/gallery/',
      status: 200,
      format: 'markdown',
      truncated: false,
    });
  } finally {
    store.close();
  }
});

test('web_fetch returns an image as a stored tool image and sends the referer on every hop', async () => {
  const fixed = await fixture();
  const { store, context } = fixed;
  try {
    const png = await pngBytes(64, 48);
    const requests: { url: string; referer: string | undefined }[] = [];
    const tool = createWebFetchTool({
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      storeImage: imageStoreFor(fixed),
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
      requestResolved: async (url, _address, headers) => {
        requests.push({ url: url.href, referer: headers.referer });
        if (url.hostname === 'img.example') {
          return new Response(null, { status: 302, headers: { location: 'https://cdn.example/cat.png' } });
        }
        return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
      },
    });
    const result = await tool.execute('web-image', {
      url: 'https://img.example/cat.png',
      referer: 'https://blog.example/post#comments',
    });
    // The fragment never leaves, and the redirect keeps the caller's referer.
    expect(requests).toEqual([
      { url: 'https://img.example/cat.png', referer: 'https://blog.example/post' },
      { url: 'https://cdn.example/cat.png', referer: 'https://blog.example/post' },
    ]);
    const image = result.details.toolImages?.items[0];
    if (image === undefined) {
      throw new Error('Expected a tool image');
    }
    expect(result.details).toEqual({
      url: 'https://cdn.example/cat.png',
      status: 200,
      format: 'image',
      truncated: false,
      toolImages: { version: 1, items: [{ ...image, contentIndex: 1 }] },
    });
    expect(image).toMatchObject({ mimeType: 'image/jpeg', width: 64, height: 48 });
    expect(result.content).toHaveLength(2);
    const header = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(header.startsWith('Untrusted web content follows.')).toBe(true);
    expect(header).toContain('Format: image attached below, normalized to 64x48 image/jpeg');
    expect(result.content[1]).toEqual({ type: 'text', text: toolImageMarker(image.assetId) });
    // The picture is an asset of this Chat; the audit keeps a reference, not bytes.
    const assets = localImageAssets(store.orm, fixed.config.data_dir);
    expect(assets.assetFor(context.internalChatId, image.assetId)).toMatchObject({ byteSize: image.byteSize });
    expect(assets.assetFor(context.internalChatId + 1n, image.assetId)).toBeNull();
    const row = store.db
      .prepare<[], { state: string; result_text: string; result_content_json: string }>(
        "SELECT state, result_text, result_content_json FROM tool_calls WHERE tool_call_id = 'web-image'",
      )
      .get();
    expect(row?.state).toBe('success');
    expect(row?.result_text).toBe(header);
    expect(JSON.parse(row?.result_content_json ?? '{}')).toEqual({
      content: result.content,
      details: result.details,
    });
    expect(row?.result_content_json).not.toContain(png.toString('base64').slice(0, 24));
  } finally {
    store.close();
  }
});

test('web_fetch refuses images it cannot view and invalid referers, and audits each refusal', async () => {
  const fixed = await fixture();
  const { store, context } = fixed;
  try {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const responses: Record<string, () => Response> = {
      '/plain.png': () => new Response(gif, { headers: { 'content-type': 'image/png' } }),
      '/anim.gif': () => new Response(gif, { headers: { 'content-type': 'image/gif' } }),
      '/fake.jpg': () => new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } }),
      '/huge.png': () =>
        new Response(new ReadableStream({ pull: () => Promise.reject(new Error('body must not be read')) }), {
          headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) },
        }),
      '/stream.png': () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    };
    let requests = 0;
    const options = {
      audit: createToolAudit(store, context.invocationId),
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '203.0.114.10', family: 4 as const }],
      requestResolved: async (url: URL) => {
        requests += 1;
        const response = responses[url.pathname];
        if (response === undefined) {
          throw new Error(`unexpected ${url.pathname}`);
        }
        return response();
      },
    };
    // Without an image store a picture is binary content like any other.
    const textOnly = createWebFetchTool(options);
    expect(textOnly.label).toBe('Fetch a web page');
    expect(textOnly.description).not.toContain('attached image');
    await expect(textOnly.execute('web-no-store', { url: 'https://img.example/plain.png' })).rejects.toThrow(
      'Unsupported content type: image/png',
    );
    const tool = createWebFetchTool({ ...options, storeImage: imageStoreFor(fixed) });
    await expect(tool.execute('web-gif', { url: 'https://img.example/anim.gif' })).rejects.toThrow(
      'not a JPEG, PNG or WebP image',
    );
    await expect(tool.execute('web-fake', { url: 'https://img.example/fake.jpg' })).rejects.toThrow(
      'not a JPEG, PNG or WebP image',
    );
    await expect(tool.execute('web-huge', { url: 'https://img.example/huge.png' })).rejects.toThrow('Image exceeds');
    await expect(tool.execute('web-stream', { url: 'https://img.example/stream.png' })).rejects.toThrow(
      'Image exceeds',
    );
    expect(requests).toBe(5);
    for (const [index, referer] of ['ftp://blog.example/', 'https://user:pass@blog.example/', 'not a url'].entries()) {
      await expect(
        tool.execute(`web-referer-${index}`, { url: 'https://img.example/plain.png', referer }),
      ).rejects.toThrow('referer must');
    }
    expect(requests).toBe(5);
    expect(
      store.db
        .prepare<[], { tool_call_id: string; state: string; error_code: string }>(
          'SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
    ).toEqual([
      { tool_call_id: 'web-no-store', state: 'error', error_code: 'unsupported_content_type' },
      { tool_call_id: 'web-gif', state: 'error', error_code: 'image_unsupported_type' },
      { tool_call_id: 'web-fake', state: 'error', error_code: 'image_unsupported_type' },
      { tool_call_id: 'web-huge', state: 'error', error_code: 'image_too_large' },
      { tool_call_id: 'web-stream', state: 'error', error_code: 'image_too_large' },
      { tool_call_id: 'web-referer-0', state: 'error', error_code: 'invalid_referer' },
      { tool_call_id: 'web-referer-1', state: 'error', error_code: 'invalid_referer' },
      { tool_call_id: 'web-referer-2', state: 'error', error_code: 'invalid_referer' },
    ]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM playground_assets').get()).toEqual({ count: 0n });
  } finally {
    store.close();
  }
});

test('the plugin scope stores tool images only under the invocation Chat and web_fetch follows the store', async () => {
  const { store, config, context } = await fixture();
  try {
    const chats: bigint[] = [];
    const reference = {
      contentIndex: 0,
      assetId: 'a'.repeat(32),
      mimeType: 'image/png' as const,
      byteSize: 1,
      width: 1,
      height: 1,
    };
    let scoped: ((bytes: Uint8Array, signal: AbortSignal) => Promise<unknown>) | undefined;
    const probe = definePlugin({
      id: 'scope-probe',
      capabilities: (scope) => {
        scoped = scope.storeToolImage;
        return [];
      },
    });
    const plugins = loadPlugins([...BUILTIN_PLUGINS, probe]);
    const withStore = plugins.capabilities(store, config, context, Date.now() + 30_000, undefined, undefined, {
      storeToolImage: async (chatId) => {
        chats.push(chatId);
        return reference;
      },
    });
    expect(withStore.find((entry) => entry.tool.name === 'web_fetch')?.tool.description).toContain(
      'comes back as an attached image',
    );
    await scoped?.(new Uint8Array([1]), new AbortController().signal);
    expect(chats).toEqual([context.internalChatId]);
    scoped = undefined;
    const withoutStore = plugins.capabilities(store, config, context, Date.now() + 30_000);
    expect(withoutStore.find((entry) => entry.tool.name === 'web_fetch')?.tool.description).not.toContain(
      'attached image',
    );
    expect(scoped).toBeUndefined();
  } finally {
    store.close();
  }
});
