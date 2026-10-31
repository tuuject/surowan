import Type from 'typebox';
import { expect, test } from 'vitest';
import { SaveMemoImageInputSchema } from '../../src/context/memo-pad/index.ts';
import { createReplayTools } from '../../src/orchestration/replay/tools.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { callCapability, definition, envelopeOf, replayInput } from './tools-fixtures.ts';

const registry = replayInput({
  tools: [definition('execute')],
  capabilities: [
    definition('save_memo_image', SaveMemoImageInputSchema),
    definition('read_image', Type.Object({ image_ref: Type.String() })),
  ],
});

test('saved replay images retain authorized bytes locally and report both dispatch paths', async () => {
  const loaded: string[] = [];
  const image = {
    type: 'image' as const,
    data: Buffer.from('scene image bytes').toString('base64'),
    mimeType: 'image/jpeg',
  };
  const replay = createReplayTools(registry, emptySystemResources(), {
    readImage: async (ref, signal) => {
      signal.throwIfAborted();
      loaded.push(ref);
      if (ref !== 'img_scene') {
        throw new Error('image_ref is not visible in this scene');
      }
      return image;
    },
  });
  const saved = await callCapability(replay, 'save', 'save_memo_image', { image_ref: 'img_scene' });
  const uri = envelopeOf(saved).text.match(/pwblob:\/\/blb_[a-f0-9]{32}/)?.[0];
  expect(uri).toBeDefined();
  const read = await callCapability(replay, 'read', 'read_image', { image_ref: uri });
  expect(read.content).toContainEqual(image);
  expect(loaded).toEqual(['img_scene']);
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'save', tool_name: 'execute', mode: 'live_read', capability: 'save_memo_image' },
    { tool_call_id: 'save', tool_name: 'execute', mode: 'synthetic', capability: 'save_memo_image' },
    { tool_call_id: 'read', tool_name: 'execute', mode: 'synthetic', capability: 'read_image' },
  ]);
  await expect(callCapability(replay, 'missing', 'save_memo_image', { image_ref: 'img_missing' })).rejects.toThrow(
    'not visible',
  );
  expect(replay.dispatches.filter((entry) => entry.tool_call_id === 'missing')).toEqual([
    { tool_call_id: 'missing', tool_name: 'execute', mode: 'live_read', capability: 'save_memo_image' },
  ]);
});

test('saving an image without a scene loader is blocked rather than reporting invented success', async () => {
  const replay = createReplayTools(registry, emptySystemResources());
  await expect(callCapability(replay, 'save', 'save_memo_image', { image_ref: 'img_missing' })).rejects.toThrow(
    'replay blocks capability',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'save', tool_name: 'execute', mode: 'blocked', capability: 'save_memo_image' },
  ]);
});
