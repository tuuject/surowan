import type { PublicModel } from '@surowan/image-service';
import { expect, test } from 'vitest';
import { AddMemoryInputSchema, DeleteMemoryInputSchema } from '../../src/context/memory.ts';
import { createReplayTools } from '../../src/orchestration/replay/tools.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { AlarmInputSchema, DeleteAlarmInputSchema, ListAlarmInputSchema } from '../../src/plugins/alarm/alarm.ts';
import { ImageGenerateInputSchema, ListImageModelsInputSchema } from '../../src/plugins/image/image.ts';
import { callCapability, definition, envelopeOf, replayInput } from './tools-fixtures.ts';

/** A credential-free PublicModel directory entry; `description` is optional. */
function imageModel(overrides: Partial<PublicModel> = {}): PublicModel {
  return {
    id: 'model-a',
    name: 'Model A',
    provider: 'openrouter',
    upstreamModel: 'org/model-a',
    providerTag: 'image',
    capabilities: {
      imageInput: false,
      maxInputImages: 0,
      maxOutputs: 4,
      aspectRatios: ['1:1', '16:9'],
      resolutionClasses: ['auto', 'medium'],
    },
    ...overrides,
  };
}

test('memory capabilities use an in-memory map without a store', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('add_memory', AddMemoryInputSchema),
        definition('delete_memory', DeleteMemoryInputSchema),
      ],
    }),
    emptySystemResources(),
  );
  const added = envelopeOf(await callCapability(replay, 'exec-1', 'add_memory', { content: 'owner likes cats' }));
  const id = /^Saved memory (mem_[a-f0-9]{32}); it expires at /.exec(added.text)?.[1];
  if (id === undefined) {
    throw new Error(`Unexpected add_memory result: ${added.text}`);
  }
  expect(envelopeOf(await callCapability(replay, 'exec-2', 'delete_memory', { id }))).toEqual({
    text: `Memory ${id} deleted`,
  });
  expect(envelopeOf(await callCapability(replay, 'exec-3', 'delete_memory', { id }))).toEqual({
    text: `Memory ${id} was already gone`,
  });
  await expect(callCapability(replay, 'exec-4', 'add_memory', {})).rejects.toThrow(
    'execute.call input does not match the schema of add_memory',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-1', tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' },
    { tool_call_id: 'exec-2', tool_name: 'execute', mode: 'synthetic', capability: 'delete_memory' },
    { tool_call_id: 'exec-3', tool_name: 'execute', mode: 'synthetic', capability: 'delete_memory' },
    { tool_call_id: 'exec-4', tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' },
  ]);
});

test('alarm capabilities schedule, list, and delete in memory and start unseeded', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('alarm', AlarmInputSchema),
        definition('list_alarm', ListAlarmInputSchema),
        definition('delete_alarm', DeleteAlarmInputSchema),
      ],
    }),
    emptySystemResources(),
  );
  const unseeded = envelopeOf(await callCapability(replay, 'alarm-list-1', 'list_alarm', {}));
  expect(JSON.parse(unseeded.text)).toEqual({ items: [] });
  const created = envelopeOf(
    await callCapability(replay, 'alarm-1', 'alarm', {
      target_user_id: '42',
      summary: 'check the oven',
      datetime: '2030-01-02T03:04:05Z',
    }),
  );
  expect(created.text).toBe('Scheduled alarm 1 for 2030-01-02T03:04:05.000Z');
  const listed = envelopeOf(await callCapability(replay, 'alarm-list-2', 'list_alarm', {}));
  expect(JSON.parse(listed.text)).toEqual({
    items: [{ id: '1', scheduled_at: '2030-01-02T03:04:05.000Z', summary: 'check the oven' }],
  });
  expect(envelopeOf(await callCapability(replay, 'alarm-3', 'delete_alarm', { id: '1' }))).toEqual({
    text: 'Cancelled alarm 1',
  });
  await expect(callCapability(replay, 'alarm-4', 'delete_alarm', { id: '1' })).rejects.toThrow(
    'execute.call delete_alarm failed: alarm not found',
  );
});

