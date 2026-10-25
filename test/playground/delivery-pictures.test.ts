/**
 * Bot Playground virtual delivery: pictures and albums.
 *
 * A room with a picture store publishes a picture with its stored asset, the
 * same bytes share one file, and a refused, cancelled or corrupt delivery
 * leaves no asset and no file behind.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createPlaygroundHost } from '../../src/adapters/local-monolith/playground/index.ts';
import { PlaygroundAssetStore } from '../../src/capabilities/media/local-assets.ts';
import { identityConversation } from '../../src/platform/im-host/identity.ts';
import { media, messageRevisions, playgroundAssets } from '../../src/store/schema/index.ts';
import {
  createRoom,
  directory,
  ledgerRow,
  NOW,
  reserveSend,
  roomMessages,
  store,
  telegramTransport,
} from './delivery-fixtures.ts';

describe('Bot Playground virtual delivery', () => {
  test('publishes a picture with its asset and refuses bytes it cannot store', async () => {
    const room = createRoom({ chatId: 50n, title: 'pictures', selfDisplayName: '碗' });
    const assets = new PlaygroundAssetStore({ orm: store.orm, root: join(directory, 'assets') });
    const host = createPlaygroundHost({
      store,
      self: { displayName: '碗' },
      pictures: assets,
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const target = { conversation, policy: host.policy(conversation) };
    const png = new Uint8Array(
      await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png()
        .toBuffer(),
    );
    const deliverPhoto = (sendId: bigint, bytes: Uint8Array, caption?: string) =>
      host.delivery.deliver({
        target,
        parts: [
          {
            kind: 'photo',
            bytes,
            fileName: 'room.png',
            mime: 'image/png',
            ...(caption === undefined ? {} : { caption }),
          },
        ],
        sendId,
        signal: undefined,
      });

    const firstSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-1', kind: 'photo' });
    const delivered = await deliverPhoto(firstSend, png, 'a room picture');
    expect(delivered.kind).toBe('delivered');
    const written = roomMessages(room.conversationId);
    expect(written).toHaveLength(1);
    const revision = store.orm
      .select()
      .from(messageRevisions)
      .where(eq(messageRevisions.messageId, written[0]!.id))
      .get();
    expect(revision).toMatchObject({ kind: 'image', caption: 'a room picture' });
    const mediaRows = store.orm.select().from(media).all();
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]).toMatchObject({ kind: 'photo', hostKind: 'playground', mimeType: 'image/png' });
    const assetId = mediaRows[0]!.localAssetId!;
    expect(assets.resolve(assetId)).not.toBeNull();

    // The same bytes delivered again share the one stored file.
    const repeatSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-2', kind: 'photo' });
    expect((await deliverPhoto(repeatSend, png)).kind).toBe('delivered');
    expect(store.orm.select().from(media).all()).toHaveLength(2);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(1);

    // Bytes that are not an image are refused permanently and store nothing.
    const badSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-3', kind: 'photo' });
    const refused = await deliverPhoto(badSend, new Uint8Array([1, 2, 3]));
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') {
      expect(refused.failure).toMatchObject({ reason: 'permanent', code: 'media_rejected', outcomeUnknown: false });
    }
    expect(ledgerRow(badSend)?.state).toBe('pending');
    expect(ledgerRow(badSend)?.messageId).toBeNull();
    expect(roomMessages(room.conversationId)).toHaveLength(2);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    expect(telegramTransport).not.toHaveBeenCalled();
  });

  test('a refused or cancelled picture delivery leaves no asset and no file behind', async () => {
    const room = createRoom({ chatId: 51n, title: 'albums', selfDisplayName: '碗' });
    const root = join(directory, 'album-assets');
    const assets = new PlaygroundAssetStore({ orm: store.orm, root });
    const controller = new AbortController();
    let abortDuringIngest = false;
    const host = createPlaygroundHost({
      store,
      self: { displayName: '碗' },
      // The real store, with a hook that cancels the run while a copy is in
      // flight (the window between validation and publishing).
      pictures: {
        validate: (input) => assets.validate(input),
        ingest: async (chatId, input) => {
          const asset = await assets.ingest(chatId, input);
          if (abortDuringIngest) {
            controller.abort();
          }
          return asset;
        },
        discard: (assetId) => assets.discard(assetId),
        markAttached: (assetId, mediaId) => assets.markAttached(assetId, mediaId),
      },
      sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      now: () => NOW,
    });
    const conversation = identityConversation(
      { chatId: room.chatId, threadId: 0n, conversationId: room.conversationId },
      'playground',
      'private',
    );
    const target = { conversation, policy: host.policy(conversation) };
    const picture = async (shade: number) =>
      new Uint8Array(
        await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: shade, g: 2, b: 3 } } })
          .png()
          .toBuffer(),
      );
    const storedFiles = async () =>
      (await readdir(root, { recursive: true }).catch(() => [])).filter((name) => name.endsWith('.png'));

    // A valid first picture and a corrupt second one: the album is refused as
    // a whole before anything is written.
    const truncated = (await picture(9)).subarray(0, 40);
    const albumSend = reserveSend(room.conversationId, room.invocationId, { id: 'album-1', kind: 'photo_album' });
    const refused = await host.delivery.deliver({
      target,
      parts: [
        {
          kind: 'photo_album',
          pictures: [
            { bytes: await picture(1), fileName: 'a.png', mime: 'image/png' },
            { bytes: truncated, fileName: 'b.png', mime: 'image/png' },
          ],
        },
      ],
      sendId: albumSend,
      signal: undefined,
    });
    expect(refused).toMatchObject({ kind: 'rejected', failure: { code: 'media_rejected' } });
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);

    // A run cancelled while the copy runs publishes nothing and keeps nothing.
    abortDuringIngest = true;
    const cancelledSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-c', kind: 'photo' });
    const cancelled = await host.delivery.deliver({
      target,
      parts: [{ kind: 'photo', bytes: await picture(2), fileName: 'c.png', mime: 'image/png' }],
      sendId: cancelledSend,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ kind: 'rejected', failure: { reason: 'aborted', outcomeUnknown: false } });
    expect(ledgerRow(cancelledSend)?.state).toBe('pending');
    expect(roomMessages(room.conversationId)).toHaveLength(0);
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);

    // An already cancelled run never starts the copy.
    const lateSend = reserveSend(room.conversationId, room.invocationId, { id: 'photo-d', kind: 'photo' });
    const late = await host.delivery.deliver({
      target,
      parts: [{ kind: 'photo', bytes: await picture(3), fileName: 'd.png', mime: 'image/png' }],
      sendId: lateSend,
      signal: controller.signal,
    });
    expect(late).toMatchObject({ kind: 'rejected', failure: { reason: 'aborted' } });
    expect(store.orm.select().from(playgroundAssets).all()).toHaveLength(0);
  });
});
