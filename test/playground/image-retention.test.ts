/**
 * Retention, backups and scheduler pressure: message retention never deletes the
 * generation archive or an unhandled receipt, and a queued receipt never makes the
 * scheduler spin.
 *
 * Split out of `test/playground/image.test.ts`; the header there describes the
 * full acceptance chain these cases exercise.
 */
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { backupDatabase } from '../../src/adapters/local-monolith/database.ts';
import { invocations, media } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import {
  enableRoomImage,
  generationRows,
  playgroundImageFixture,
  publishThroughReceipt,
  receiptRows,
  releaseRoomInput,
  roomMessages,
  settledGeneration,
  settledTask,
  submitGeneration,
  submitThroughRun,
  taskRows,
} from './image-fixtures.ts';

describe('playground image generation', () => {
  test('message retention keeps the generation archive and an unhandled receipt', async () => {
    const f = await playgroundImageFixture();
    const published = releaseRoomInput(f, 'ask-retention');
    enableRoomImage(f, true);
    const generationId = await submitThroughRun(f, published, 'call-retention');
    await settledTask(f);
    await publishThroughReceipt(f, 'send-retention', { generationId });
    const mediaRows = f.store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    const assetId = mediaRows[0]!.localAssetId!;
    const assetPath = f.assets.resolve(assetId)!.path;

    // A second generation settles but its receipt is left unhandled.
    const pending = releaseRoomInput(f, 'ask-pending');
    await submitThroughRun(f, pending, 'call-pending');
    await expect.poll(() => taskRows(f).length).toBe(2);
    await expect.poll(() => receiptRows(f).some((row) => row.state === 'pending')).toBe(true);

    // A referenced asset survives a sweep and reaches the backup copy.
    await f.assets.sweep({ staleAfterMs: 0 });
    expect(f.assets.resolve(assetId)).not.toBeNull();
    const backup = await backupDatabase(f.config);
    const imagesRoot = join(f.config.data_dir, 'images');
    await expect(
      stat(join(backup.replace(/\.sqlite$/, '.images'), relative(imagesRoot, assetPath))),
    ).resolves.toBeDefined();

    // Retention removes the room's messages and media rows. The generation
    // archive, its audit and the unhandled receipt are never touched by it.
    purgeExpiredData(f.store.orm, f.config, new Date(Date.now() + 31 * 86_400_000));
    expect(roomMessages(f).filter((row) => row.messages.sentByBot)).toEqual([]);
    expect(f.store.orm.select().from(media).all()).toEqual([]);
    expect(generationRows(f)).toHaveLength(2);
    const outputs = f.bridge.sendableOutputs(generationId, f.room.conversationId);
    expect(outputs).toHaveLength(1);
    expect(f.bridge.assetContent(outputs![0]!.asset_id).bytes.byteLength).toBeGreaterThan(0);
    expect(receiptRows(f).some((row) => row.state === 'pending')).toBe(true);

    // The room's own copy is deleted only once nothing references it; the
    // archive original above stays readable.
    await f.assets.sweep({ staleAfterMs: 0 });
    expect(f.assets.resolve(assetId)).toBeNull();
    await expect(stat(assetPath)).rejects.toThrow();
    expect(f.bridge.assetContent(outputs![0]!.asset_id).bytes.byteLength).toBeGreaterThan(0);
  });

  test('a receipt queued behind a full concurrency never makes the scheduler spin', async () => {
    const f = await playgroundImageFixture({ maxConcurrency: 1 });
    enableRoomImage(f, true);

    // A second room occupies the only slot with a run held open by a gate.
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let blocked = false;
    const otherRoom = f.playground.createRoom({ title: 'Other', members: [{ name: 'Bob', role: 'admin' }] });
    const otherSubmitted = f.playground.submit(otherRoom.chatId, {
      requestKey: 'other-1',
      senderId: otherRoom.members[0]!.senderId,
      text: 'block the slot',
    });
    const otherRelease = f.playground.release(otherRoom.chatId, {
      releaseKey: 'other-1-release',
      revision: otherSubmitted.revision,
    });
    f.faux.setResponses([
      async () => {
        blocked = true;
        await gate;
        return fauxAssistantMessage('slot released');
      },
      () => fauxAssistantMessage('receipt handled'),
    ]);
    f.scheduler.start();
    f.scheduler.wake();
    await expect.poll(() => blocked).toBe(true);
    expect(
      f.store.orm.select().from(invocations).where(eq(invocations.id, otherRelease.invocationId!)).get()?.state,
    ).toBe('running');

    // The room's generation settles into a receipt while the slot is taken.
    await submitGeneration(f, null, 'call-busy');
    await settledGeneration(f);
    await settledTask(f);
    const [receiptInvocationId] = f.scheduler.processTasksDue();
    if (receiptInvocationId === undefined) {
      throw new Error('expected a receipt invocation');
    }
    expect(f.store.orm.select().from(invocations).where(eq(invocations.id, receiptInvocationId)).get()?.state).toBe(
      'queued',
    );
    // The queued receipt cannot launch, so the next wakeup must be the far
    // scheduler deadline, not the already-passed receipt deadline.
    expect(f.scheduler.nextDelayMilliseconds()).toBeGreaterThan(1_000);

    openGate?.();
    await expect
      .poll(
        () =>
          f.store.orm
            .select({ state: invocations.state })
            .from(invocations)
            .where(eq(invocations.id, receiptInvocationId))
            .get()?.state,
      )
      .not.toBe('queued');
    await f.scheduler.stop(0);
  });
});
