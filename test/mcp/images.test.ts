import { readFile, rm } from 'node:fs/promises';
import { fauxProvider } from '@earendil-works/pi-ai';
import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { convertMcpResult } from '../../src/capabilities/mcp/content.ts';
import { loadToolImages } from '../../src/capabilities/media/tool-images.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { toolImageReferences } from '../../src/platform/tool-images.ts';
import { contextMessages, toolCalls } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import { appendImageResult, type ImageFixture, imageFixture } from './image-fixtures.ts';

function load(f: ImageFixture, messages: Parameters<typeof loadToolImages>[0], vision = true) {
  return loadToolImages(messages, {
    orm: f.store.orm,
    dataDir: f.loaded.config.data_dir,
    conversationId: f.seed.conversationId,
    chatId: f.seed.chatId,
    model: fauxProvider({ models: [{ id: 'image-test', input: vision ? ['text', 'image'] : ['text'] }] }).getModel(),
    signal: new AbortController().signal,
  });
}

test.each([false, true])(
  'native MCP images preserve mixed order and isError=%s without storing base64',
  async (isError) => {
    const f = await imageFixture();
    const result = await f.tool.execute(`call_${isError}`, { error: isError });
    expect(result.isError).toBe(isError);
    expect(result.content.filter((block) => block.type === 'text').map((block) => block.text)).toEqual([
      'before',
      expect.stringContaining('[image '),
      'between',
      expect.stringContaining('[image '),
      'after',
      ...(isError ? [expect.stringContaining('isError=true')] : []),
    ]);
    const message = appendImageResult(f, result, `call_${isError}`);
    const [loaded] = await load(f, [message]);
    expect(loaded?.role).toBe('toolResult');
    if (loaded?.role !== 'toolResult') {
      throw new Error('Missing result');
    }
    expect(loaded.isError).toBe(isError);
    expect(loaded.toolCallId).toBe(`call_${isError}`);
    expect(loaded.content.map((block) => block.type)).toEqual([
      'text',
      'text',
      'image',
      'text',
      'text',
      'image',
      'text',
      ...(isError ? ['text'] : []),
    ]);
    expect(loaded.content[0]).toEqual({ type: 'text', text: 'before' });
    expect(loaded.content[3]).toEqual({ type: 'text', text: 'between' });
    expect(loaded.content[6]).toEqual({ type: 'text', text: 'after' });
    const row = f.store.orm
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolCallId, `call_${isError}`))
      .get();
    expect(row?.state).toBe(isError ? 'error' : 'success');
    for (const block of loaded.content) {
      if (block.type === 'image') {
        expect(block.mimeType).toBe('image/png');
        expect(row?.resultContentJson).not.toContain(block.data);
        expect(row?.resultText).not.toContain(block.data);
      }
    }
    const restored = new ConversationContextStore(f.store).retained(f.context.header).map((row) => row.message);
    const reloaded = await load(f, restored);
    expect(reloaded).toEqual([loaded]);
  },
);

test('pure-image results persist and missing images/text-only models give explicit feedback', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('call_images', { only: true });
  const message = appendImageResult(f, result);
  const noVision = await load(f, [message], false);
  expect(JSON.stringify(noVision)).toContain('does not support image input');
  expect(JSON.stringify(noVision)).not.toContain('"type":"image"');
  const references = toolImageReferences(result.details);
  const asset = f.assets.assetFor(f.seed.chatId, references[0]!.assetId)!;
  await rm(asset.path);
  const missing = await load(f, [message]);
  expect(JSON.stringify(missing)).toContain('image_missing');
  expect(f.store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call_images')).get()?.state).toBe(
    'success',
  );
});

test('image failures retain surrounding text and never degrade or resend MCP', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('bad_images', { invalid: true });
  expect(result.content).toContainEqual({ type: 'text', text: 'before' });
  expect(result.content).toContainEqual({ type: 'text', text: 'after' });
  expect(JSON.stringify(result)).toContain('MCP image unavailable');
  expect(JSON.stringify(result)).not.toContain('aW52YWxpZA==');
  expect(f.store.orm.all<{ state: string }>(sql`SELECT state FROM mcp_server_state`)).toEqual([{ state: 'ready' }]);
  expect(f.store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'bad_images')).all()).toHaveLength(1);
});

test('asset sweep honors audit/canonical references, cut revokes pixels, audit expiry preserves history', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('call_images', {});
  const message = appendImageResult(f, result);
  const refs = toolImageReferences(result.details);
  const path = f.assets.assetFor(f.seed.chatId, refs[0]!.assetId)!.path;
  await f.assets.sweep({ staleAfterMs: -1 });
  expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  purgeExpiredData(f.store.orm, f.loaded.config, new Date(Date.now() + 366 * 86_400_000));
  expect(f.store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call_images')).get()).toBeUndefined();
  await f.assets.sweep({ staleAfterMs: -1 });
  expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  expect(JSON.stringify(await load(f, [message]))).toContain('"type":"image"');
  f.contexts.clear(f.context.header);
  expect(JSON.stringify(await load(f, [message]))).toContain('image_not_authorized');
  // Soft-evicted history still owns its UI images until the records are deleted.
  await f.assets.sweep({ staleAfterMs: -1 });
  expect((await readFile(path)).byteLength).toBeGreaterThan(0);
  f.store.orm.delete(contextMessages).where(eq(contextMessages.contextId, f.context.header.id)).run();
  await f.assets.sweep({ staleAfterMs: -1 });
  await expect(readFile(path)).rejects.toThrow();
});

