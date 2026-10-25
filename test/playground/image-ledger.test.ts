/**
 * Billing and authorization: one tool call bills once, a conflicting replay is
 * refused, and a generation is only resolvable inside the room that owns it.
 *
 * Split out of `test/playground/image.test.ts`; the header there describes the
 * full acceptance chain these cases exercise.
 */
import { describe, expect, test } from 'vitest';
import {
  enableRoomImage,
  generationRows,
  playgroundImageFixture,
  releaseRoomInput,
  settledGeneration,
  submitGeneration,
  submitThroughRun,
  taskRows,
} from './image-fixtures.ts';

describe('playground image generation', () => {
  test('one tool call bills once; a conflicting replay of the same key is refused', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-replay');
    enableRoomImage(f, true);
    const first = await submitGeneration(f, invocationId, 'call-replay');
    const again = await submitGeneration(f, invocationId, 'call-replay');
    expect(again.generationId).toBe(first.generationId);
    expect(again.replayed).toBe(true);
    expect(generationRows(f)).toHaveLength(1);
    expect(taskRows(f)).toHaveLength(1);
    await settledGeneration(f);
    await expect.poll(() => f.providerCalls.length).toBe(1);

    // The same key with different content is a conflict, not a second bill.
    await expect(
      f.bridge.submit({
        conversationId: f.room.conversationId,
        invocationId,
        toolCallId: 'call-replay',
        authoredPrompt: 'something else entirely',
        modelId: undefined,
        aspectRatio: undefined,
        resolution: undefined,
        outputCount: undefined,
        inputMediaIds: [],
        extendedData: undefined,
      }),
    ).rejects.toThrow(/Idempotency-Key/);
    expect(generationRows(f)).toHaveLength(1);
    expect(taskRows(f)).toHaveLength(1);
  });

  test('a foreign generation is never resolvable and the switch authorizes per conversation', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-foreign');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-foreign');

    expect(f.bridge.sendableOutputs(generationId, 999n)).toBeUndefined();
    expect(f.bridge.sendableOutputs('00000000-0000-4000-8000-000000000000', f.room.conversationId)).toBeUndefined();
    expect(f.bridge.enabledFor(999n)).toBe(false);
  });
});
