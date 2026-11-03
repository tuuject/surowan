import { fauxProvider } from '@earendil-works/pi-ai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { expect, test } from 'vitest';
import { McpManager } from '../../src/capabilities/mcp/index.ts';
import { convertMcpResult } from '../../src/capabilities/mcp/content.ts';
import { MAX_DOWNLOAD_BYTES } from '../../src/capabilities/media/image.ts';
import { loadToolImages } from '../../src/capabilities/media/tool-images.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { toolImageReferences } from '../../src/platform/tool-images.ts';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';
import { appendImageResult, imageFixture } from './image-fixtures.ts';

test('stdio response overflow reports payload_limit instead of retrying the tool', async () => {
  const f = await imageFixture(4096);
  await expect(f.tool.execute('too_large', { oversized: true })).rejects.toThrow('payload_limit');
});

test('format, MIME and decoded-size failures are explicit without serializing binary', async () => {
  const f = await imageFixture();
  for (const image of [
    { type: 'image' as const, mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
    { type: 'image' as const, mimeType: 'image/png', data: 'not base64' },
    { type: 'image' as const, mimeType: 'image/png', data: 'A'.repeat(Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4 + 4) },
  ]) {
    const converted = await convertMcpResult(
      { content: [image] },
      { serverAlias: 'local', originalName: 'image', resultMaxBytes: 128 },
      f.context,
      f.assets,
      new AbortController().signal,
    );
    expect(JSON.stringify(converted)).toContain('MCP image unavailable');
    expect(JSON.stringify(converted).length).toBeLessThan(512);
  }
  const result = await f.tool.execute('model_limit', {});
  const message = appendImageResult(f, result, 'model_limit');
  const model = fauxProvider({
    models: [{ id: 'limited', input: ['text', 'image'], inputLimits: { images: { maxPerRequest: 1 } } }],
  }).getModel();
  const loaded = await loadToolImages([message], {
    orm: f.store.orm,
    dataDir: f.loaded.config.data_dir,
    conversationId: f.seed.conversationId,
    chatId: f.seed.chatId,
    model,
    signal: new AbortController().signal,
  });
  const projected = loaded[0];
  if (projected?.role !== 'toolResult') {
    throw new Error('Missing projected result');
  }
  expect(projected.content.filter((block) => block.type === 'image')).toHaveLength(1);
  expect(JSON.stringify(loaded)).toContain('image_request_budget_exceeded');
  const second = appendImageResult(f, await f.tool.execute('second_limit', {}), 'second_limit');
  const completions = fauxProvider({
    api: 'openai-completions',
    models: [{ id: 'per-message', input: ['text', 'image'], inputLimits: { images: { maxPerMessage: 1 } } }],
  }).getModel();
  const grouped = await loadToolImages([message, second], {
    orm: f.store.orm,
    dataDir: f.loaded.config.data_dir,
    conversationId: f.seed.conversationId,
    chatId: f.seed.chatId,
    model: completions,
    signal: new AbortController().signal,
  });
  expect(
    grouped.flatMap((entry) =>
      entry.role === 'toolResult' ? entry.content.filter((block) => block.type === 'image') : [],
    ),
  ).toHaveLength(1);
});

test('Streamable HTTP accepts native mixed images and bounds oversized image responses', async () => {
  const f = await imageFixture();
  const source = await f.tool.execute('source', {});
  const reference = toolImageReferences(source.details)[0]!;
  const bytes = await f.assets.read(reference.assetId);
  if (bytes === null) {
    throw new Error('Missing test bytes');
  }
  const server = new McpServer({ name: 'image-http-fixture', version: '1.0.0' });
  server.registerTool('capture', { description: 'Native image', inputSchema: {} }, async () => ({
    isError: true,
    content: [
      { type: 'text' as const, text: 'before' },
      { type: 'image' as const, data: Buffer.from(bytes).toString('base64'), mimeType: reference.mimeType },
      { type: 'text' as const, text: 'after' },
    ],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  let oversized = false;
  const http = await startFixtureServer(async (request) => {
    if (oversized && request.method === 'POST') {
      return new Response('X'.repeat(8192), { headers: { 'content-type': 'application/json' } });
    }
    return transport.handleRequest(request);
  });
  const manager = new McpManager(
    f.store,
    {
      ...f.loaded.config,
      mcp: {
        servers: [
          {
            alias: 'http',
            transport: 'streamable_http',
            url: `http://127.0.0.1:${http.port}/mcp`,
            follow_redirects: false,
            required: true,
            tools: ['capture'],
            payload_max_bytes: 4096,
            result_max_bytes: 1024,
            default_tool_policy: { read_only: true, timeout_seconds: 5 },
          },
        ],
      },
    },
    new SecretStore(),
  );
  try {
    await manager.start();
    const tool = manager.createTools(f.context, Date.now() + 10_000)[0]!;
    const result = await tool.execute('http_image', {});
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => (block.type === 'text' ? block.text : ''))).toEqual([
      'before',
      expect.stringContaining('[MCP image '),
      'after',
      expect.stringContaining('isError=true'),
    ]);
    oversized = true;
    await expect(tool.execute('http_overflow', {})).rejects.toThrow('payload_limit');
  } finally {
    oversized = false;
    await manager.stop();
    await server.close();
    await stopFixtureServer(http.server);
  }
});