test('forged references cannot load another conversation or an unlisted asset', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('call_images', {});
  const message = appendImageResult(f, result);
  const projected = await loadToolImages([message], {
    orm: f.store.orm,
    dataDir: f.loaded.config.data_dir,
    conversationId: 999999n,
    chatId: f.seed.chatId,
    model: fauxProvider({ models: [{ id: 'image-test', input: ['text', 'image'] }] }).getModel(),
    signal: new AbortController().signal,
  });
  expect(JSON.stringify(projected)).toContain('image_not_authorized');
  expect(JSON.stringify(projected)).not.toContain('"type":"image"');
});

test('one retained-history query authorizes multiple calls and preserves call, asset, chat and cut bounds', async () => {
  const f = await imageFixture();
  const first = appendImageResult(f, await f.tool.execute('batch_first', {}), 'batch_first');
  const second = appendImageResult(f, await f.tool.execute('batch_second', {}), 'batch_second');
  const query = vi.spyOn(f.store.orm, 'all');
  try {
    const hydrated = await load(f, [first, second]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(
      hydrated.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : [],
      ),
    ).toHaveLength(4);
    const forgedCall = await load(f, [{ ...first, toolCallId: 'unretained' }]);
    expect(JSON.stringify(forgedCall)).toContain('image_not_authorized');
    const refs = toolImageReferences(first.details);
    const forgedAsset = {
      ...first,
      details: {
        toolImages: { version: 1, items: refs.map((ref) => ({ ...ref, contentIndex: ref.contentIndex + 1 })) },
      },
    };
    expect(JSON.stringify(await load(f, [forgedAsset]))).not.toContain('"type":"image"');
    const wrongChat = await loadToolImages([first], {
      orm: f.store.orm,
      dataDir: f.loaded.config.data_dir,
      conversationId: f.seed.conversationId,
      chatId: 999999n,
      model: fauxProvider({ models: [{ id: 'vision', input: ['text', 'image'] }] }).getModel(),
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(wrongChat)).not.toContain('"type":"image"');
    f.store.orm.run(
      sql`UPDATE context_messages SET evicted_at = '2000-01-01' WHERE context_id = ${f.context.header.id}`,
    );
    expect(JSON.stringify(await load(f, [first, second]))).not.toContain('"type":"image"');
    f.store.orm.run(sql`UPDATE context_messages SET evicted_at = NULL WHERE context_id = ${f.context.header.id}`);
    f.store.orm.run(sql`UPDATE conversation_contexts SET head_seq = next_seq WHERE id = ${f.context.header.id}`);
    expect(JSON.stringify(await load(f, [first, second]))).not.toContain('"type":"image"');
  } finally {
    query.mockRestore();
  }
});

test('legacy text-only MCP envelope and unsupported binary content remain bounded', async () => {
  const f = await imageFixture();
  const echo = f.manager.createTools(f.context, Date.now() + 30_000).find((tool) => tool.name === 'local__echo')!;
  const result = await echo.execute('echo_old', { text: 'legacy' });
  expect(result.content).toEqual([{ type: 'text', text: '{"content":[{"type":"text","text":"1:legacy"}]}' }]);
  const definition = { serverAlias: 'local', originalName: 'images', resultMaxBytes: 128 };
  const converted = await convertMcpResult(
    {
      content: [
        { type: 'audio', data: 'c2VjcmV0', mimeType: 'audio/wav' },
        { type: 'text', text: 'kept' },
      ],
    },
    definition,
    f.context,
    f.assets,
    new AbortController().signal,
  );
  expect(JSON.stringify(converted)).not.toContain('c2VjcmV0');
  expect(JSON.stringify(converted)).toContain('Unsupported MCP content: audio');
});

test('reusing an old unreferenced asset renews the existing staging grace', async () => {
  const f = await imageFixture();
  const result = await f.tool.execute('pending_grace', {});
  const reference = toolImageReferences(result.details)[0]!;
  const bytes = await f.assets.read(reference.assetId);
  if (bytes === null) {
    throw new Error('Missing bytes');
  }
  f.store.orm.delete(toolCalls).where(eq(toolCalls.toolCallId, 'pending_grace')).run();
  f.store.orm.run(sql`UPDATE playground_assets SET created_at = '2000-01-01', last_used_at = '2000-01-01'`);
  const reused = await f.assets.ingest(f.seed.chatId, { bytes, declaredMime: reference.mimeType });
  expect(reused.id).toBe(reference.assetId);
  await f.assets.sweep();
  expect(await f.assets.read(reference.assetId)).not.toBeNull();
});
