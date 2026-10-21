/**
 * The virtual host of a Bot Playground room.
 *
 * A room has no wire, so this host has nothing to translate and nothing to
 * send. What it does own is the other half of a delivery: publishing the
 * message the bot produced - the message row, its first revision, any local
 * pictures it carried and the local arrival order - and recording the send
 * that produced it, in one transaction keyed by the send ledger row.
 *
 * Everything a Telegram host reports from the wire (`sentAtSeconds`, a host
 * message id) is therefore decided here instead, which is why the caller does
 * not mirror or finalize anything this host accepted. A room's host message id
 * is its sequence number, in both directions: a reply names the sequence the
 * model was shown, and a delivery reports the sequence it took. Row ids stay
 * inside this file.
 */
import { and, eq } from 'drizzle-orm';
import {
  LocalAssetRejected,
  sniffImageMime,
  type LocalAsset,
  type LocalAssetInput,
} from '../../capabilities/media/local-assets.ts';
import {
  conversationKey,
  resolveConversationPolicy,
  TELEGRAM_MAX_TEXT_LENGTH,
  type ImActivity,
  type ImComposedPart,
  type ImConversationPolicy,
  type ImConversationRef,
  type ImDeliveredMessage,
  type ImDelivery,
  type ImDeliveryFailureReason,
  type ImDeliveryOutcome,
  type ImDeliveryPolicy,
  type ImDeliveryRequest,
  type ImDeliveryTarget,
  type ImHost,
  type ImOutgoingPart,
  type ImSendRatePolicy,
} from '../../platform/im-host.ts';
import {
  chats,
  conversations,
  hostSends,
  media,
  messageRevisions,
  messages,
  roomParticipants,
  rooms,
  senders,
} from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';

/** Who a room shows as the author of the messages the bot publishes. */
export interface PlaygroundSelfIdentity {
  readonly displayName: string;
  readonly username?: string | null;
}

/** The room's local picture store, as a delivery uses it. */
export interface PlaygroundPictures {
  /** Refuses a picture `ingest` would refuse, without writing anything. */
  validate(input: LocalAssetInput): Promise<void>;
  /**
   * Validates and stores one picture; content-addressed per room. `created`
   * is false when the room already held the same bytes.
   */
  ingest(chatId: bigint, input: LocalAssetInput): Promise<LocalAsset & { readonly created: boolean }>;
  /** Removes an asset this host created, unless a message references it. */
  discard(assetId: string): Promise<void>;
  /** Points an asset at the message media row that now owns it. */
  markAttached(assetId: string, mediaId: bigint): void;
}

export interface PlaygroundHostOptions {
  /** The store a delivery writes through. Also supplies the transaction. */
  readonly store: BusinessStore;
  readonly self: PlaygroundSelfIdentity;
  /** Local pictures; without it a room cannot publish an image message. */
  readonly pictures?: PlaygroundPictures;
  /** Resolved per call: it is pure, and the configured rate can change. */
  readonly sendRate: () => ImSendRatePolicy;
  readonly now?: () => Date;
}

/** The room a delivery targets, with the counter it must advance. */
interface ResolvedRoom {
  readonly chatId: bigint;
  readonly hostKind: string;
  readonly nextSeq: bigint;
}

/** A room that passed every read-only check, with the stored row its reply names. */
interface CheckedRoom {
  readonly room: ResolvedRoom;
  readonly replyTo: bigint | null;
}

/** A refusal always names why, so a room can show it instead of a blank turn. */
const rejected = (
  reason: ImDeliveryFailureReason,
  code: string,
  description: string,
  outcomeUnknown = false,
): ImDeliveryOutcome => ({
  kind: 'rejected',
  failure: { reason, code, description, outcomeUnknown },
});

/** A cancelled run's send: nothing reached the room, so the outcome is known. */
const abortedDelivery = (): ImDeliveryOutcome => rejected('aborted', 'aborted', 'the send was aborted');

/** A delivery the room refuses from inside its transaction; nothing is written. */
class DeliveryRefused extends Error {
  readonly outcome: ImDeliveryOutcome;
  constructor(outcome: ImDeliveryOutcome) {
    super('delivery refused');
    this.outcome = outcome;
  }
}

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

const textLimit = (policy: ImDeliveryPolicy): number => policy.maxTextLength ?? TELEGRAM_MAX_TEXT_LENGTH;