test('image_generate synthesizes distinct generation ids without the image bridge', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('image_generate', ImageGenerateInputSchema)],
    }),
    emptySystemResources(),
  );
  const first = envelopeOf(await callCapability(replay, 'image-1', 'image_generate', { prompt: 'a cat' }));
  expect(first.text).toMatch(
    /^Generation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} submitted on model replay \(1 output\(s\)\)\./,
  );
  const second = envelopeOf(
    await callCapability(replay, 'image-2', 'image_generate', { prompt: 'a dog', output_count: 3 }),
  );
  expect(second.text).toContain('(3 output(s))');
  expect(second.text).not.toBe(first.text);
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'image-1', tool_name: 'execute', mode: 'synthetic', capability: 'image_generate' },
    { tool_call_id: 'image-2', tool_name: 'execute', mode: 'synthetic', capability: 'image_generate' },
  ]);
});

test('list_image_models pages the configured directory with descriptions and no credentials', async () => {
  const models = [
    imageModel({ id: 'line-art', name: 'Line Art', description: 'clean line art, good for stickers' }),
    imageModel({ id: 'anime', name: 'Anime', description: 'anime style' }),
    imageModel({ id: 'photo', name: 'Photo' }),
    imageModel({ id: 'pixel', name: 'Pixel' }),
    imageModel({ id: 'ink', name: 'Ink' }),
  ];
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('list_image_models', ListImageModelsInputSchema)],
    }),
    emptySystemResources(),
    { imageModels: models },
  );
  const first = envelopeOf(await callCapability(replay, 'models-1', 'list_image_models', {}));
  expect(JSON.parse(first.text)).toEqual({ models: models.slice(0, 4), total: 5, next_offset: 4 });
  expect(first.text).toContain('clean line art, good for stickers');
  // The directory is credential-free by contract; the serialized page must never
  // mention credentials, and nothing here can submit a generation or touch the bridge.
  expect(first.text).not.toMatch(/credential/i);
  const second = envelopeOf(await callCapability(replay, 'models-2', 'list_image_models', { offset: 4 }));
  expect(JSON.parse(second.text)).toEqual({ models: models.slice(4), total: 5, next_offset: null });
  await expect(callCapability(replay, 'models-3', 'list_image_models', { offset: 101 })).rejects.toThrow(
    'execute.call input does not match the schema of list_image_models',
  );
  await expect(callCapability(replay, 'models-4', 'list_image_models', { offset: -1 })).rejects.toThrow(
    'execute.call input does not match the schema of list_image_models',
  );
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'models-1', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-2', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-3', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
    { tool_call_id: 'models-4', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
  ]);
});

test('list_image_models without a catalog is an explicit empty page and stays blocked when unregistered', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('list_image_models', ListImageModelsInputSchema)],
    }),
    emptySystemResources(),
  );
  const empty = envelopeOf(await callCapability(replay, 'models-1', 'list_image_models', {}));
  expect(JSON.parse(empty.text)).toEqual({ models: [], total: 0, next_offset: null });
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'models-1', tool_name: 'execute', mode: 'synthetic', capability: 'list_image_models' },
  ]);
  // A registry that never listed the capability still refuses it: the current
  // registry is the only source of truth for what a scene may call.
  const without = createReplayTools(
    replayInput({ tools: [definition('execute')], capabilities: [] }),
    emptySystemResources(),
  );
  await expect(callCapability(without, 'models-2', 'list_image_models', {})).rejects.toThrow(
    'execute has no capability named list_image_models',
  );
  expect(without.dispatches).toEqual([
    { tool_call_id: 'models-2', tool_name: 'execute', mode: 'blocked', capability: 'list_image_models' },
  ]);
});
