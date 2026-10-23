/**
 * The read-only half of a Bot Playground delivery.
 *
 * Everything here answers a question about the room, the send ledger or the
 * reply target before anything is written: `checkedRoom` refuses a delivery
 * that no row, file or staged picture should exist for, and the ledger readers
 * say what a send already published. None of it caches a row across calls,
 * because every caller runs inside the publishing transaction.
 */
import { and, eq } from 'drizzle-orm';
import {
  type ImDeliveredMessage,
  type ImDeliveryFailureReason,
  type ImDeliveryOutcome,
  type ImDeliveryPolicy,
  type ImDeliveryRequest,
  TELEGRAM_MAX_TEXT_LENGTH,
} from '../../platform/im-host.ts';
import { chats, conversations, hostSends, messages, roomParticipants, rooms, senders } from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { PlaygroundPictures, PlaygroundSelfIdentity } from './playground-host.ts';

/** The room a delivery targets, with the counter it must advance. */
export interface ResolvedRoom {
  readonly chatId: bigint;
  readonly hostKind: string;
  readonly nextSeq: bigint;
}

/** A room that passed every read-only check, with the stored row its reply names. */
export interface CheckedRoom {
  readonly room: ResolvedRoom;
  readonly replyTo: bigint | null;
}

/** A refusal always names why, so a room can show it instead of a blank turn. */
export const rejected = (
  reason: ImDeliveryFailureReason,
  code: string,
  description: string,
  outcomeUnknown = false,
): ImDeliveryOutcome => ({
  kind: 'rejected',
  failure: { reason, code, description, outcomeUnknown },
});

/** A cancelled run's send: nothing reached the room, so the outcome is known. */
export const abortedDelivery = (): ImDeliveryOutcome => rejected('aborted', 'aborted', 'the send was aborted');

/** A delivery the room refuses from inside its transaction; nothing is written. */
export class DeliveryRefused extends Error {
  readonly outcome: ImDeliveryOutcome;
  constructor(outcome: ImDeliveryOutcome) {
    super('delivery refused');
    this.outcome = outcome;
  }
}

const textLimit = (policy: ImDeliveryPolicy): number => policy.maxTextLength ?? TELEGRAM_MAX_TEXT_LENGTH;

/** The live objects a room reader reads through; never a copy of them. */
export interface PlaygroundRoomDeps {
  readonly store: BusinessStore;
  readonly self: PlaygroundSelfIdentity;
  readonly pictures: PlaygroundPictures | undefined;
}

export interface RoomReaders {
  /**
   * The identity a room shows for the bot: a bot sender that belongs to this
   * room. It is resolved inside the publishing transaction on every send, not
   * cached, so a rollback or a retention prune can never leave a stale id
   * behind. Membership is what keeps a virtual identity alive through
   * retention, and `is_bot` keeps a participant who shares the bot's display
   * name from being taken for it.
   */
  resolveSelfSender(chatId: bigint, stamp: string): bigint;
  resolveRoom(conversationId: bigint): ResolvedRoom | null;
  deliveredAt(stamp: string): number;
  /**
   * The ledger row of a send, or a thrown error when the row does not exist.
   * A delivery always starts from the row the caller reserved, never from the
   * request alone.
   */
  reservedSend(sendId: bigint): { conversationId: bigint; messageId: bigint | null };
  /**
   * The message a repeat of this send already published, if any.
   *
   * The ledger row is the delivery key: a send that published a message
   * returns that message instead of a second one, whatever its outcome state
   * says today.
   */
  republishedMessage(ledger: { messageId: bigint | null }): ImDeliveredMessage | undefined;
  /**
   * The ledger row was reserved for one conversation. Publishing it anywhere
   * else would mark that conversation's send successful with a message it
   * never got, and this check outranks replay: a key must not report another
   * room's message as delivered here.
   */
  ledgerRefusal(request: ImDeliveryRequest, ledger: { readonly conversationId: bigint }): ImDeliveryOutcome | undefined;
  /**
   * Read-only checks every delivery must pass: room, reply target and size
   * limits. They run once before anything is written or copied, and again
   * inside the publishing transaction, so a refusal leaves no row, no file and
   * no staged picture behind.
   */
  checkedRoom(
    request: ImDeliveryRequest,
    shape: { readonly kind: 'text' | 'image'; readonly text: string | null; readonly caption: string | null },
  ): { readonly refusal: ImDeliveryOutcome } | CheckedRoom;
}

export function createRoomReaders(deps: PlaygroundRoomDeps): RoomReaders {
  const { store, self, pictures } = deps;
  const { orm } = store;

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

  const ledgerRefusal = (
    request: ImDeliveryRequest,
    ledger: { readonly conversationId: bigint },
  ): ImDeliveryOutcome | undefined =>
    ledger.conversationId === request.target.conversation.id
      ? undefined
      : rejected('permanent', 'send_target_mismatch', `send ${request.sendId} was reserved for another conversation`);

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
    if (pictures === undefined) {
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

  return { resolveSelfSender, resolveRoom, deliveredAt, reservedSend, republishedMessage, ledgerRefusal, checkedRoom };
}
