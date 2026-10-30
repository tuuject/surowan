import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { afterEach, expect, test, vi } from 'vitest';
import {
  AddMemoInputSchema,
  ReadMemoryInputSchema,
  SaveMemoImageInputSchema,
  SearchMemoryInputSchema,
  UpdateMemoInputSchema,
} from '../../src/context/memo-pad/index.ts';
import { HISTORY_MEDIA, definition, fixture, messageText, sceneRegistry } from './fixtures.ts';

afterEach(() => vi.useRealTimers());

test('real replay preserves live memory expiry and date bounds and reports primitive call ids without writes', async () => {
  const f = await fixture({
    definitions: () => ({
      tools: [
        ...sceneRegistry().tools,
        definition('read_memory', ReadMemoryInputSchema),
        definition('search_memory', SearchMemoryInputSchema),
      ],
      capabilities: [definition('add_memo', AddMemoInputSchema), definition('update_memo', UpdateMemoInputSchema)],
    }),
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date('2026-10-30T12:00:00.000Z');
  vi.setSystemTime(now);
  let id = '';
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('execute', {
        action: 'call',
        tool: 'add_memo',
        input: { summary: 'temporary', detail: 'memo detail', ttl_seconds: 60 },
      }),
      { stopReason: 'toolUse' },
    ),
    (context) => {
      id = messageText(context).match(/mem_[a-f0-9]{32}/)![0];
      return fauxAssistantMessage(
        [fauxToolCall('search_memory', { to: '2026-10-30' }), fauxToolCall('read_memory', { id })],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      expect(messageText(context)).toContain('memo detail');
      vi.setSystemTime(now.getTime() + 60_000);
      return fauxAssistantMessage(
        [
          fauxToolCall('search_memory', {}),
          fauxToolCall('read_memory', { id }),
          fauxToolCall('execute', { action: 'call', tool: 'update_memo', input: { id, ttl_seconds: null } }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('done'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result.error).toBeNull();
  expect(result.tool_calls.map((call) => call.is_error)).toEqual([false, false, false, false, true, true]);
  expect(JSON.stringify(result.tool_calls[1]?.result)).toContain('Found 1 memories');
  expect(JSON.stringify(result.tool_calls[3]?.result)).toContain('No matching memories');
  for (const call of result.tool_calls.filter(
    (call) => call.tool_name === 'read_memory' || call.tool_name === 'search_memory',
  )) {
    expect(result.fidelity.dispatches).toContainEqual({
      tool_call_id: call.tool_call_id,
      tool_name: call.tool_name,
      mode: 'synthetic',
    });
  }
  expect(f.rows()).toEqual(before);
});

test('real replay saves scene-authorized images for local reads and rejects missing and cross-scene references', async () => {
  const loaded: bigint[] = [];
  const image = {
    type: 'image' as const,
    data: Buffer.from('real scene bytes').toString('base64'),
    mimeType: 'image/png',
  };
  const f = await fixture({
    images: true,
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [
        definition('save_memo_image', SaveMemoImageInputSchema),
        definition('read_image', Type.Object({ image_ref: Type.String() })),
      ],
    }),
    imageLoader: async (id, signal) => {
      signal.throwIfAborted();
      loaded.push(id);
      return image;
    },
  });
  let ref = '';
  let uri = '';
  f.faux.setResponses([
    (context) => {
      ref = messageText(context).match(/img_[a-f0-9]+/)![0];
      return fauxAssistantMessage(
        [
          fauxToolCall('execute', { action: 'call', tool: 'save_memo_image', input: { image_ref: ref } }),
          fauxToolCall('execute', { action: 'call', tool: 'save_memo_image', input: { image_ref: 'img_missing' } }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      uri = messageText(context).match(/pwblob:\/\/blb_[a-f0-9]{32}/)![0];
      return fauxAssistantMessage(
        fauxToolCall('execute', {
          action: 'call',
          tool: 'read_image',
          input: { image_ref: uri },
        }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const images = context.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : [],
      );
      expect(images).toContainEqual(image);
      return fauxAssistantMessage('done');
    },
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result.error).toBeNull();
  expect(result.tool_calls.map((call) => call.is_error)).toEqual([false, true, false]);
  expect(loaded).toEqual([HISTORY_MEDIA]);
  const saveId = result.tool_calls[0]!.tool_call_id;
  const readId = result.tool_calls[2]!.tool_call_id;
  expect(result.fidelity.dispatches).toEqual([
    { tool_call_id: saveId, tool_name: 'execute', mode: 'live_read', capability: 'save_memo_image' },
    { tool_call_id: saveId, tool_name: 'execute', mode: 'synthetic', capability: 'save_memo_image' },
    {
      tool_call_id: result.tool_calls[1]!.tool_call_id,
      tool_name: 'execute',
      mode: 'live_read',
      capability: 'save_memo_image',
    },
    { tool_call_id: readId, tool_name: 'execute', mode: 'synthetic', capability: 'read_image' },
  ]);
  expect(f.rows()).toEqual(before);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('execute', { action: 'call', tool: 'save_memo_image', input: { image_ref: ref } }),
        fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: uri } }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('done'),
  ]);
  const next = await f.run();
  expect(next.tool_calls.map((call) => call.is_error)).toEqual([true, true]);
  expect(loaded).toEqual([HISTORY_MEDIA]);
  expect(f.rows()).toEqual(before);
});

test('real replay refuses image saves when no scene loader is available', async () => {
  const f = await fixture({
    images: true,
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [definition('save_memo_image', SaveMemoImageInputSchema)],
    }),
  });
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('execute', {
        action: 'call',
        tool: 'save_memo_image',
        input: { image_ref: 'img_missing' },
      }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('done'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result.tool_calls[0]?.is_error).toBe(true);
  expect(result.fidelity.dispatches).toEqual([
    {
      tool_call_id: result.tool_calls[0]!.tool_call_id,
      tool_name: 'execute',
      mode: 'blocked',
      capability: 'save_memo_image',
    },
  ]);
  expect(f.rows()).toEqual(before);
});
