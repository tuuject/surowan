/**
 * What a Bot Playground room does with a delivery: validate the parts, copy
 * the picture files, and publish the message row the room will show.
 *
 * Pictures are copied before the publishing transaction because the file write
 * cannot be undone by a rollback, so a delivery that does not publish after the
 * copy discards what it added. The message itself is written in one
 * transaction keyed by the send ledger row.
 */
import { eq } from 'drizzle-orm';
import { type LocalAsset, LocalAssetRejected, sniffImageMime } from '../../capabilities/media/local-assets.ts';
import type {
  ImComposedPart,
  ImDeliveredMessage,
  ImDelivery,
  ImDeliveryOutcome,
  ImDeliveryRequest,
  ImOutgoingPart,
} from '../../platform/im-host.ts';
import { hostSends, media, messageRevisions, messages, rooms } from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { PlaygroundPictures } from './playground-host.ts';
import { abortedDelivery, DeliveryRefused, type RoomReaders, rejected } from './playground-host-room.ts';

/**
 * A mention is plain text in a room, and there is no markup dialect to render
 * into, so a part composes to its own text. It is never shortened here: the
 * send pipeline validates what compose returns, and a cut would let an
 * oversized message pass that check and lose its tail.
 */
const composePlaygroundPart = (part: ImOutgoingPart): ImComposedPart => {
  if (part.kind === 'text') {
    return { text: part.text, markup: null };
  }
  if (part.kind === 'sticker') {
    return { text: null, markup: null };
  }
  // A picture carries its caption, exactly as the message will show it.
  return { text: part.caption ?? null, markup: null };
};

/** What one published room message carries. */
type RoomMessageContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly caption: string | null; readonly pictures: readonly LocalAsset[] };

/** The live objects a delivery publishes through; never a copy of them. */
export interface PlaygroundDeliveryDeps {
  readonly store: BusinessStore;
  readonly pictures: PlaygroundPictures | undefined;
  readonly now: () => Date;
  readonly room: RoomReaders;
}

