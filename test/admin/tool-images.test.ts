import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createApiKey } from '../../src/ingress/admin/api-keys.ts';
import { toolImageReferences } from '../../src/platform/tool-images.ts';
import { toolCalls } from '../../src/store/schema/index.ts';
import { appendImageResult, imageFixture } from '../mcp/image-fixtures.ts';
import { request, post, sessionCookie } from './fixtures.ts';

test('Admin serves real tool images only for the authenticated owning result and links Transcript/Context', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('call_images', {});
  appendImageResult(f, result);
  const setup = await f.server.handle(
    post('/api/auth/setup', { username: 'owner', password: 'correct-horse-battery' }),
  );
  const cookie = sessionCookie(setup);
  const assetId = toolImageReferences(result.details)[0]!.assetId;
  const route = `/api/invocations/${f.seed.invocationA}/tools/call_images/images/${assetId}`;
  expect((await f.server.handle(request(route))).status).toBe(401);
  const key = createApiKey(f.store.orm, 'tool-image-test');
  expect((await f.server.handle(request(route, { headers: { authorization: `Bearer ${key.key}` } }))).status).toBe(200);
  const call = (path: string) => f.server.handle(request(path, { headers: { cookie } }));
  const response = await call(route);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect((await call(route.replace('call_images', 'call_read_001'))).status).toBe(404);
  expect((await call(route.replace(String(f.seed.invocationA), String(f.seed.invocationB)))).status).toBe(404);
  expect((await call(route.replace(assetId, 'f'.repeat(32)))).status).toBe(404);
  expect((await call(`${route}?path=/etc/passwd`)).status).toBe(400);
  const detail = (await (await call(`/api/invocations/${f.seed.invocationA}`)).json()) as {
    tool_calls: { tool_call_id: string; result_content: { type: string }[] }[];
  };
  expect(
    detail.tool_calls
      .find((tool) => tool.tool_call_id === 'call_images')!
      .result_content.map((part: { type: string }) => part.type),
  ).toEqual(['text', 'image', 'text', 'image', 'text']);
  const context = (await (await call(`/api/contexts/${f.seed.conversationId}`)).json()) as {
    messages: { result_content: { url: string }[] }[];
  };
  expect(context.messages[0]!.result_content[1]!.url).toContain(`/contexts/${f.seed.conversationId}/messages/`);
  const specialId = 'call_special|item/name';
  const special = await f.tool.execute(specialId, {});
  appendImageResult(f, special, specialId);
  expect(
    (await call(`/api/invocations/${f.seed.invocationA}/tools/${encodeURIComponent(specialId)}/images/${assetId}`))
      .status,
  ).toBe(200);
  const historyUrl = context.messages[0]!.result_content[1]!.url;
  f.store.orm.delete(toolCalls).where(eq(toolCalls.toolCallId, 'call_images')).run();
  expect((await call(historyUrl)).status).toBe(200);
  const asset = f.assets.assetFor(f.seed.chatId, assetId)!;
  await rm(asset.path);
  expect((await call(historyUrl)).status).toBe(404);
});

test('MCP reads tool and context images by their string ids', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('call_images', {});
  appendImageResult(f, result);
  const assetId = toolImageReferences(result.details)[0]!.assetId;
  const key = createApiKey(f.store.orm, 'mcp-tool-image', 'read');
  const call = async (name: string, args: Record<string, unknown>): Promise<any> =>
    await (
      await f.server.handle(
        request('/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key.key}`,
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        }),
      )
    ).json();
  const png = [137, 80, 78, 71, 13, 10, 26, 10];

  const tool = await call('surowan_invocation_tool_image', {
    id: String(f.seed.invocationA),
    tool_call_id: 'call_images',
    asset_id: assetId,
  });
  expect(tool.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect([...Buffer.from(tool.result.content[0].data, 'base64').subarray(0, 8)]).toEqual(png);

  const context = (await (
    await f.server.handle(
      request(`/api/contexts/${f.seed.conversationId}`, { headers: { authorization: `Bearer ${key.key}` } }),
    )
  ).json()) as { messages: { result_content: { url: string }[] }[] };
  const seq = /\/messages\/(\d+)\/images\//.exec(context.messages[0]!.result_content[1]!.url)![1]!;
  const image = await call('surowan_context_message_image', {
    conversation_id: String(f.seed.conversationId),
    seq,
    asset_id: assetId,
  });
  expect(image.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
});