export function createPlaygroundHost(options: PlaygroundHostOptions): ImHost {
  const { store, self } = options;
  const now = options.now ?? ((): Date => new Date());
  const { orm } = store;

  /**
   * The identity a room shows for the bot: a bot sender that belongs to this
   * room. It is resolved inside the publishing transaction on every send, not
   * cached, so a rollback or a retention prune can never leave a stale id
   * behind. Membership is what keeps a virtual identity alive through
   * retention, and `is_bot` keeps a participant who shares the bot's display
   * name from being taken for it.
   */
  const resolveSelfSender = (chatId: bigint, stamp: string): bigint => {
    const existing = orm
      .select({ id: senders.id })
      .from(senders)
      .innerJoin(roomParticipants, eq(roomParticipants.senderId, senders.id))
      .where(
        and(
          eq(roomParticipants.chatId, chatId),
          eq(senders.hostKind, 'playground'),
          eq(senders.isBot, true),
          eq(senders.displayName, self.displayName),
        ),
      )
      .limit(1)
      .get();
    if (existing !== undefined) {
      return existing.id;
    }
    const created = orm
      .insert(senders)
      .values({
        hostKind: 'playground',
        displayName: self.displayName,
        username: self.username ?? null,
        isBot: true,
        updatedAt: stamp,
      })
      .returning({ id: senders.id })
      .get();
    if (created === undefined) {
      throw new Error('senders insert returned no row');
    }
    orm.insert(roomParticipants).values({ chatId, senderId: created.id, joinedAt: stamp }).run();
    return created.id;
  };

  const resolveRoom = (conversationId: bigint): ResolvedRoom | null => {
    const row = orm
      .select({
        chatId: conversations.chatId,
        hostKind: chats.hostKind,
        nextSeq: rooms.nextSeq,
      })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .leftJoin(rooms, eq(rooms.chatId, conversations.chatId))
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      chatId: row.chatId,
      hostKind: row.hostKind,
      nextSeq: row.nextSeq ?? 1n,
    };
  };

  const deliveredAt = (stamp: string): number => Math.floor(new Date(stamp).getTime() / 1000);

  /** What one published room message carries. */
  type RoomMessageContent =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'image'; readonly caption: string | null; readonly pictures: readonly LocalAsset[] };

  /**
   * The ledger row of a send, or a thrown error when the row does not exist.
   * A delivery always starts from the row the caller reserved, never from the
   * request alone.
   */
  const reservedSend = (sendId: bigint): { conversationId: bigint; messageId: bigint | null } => {
    const ledger = orm
      .select({ conversationId: hostSends.conversationId, messageId: hostSends.messageId })
      .from(hostSends)
      .where(eq(hostSends.id, sendId))
      .limit(1)
      .get();
    if (ledger === undefined) {
      throw new Error(`send ${sendId} is not reserved`);
    }
    return ledger;
  };

  /**
   * The message a repeat of this send already published, if any.
   *
   * The ledger row is the delivery key: a send that published a message
   * returns that message instead of a second one, whatever its outcome state
   * says today.
   */
  const republishedMessage = (ledger: { messageId: bigint | null }): ImDeliveredMessage | undefined => {
    const messageId = ledger.messageId;
    if (messageId === null) {
      return undefined;
    }
    const published = orm
      .select({ receivedAt: messages.receivedAt, seq: messages.localSequenceNo })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .get();
    // The link is cleared when retention deletes the message, so a linked row
    // exists and, being a room message, carries its sequence.
    if (published?.seq === null || published?.seq === undefined) {
      throw new Error(`published message ${messageId} has no room sequence`);
    }
    return {
      partIndex: 0,
      messageId: published.seq,
      sentAtSeconds: deliveredAt(published.receivedAt),
    };
  };

  /**
   * The ledger row was reserved for one conversation. Publishing it anywhere
   * else would mark that conversation's send successful with a message it
   * never got, and this check outranks replay: a key must not report another
   * room's message as delivered here.
   */
  const ledgerRefusal = (
    request: ImDeliveryRequest,
    ledger: { readonly conversationId: bigint },
  ): ImDeliveryOutcome | undefined =>
    ledger.conversationId === request.target.conversation.id
      ? undefined
      : rejected('permanent', 'send_target_mismatch', `send ${request.sendId} was reserved for another conversation`);

  /**
   * Read-only checks every delivery must pass: room, reply target and size
   * limits. They run once before anything is written or copied, and again
   * inside the publishing transaction, so a refusal leaves no row, no file and
   * no staged picture behind.
   */
  const checkedRoom = (
    request: ImDeliveryRequest,
    shape: { readonly kind: 'text' | 'image'; readonly text: string | null; readonly caption: string | null },
  ): { readonly refusal: ImDeliveryOutcome } | CheckedRoom => {
    const room = resolveRoom(request.target.conversation.id);
    if (room === null) {
      return { refusal: rejected('permanent', 'conversation_not_found', 'the target conversation no longer exists') };
    }
    if (room.hostKind !== 'playground') {
      return {
        refusal: rejected('permanent', 'host_mismatch', `conversation host is "${room.hostKind}", not "playground"`),
      };
    }
    // A reply target is a sequence number of this very room: the room's own
    // message id, the one the model was shown. The row id stays internal, so a
    // number no message of this room carries is refused, never matched against
    // a row of any other room.
    const replySeq = request.replyToMessageId ?? null;
    const replyTo =
      replySeq === null
        ? null
        : (orm
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, request.target.conversation.id),
                eq(messages.chatId, room.chatId),
                eq(messages.hostKind, 'playground'),
                eq(messages.localSequenceNo, replySeq),
              ),
            )
            .limit(1)
            .get()?.id ?? null);
    if (replySeq !== null && replyTo === null) {
      return {
        refusal: rejected('permanent', 'reply_target_other_room', `message ${replySeq} is not in this room`),
      };
    }
    const limits = request.target.policy.delivery;
    if (shape.kind === 'text') {
      const text = shape.text ?? '';
      if (text.length === 0) {
        return { refusal: rejected('permanent', 'empty_text', 'a text delivery has no text to publish') };
      }
      if (text.length > textLimit(limits)) {
        return {
          refusal: rejected(
            'permanent',
            'text_too_long',
            `text length ${text.length} exceeds the room limit of ${textLimit(limits)}`,
          ),
        };
      }
      return { room, replyTo };
    }
    if (options.pictures === undefined) {
      return { refusal: rejected('permanent', 'unsupported_media', 'this room has no picture store') };
    }
    const caption = shape.caption ?? null;
    if (caption !== null && caption.length > limits.maxCaptionLength) {
      return {
        refusal: rejected(
          'permanent',
          'caption_too_long',
          `caption length ${caption.length} exceeds the room limit of ${limits.maxCaptionLength}`,
        ),
      };
    }
    return { room, replyTo };
  };

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
    const pictures = options.pictures;
    if (pictures === undefined) {
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
      await pictures.validate(input);
    }
    const assets: LocalAsset[] = [];
    const created: string[] = [];
    try {
      for (const input of inputs) {
        if (signal?.aborted === true) {
          throw new DeliveryRefused(abortedDelivery());
        }
        const asset = await pictures.ingest(chatId, input);
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
      await options.pictures?.discard(assetId);
    }
  };

  const publish = (request: ImDeliveryRequest, content: RoomMessageContent): ImDeliveredMessage => {
    const ledger = reservedSend(request.sendId);
    const mismatch = ledgerRefusal(request, ledger);
    if (mismatch !== undefined) {
      throw new DeliveryRefused(mismatch);
    }
    const republished = republishedMessage(ledger);
    if (republished !== undefined) {
      return republished;
    }
    const checked = checkedRoom(
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
    const { room, replyTo } = checked;
    const stamp = now().toISOString();
    const sequenceNo = room.nextSeq;

    const createdMessage = orm
      .insert(messages)
      .values({
        conversationId: request.target.conversation.id,
        chatId: room.chatId,
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
        senderId: resolveSelfSender(room.chatId, stamp),
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
            fileUniqueId: `local:${room.chatId.toString()}:${picture.sha256}`,
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
        options.pictures?.markAttached(picture.id, mediaRow.id);
      }
    }
    orm.update(messages).set({ currentRevisionId: revision.id }).where(eq(messages.id, createdMessage.id)).run();
    orm
      .update(rooms)
      .set({ nextSeq: sequenceNo + 1n, updatedAt: stamp })
      .where(eq(rooms.chatId, room.chatId))
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
    return { partIndex: 0, messageId: sequenceNo, sentAtSeconds: deliveredAt(stamp) };
  };

  const delivery: ImDelivery = {
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
        const ledger = reservedSend(request.sendId);
        const mismatch = ledgerRefusal(request, ledger);
        if (mismatch !== undefined) {
          return mismatch;
        }
        const republished = republishedMessage(ledger);
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
        const checked = checkedRoom(request, shape);
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

  const policy = (conversation: ImConversationRef): ImConversationPolicy =>
    resolveConversationPolicy({
      host: 'playground',
      scope: conversation.scope,
      sendRate: options.sendRate(),
    });

  /**
   * A room has no chat action to show. The UI reads the working state off the
   * invocation, so an entry here only exists to stop by itself if a run never
   * does; nothing polls it.
   */
  const activeUntil = new Map<string, number>();

  const prune = (at: number): void => {
    for (const [key, expiry] of activeUntil) {
      if (expiry <= at) {
        activeUntil.delete(key);
      }
    }
  };

  const activity: ImActivity = {
    start: (target: ImDeliveryTarget): void => {
      const at = now().getTime();
      prune(at);
      activeUntil.set(conversationKey(target.conversation), at + (target.policy.activity.capMs ?? 0));
    },
    stop: (conversation: ImConversationRef): void => {
      prune(now().getTime());
      activeUntil.delete(conversationKey(conversation));
    },
    stopAll: (): void => {
      activeUntil.clear();
    },
  };

  return { host: 'playground', policy, delivery, activity };
}