export function createPlaygroundDelivery(deps: PlaygroundDeliveryDeps): ImDelivery {
  const { store, pictures: pictureStore, now, room } = deps;
  const { orm } = store;

  /**
   * Copies one part's pictures into the room's local store. Images are
   * validated by content, so a payload whose declared type does not match what
   * it really is never becomes a room asset. The whole part is validated
   * before any file is written: an album with one bad picture leaves nothing.
   * `created` lists the assets this call added, for the caller to discard if
   * the delivery does not publish after all.
   */
  const ingestPictures = async (
    chatId: bigint,
    part: Extract<ImOutgoingPart, { kind: 'photo' | 'photo_album' }>,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly assets: readonly LocalAsset[]; readonly created: readonly string[] }> => {
    if (pictureStore === undefined) {
      throw new Error('the room has no picture store');
    }
    const candidates =
      part.kind === 'photo'
        ? [{ bytes: part.bytes, fileName: part.fileName, mime: part.mime }]
        : part.pictures.map((picture) => ({
            bytes: picture.bytes,
            fileName: picture.fileName,
            mime: picture.mime,
          }));
    if (candidates.length === 0) {
      throw new LocalAssetRejected('empty', 'the picture part carries no pictures');
    }
    const inputs = candidates.map((candidate) => {
      const sniffed = sniffImageMime(candidate.bytes);
      if (sniffed === null) {
        throw new LocalAssetRejected(
          'unsupported_type',
          `picture ${candidate.fileName} is not a JPEG, PNG or WebP image`,
        );
      }
      return {
        bytes: candidate.bytes,
        // The declared type must agree with the content; when the producer
        // did not state one, the content is the claim.
        declaredMime: candidate.mime ?? sniffed,
        name: candidate.fileName,
      };
    });
    for (const input of inputs) {
      await pictureStore.validate(input);
    }
    const assets: LocalAsset[] = [];
    const created: string[] = [];
    try {
      for (const input of inputs) {
        if (signal?.aborted === true) {
          throw new DeliveryRefused(abortedDelivery());
        }
        const asset = await pictureStore.ingest(chatId, input);
        assets.push(asset);
        if (asset.created) {
          created.push(asset.id);
        }
      }
    } catch (error) {
      await discardPictures(created);
      throw error;
    }
    return { assets, created };
  };

  /** Drops assets a delivery created but never published. */
  const discardPictures = async (assetIds: readonly string[]): Promise<void> => {
    for (const assetId of assetIds) {
      await pictureStore?.discard(assetId);
    }
  };

  const publish = (request: ImDeliveryRequest, content: RoomMessageContent): ImDeliveredMessage => {
    const ledger = room.reservedSend(request.sendId);
    const mismatch = room.ledgerRefusal(request, ledger);
    if (mismatch !== undefined) {
      throw new DeliveryRefused(mismatch);
    }
    const republished = room.republishedMessage(ledger);
    if (republished !== undefined) {
      return republished;
    }
    const checked = room.checkedRoom(
      request,
      content.kind === 'text'
        ? { kind: 'text', text: content.text, caption: null }
        : { kind: 'image', text: null, caption: content.caption },
    );
    if ('refusal' in checked) {
      throw new DeliveryRefused(checked.refusal);
    }
    // Read the sequence counter inside the caller's transaction: it is a
    // read-modify-write pair, so resolving it beforehand could lose an update
    // from a send that committed in between. The room revision is left alone:
    // it guards inputs and settings, and bot output must not invalidate a
    // Release a client prepared meanwhile.
    const { room: resolved, replyTo } = checked;
    const stamp = now().toISOString();
    const sequenceNo = resolved.nextSeq;

    const createdMessage = orm
      .insert(messages)
      .values({
        conversationId: request.target.conversation.id,
        chatId: resolved.chatId,
        hostKind: 'playground',
        telegramMessageId: null,
        visible: true,
        sentByBot: true,
        telegramDate: stamp,
        receivedAt: stamp,
        localReplyToMessageId: replyTo,
        localSequenceNo: sequenceNo,
      })
      .returning({ id: messages.id })
      .get();
    if (createdMessage === undefined) {
      throw new Error('messages insert returned no row');
    }
    const revision = orm
      .insert(messageRevisions)
      .values({
        messageId: createdMessage.id,
        // A published message starts its own revision history.
        revisionNo: 1n,
        senderId: room.resolveSelfSender(resolved.chatId, stamp),
        kind: content.kind,
        text: content.kind === 'text' ? content.text : null,
        caption: content.kind === 'image' ? content.caption : null,
        // The reply edge lives on the message row, as for every room message;
        // this column holds a Telegram message id, which a room has none of.
        replyToMessageId: null,
        createdAt: stamp,
        rawFragmentJson: '{}',
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('message_revisions insert returned no row');
    }
    if (content.kind === 'image') {
      // Every delivered picture is a media row of this message, and every row
      // names the local asset it shows; the asset store may not delete a file
      // while any of those rows exists.
      for (const picture of content.pictures) {
        const mediaRow = orm
          .insert(media)
          .values({
            revisionId: revision.id,
            kind: 'photo',
            fileId: `local:${picture.id}`,
            fileUniqueId: `local:${resolved.chatId.toString()}:${picture.sha256}`,
            mimeType: picture.mime,
            fileSize: BigInt(picture.byteSize),
            width: BigInt(picture.width),
            height: BigInt(picture.height),
            telegramJson: JSON.stringify({ sent: true, generated: true }),
            hostKind: 'playground',
            localAssetId: picture.id,
          })
          .returning({ id: media.id })
          .get();
        if (mediaRow === undefined) {
          throw new Error('media insert returned no row');
        }
        pictureStore?.markAttached(picture.id, mediaRow.id);
      }
    }
    orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, createdMessage.id)).run();
    orm
      .update(rooms)
      .set({ nextSeq: sequenceNo + 1n, updatedAt: stamp })
      .where(eq(rooms.chatId, resolved.chatId))
      .run();
    orm
      .update(hostSends)
      .set({
        state: 'success',
        messageId: createdMessage.id,
        // The host-native id, as a Telegram send records the wire id: the
        // number the model was told, which still names the message after
        // retention cleared the row link above.
        responseJson: JSON.stringify({ message_id: sequenceNo.toString() }),
        finishedAt: stamp,
      })
      .where(eq(hostSends.id, request.sendId))
      .run();
    return { partIndex: 0, messageId: sequenceNo, sentAtSeconds: room.deliveredAt(stamp) };
  };

  return {
    compose: composePlaygroundPart,
    // A room publishes into exactly the conversation it belongs to.
    crossConversationTargets: false,
    deliver: async (request: ImDeliveryRequest): Promise<ImDeliveryOutcome> => {
      const [part] = request.parts;
      if (part === undefined) {
        return rejected('permanent', 'no_parts', 'a delivery needs at least one part');
      }
      // The ledger row links exactly one published message, so a room takes one
      // part per delivery. Reporting the first as delivered and dropping the rest
      // would be a silent loss.
      if (request.parts.length > 1) {
        return rejected(
          'permanent',
          'multipart_unsupported',
          `a Bot Playground room publishes one part per delivery, not ${request.parts.length}`,
        );
      }
      try {
        const ledger = room.reservedSend(request.sendId);
        const mismatch = room.ledgerRefusal(request, ledger);
        if (mismatch !== undefined) {
          return mismatch;
        }
        const republished = room.republishedMessage(ledger);
        if (republished !== undefined) {
          return { kind: 'delivered', messages: [republished], recordedByHost: true };
        }
        if (part.kind === 'sticker') {
          // A sticker would need a wire to resolve, and a message that claims to
          // have carried one would be worse than a clear refusal.
          return rejected('permanent', 'unsupported_media', 'a Bot Playground room cannot show a sticker message');
        }
        const shape =
          part.kind === 'text'
            ? ({ kind: 'text', text: part.text, caption: null } as const)
            : ({ kind: 'image', text: null, caption: part.caption ?? null } as const);
        const checked = room.checkedRoom(request, shape);
        if ('refusal' in checked) {
          return checked.refusal;
        }
        // Read through a call: the flag can flip across the awaits below.
        const aborted = (): boolean => request.signal?.aborted === true;
        if (aborted()) {
          return abortedDelivery();
        }
        if (part.kind === 'text') {
          const published = store.transaction(() => publish(request, { kind: 'text', text: part.text }));
          return { kind: 'delivered', messages: [published], recordedByHost: true };
        }
        // Pictures are copied before the publishing transaction, because the
        // file write cannot be undone by a rollback. Everything knowable in
        // advance was refused above; a picture that fails validation refuses
        // the delivery with nothing attached to the room, and a delivery that
        // does not publish after the copy discards what it added.
        const pictures = await ingestPictures(checked.room.chatId, part, request.signal);
        try {
          // The copy is the only await: a run cancelled meanwhile must not
          // publish, or the room would show a message the run never sent.
          if (aborted()) {
            throw new DeliveryRefused(abortedDelivery());
          }
          const published = store.transaction(() =>
            publish(request, { kind: 'image', caption: part.caption ?? null, pictures: pictures.assets }),
          );
          return { kind: 'delivered', messages: [published], recordedByHost: true };
        } catch (error) {
          await discardPictures(pictures.created);
          throw error;
        }
      } catch (error) {
        if (error instanceof DeliveryRefused) {
          return error.outcome;
        }
        // A payload the room refuses is a permanent failure of this delivery,
        // not a hiccup: retrying the same bytes would fail the same way.
        if (error instanceof LocalAssetRejected) {
          return rejected('permanent', 'media_rejected', error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return rejected('transient', 'room_write_failed', `the room could not record the message: ${message}`);
      }
    },
  };
}
