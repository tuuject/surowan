/**
 * Submission lifecycle: a generation becomes a receipt the room publishes, and the
 * switch gates only new submissions.
 *
 * Split out of `test/playground/image.test.ts`; the header there describes the
 * full acceptance chain these cases exercise.
 */
import { stat } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { dailyUsage, hostSends, media } from '../../src/store/schema/index.ts';
import { imageDeliveryState } from '../../src/store/image-delivery.ts';
import {
  enableRoomImage,
  generationRows,
  playgroundImageFixture,
  publishThroughReceipt,
  releaseRoomInput,
  roomMessages,
  settledTask,
  submitGeneration,
  submitThroughRun,
  taskRows,
} from './image-fixtures.ts';

describe('playground image generation', () => {
  test('a generation finishes into a receipt and the room publishes the picture', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-1');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-1');
    await settledTask(f);
    await publishThroughReceipt(f, 'send-1', { generationId, text: 'the harbor' });

    const published = roomMessages(f);
    expect(published).toHaveLength(1);
    expect(published[0]!.message_revisions.kind).toBe('image');
    expect(published[0]!.message_revisions.caption).toBe('the harbor');
    const mediaRows = f.store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]).toMatchObject({ kind: 'photo', mimeType: 'image/png', hostKind: 'playground' });
    const stored = f.assets.resolve(mediaRows[0]!.localAssetId!);
    expect(stored).not.toBeNull();
    await expect(stat(stored!.path)).resolves.toBeDefined();

    // The ledger names the published room message, not a wire id.
    const sends = f.store.orm.select().from(hostSends).all();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      state: 'success',
      messageId: published[0]!.messages.id,
      telegramMessageId: null,
    });

    // The room's own usage is metered under the playground scope, never chat.
    const usage = f.store.orm.select().from(dailyUsage).all();
    expect(usage.some((row) => row.scope === 'playground' && row.metric === 'model_tokens')).toBe(true);
    expect(usage.filter((row) => row.scope === 'chat')).toEqual([]);
  });

  test('a delivered picture stays delivered after retention unlinks its room message', async () => {
    const f = await playgroundImageFixture();
    // Another room speaks first, so this room's rows are not numbered like its
    // sequence and the delivered id below tells the two apart.
    const otherRoom = f.playground.createRoom({ title: 'Other', members: [{ name: 'Bob', role: 'admin' }] });
    f.playground.submit(otherRoom.chatId, {
      requestKey: 'other-1',
      senderId: otherRoom.members[0]!.senderId,
      text: 'x',
    });
    const invocationId = releaseRoomInput(f, 'ask-unlinked');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-unlinked');
    await settledTask(f);
    await publishThroughReceipt(f, 'send-unlinked', { generationId });
    const published = roomMessages(f)[0]!.messages;
    expect(published.id).not.toBe(published.localSequenceNo);
    // What `ON DELETE SET NULL` leaves once retention removed the message.
    f.store.orm.update(hostSends).set({ messageId: null }).run();

    // The picture is still named by the room sequence the model was told.
    const state = imageDeliveryState(f.store.orm, f.room.conversationId, generationId);
    expect([...state.delivered.values()]).toEqual([String(published.localSequenceNo)]);
    expect(state.uncertain.size).toBe(0);
  });

  test('closing the switch only blocks new submissions; an accepted generation still lands', async () => {
    const f = await playgroundImageFixture();
    const invocationId = releaseRoomInput(f, 'ask-close');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, invocationId, 'call-close');

    enableRoomImage(f, false);
    await expect(submitGeneration(f, null, 'call-refused')).rejects.toThrow('image generation is disabled');
    expect(generationRows(f)).toHaveLength(1);

    await settledTask(f);
    await publishThroughReceipt(f, 'send-closed', { generationId });
    expect(roomMessages(f)).toHaveLength(1);
  });

  test('closing the switch while inputs are prepared refuses the submission', async () => {
    let close = (): void => {};
    const f = await playgroundImageFixture({ beforeInputImage: () => close() });
    enableRoomImage(f, true);
    close = () => enableRoomImage(f, false);
    await expect(
      f.bridge.submit({
        conversationId: f.room.conversationId,
        invocationId: null,
        toolCallId: 'call-closing',
        authoredPrompt: 'picture with an input',
        modelId: undefined,
        aspectRatio: undefined,
        resolution: undefined,
        outputCount: undefined,
        inputMediaIds: [1n],
        extendedData: undefined,
      }),
    ).rejects.toThrow('image generation is disabled');
    expect(generationRows(f)).toEqual([]);
    expect(taskRows(f)).toEqual([]);
    expect(f.providerCalls).toEqual([]);
  });
});
