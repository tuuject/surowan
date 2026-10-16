/**
 * The virtual host of a Bot Playground room.
 *
 * A room has no wire, so this host has nothing to translate and nothing to
 * send. What it does own is the other half of a delivery: publishing the
 * message the bot produced - the message row, its first revision and the local
 * arrival order - and recording the send that produced it, in one transaction
 * keyed by the send ledger row.
 *
 * Everything a Telegram host reports from the wire (`sentAtSeconds`, a host
 * message id) is therefore decided here instead, which is why the caller does
 * not mirror or finalize anything this host accepted.
 */
import { and, eq } from 'drizzle-orm';
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
  messageRevisions,
  messages,
  rooms,
  senders,
} from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';

/** Who a room shows as the author of the messages the bot publishes. */
export interface PlaygroundSelfIdentity {
  readonly displayName: string;
  readonly username?: string | null;
}

export interface PlaygroundHostOptions {
  /** The store a delivery writes through. Also supplies the transaction. */
  readonly store: BusinessStore;
  readonly self: PlaygroundSelfIdentity;
  /** Resolved per call: it is pure, and the configured rate can change. */
  readonly sendRate: () => ImSendRatePolicy;
  readonly now?: () => Date;
}

/** The room a delivery targets, with the counters it must advance. */
interface ResolvedRoom {
  readonly chatId: bigint;
  readonly hostKind: string;
  readonly revision: bigint;
  readonly nextSeq: bigint;
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

/**
 * A mention is plain text in a room, and there is no markup dialect to render
 * into, so composing a part only bounds it.
 */
const composePlaygroundPart = (part: ImOutgoingPart, policy: ImDeliveryPolicy): ImComposedPart => {
  if (part.kind !== 'text') {
    return { text: null, markup: null };
  }
  const limit = policy.maxTextLength ?? TELEGRAM_MAX_TEXT_LENGTH;
  return {
    text: part.text.length > limit ? part.text.slice(0, limit) : part.text,
    markup: null,
  };
};

export function createPlaygroundHost(options: PlaygroundHostOptions): ImHost {
  const { store, self } = options;
  const now = options.now ?? ((): Date => new Date());
  const { orm } = store;

  /** The identity row a room shows for the bot, created once and reused. */
  let selfSenderId: bigint | null = null;

  const resolveSelfSender = (): bigint | null => {
    if (selfSenderId !== null) {
      return selfSenderId;
    }
    const existing = orm
      .select({ id: senders.id })
      .from(senders)
      .where(and(eq(senders.hostKind, 'playground'), eq(senders.displayName, self.displayName)))
      .limit(1)
      .get();
    if (existing !== undefined) {
      selfSenderId = existing.id;
      return selfSenderId;
    }
    const created = orm
      .insert(senders)
      .values({
        hostKind: 'playground',
        displayName: self.displayName,
        username: self.username ?? null,
        isBot: true,
        updatedAt: now().toISOString(),
      })
      .returning({ id: senders.id })
      .get();
    selfSenderId = created?.id ?? null;
    return selfSenderId;
  };

  const resolveRoom = (conversationId: bigint): ResolvedRoom | null => {
    const row = orm
      .select({
        chatId: conversations.chatId,
        hostKind: chats.hostKind,
        revision: rooms.revision,
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
      revision: row.revision ?? 0n,
      nextSeq: row.nextSeq ?? 1n,
    };
  };

  const deliveredAt = (stamp: string): number => Math.floor(new Date(stamp).getTime() / 1000);

  const publish = (request: ImDeliveryRequest, body: string): ImDeliveredMessage => {
    const ledger = orm
      .select({ messageId: hostSends.messageId, state: hostSends.state })
      .from(hostSends)
      .where(eq(hostSends.id, request.sendId))
      .limit(1)
      .get();
    if (ledger === undefined) {
      throw new Error(`send ${request.sendId} is not reserved`);
    }
    // The ledger row is the delivery key. A repeat of a send that already
    // published a message returns that message instead of a second one.
    if (ledger.messageId !== null && ledger.messageId !== undefined) {
      const published = orm
        .select({ receivedAt: messages.receivedAt })
        .from(messages)
        .where(eq(messages.id, ledger.messageId))
        .limit(1)
        .get();
      return {
        partIndex: 0,
        messageId: ledger.messageId,
        sentAtSeconds: deliveredAt(published?.receivedAt ?? now().toISOString()),
      };
    }

    // Read the counters inside the caller's transaction: they are a
    // read-modify-write pair, so resolving them beforehand could lose an
    // update from a send that committed in between.
    const room = resolveRoom(request.target.conversation.id);
    if (room === null) {
      throw new Error('the target conversation disappeared');
    }
    const stamp = now().toISOString();
    const replyToMessageId = request.replyToMessageId ?? null;
    const sequenceNo = room.nextSeq;
    const revisionNo = room.revision + 1n;

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
        localReplyToMessageId: replyToMessageId,
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
        revisionNo,
        senderId: resolveSelfSender(),
        kind: 'text',
        text: body,
        replyToMessageId,
        createdAt: stamp,
        rawFragmentJson: '{}',
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('message_revisions insert returned no row');
    }
    orm
      .update(messages)
      .set({ currentRevisionId: revision.id })
      .where(eq(messages.id, createdMessage.id))
      .run();
    orm
      .update(rooms)
      .set({ revision: revisionNo, nextSeq: sequenceNo + 1n, updatedAt: stamp })
      .where(eq(rooms.chatId, room.chatId))
      .run();
    orm
      .update(hostSends)
      .set({
        state: 'success',
        messageId: createdMessage.id,
        responseJson: JSON.stringify({ message_id: createdMessage.id.toString() }),
        finishedAt: stamp,
      })
      .where(eq(hostSends.id, request.sendId))
      .run();
    return { partIndex: 0, messageId: createdMessage.id, sentAtSeconds: deliveredAt(stamp) };
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
      if (part.kind !== 'text') {
        // A room has nowhere to put wire media yet, and a message that claims
        // to have carried an attachment would be worse than a clear refusal.
        return rejected(
          'permanent',
          'unsupported_media',
          `a Bot Playground room cannot show a ${part.kind} message`,
        );
      }
      const targetRoom = resolveRoom(request.target.conversation.id);
      if (targetRoom === null) {
        return rejected('permanent', 'conversation_not_found', 'the target conversation no longer exists');
      }
      if (targetRoom.hostKind !== 'playground') {
        return rejected(
          'permanent',
          'host_mismatch',
          `conversation host is "${targetRoom.hostKind}", not "playground"`,
        );
      }
      const composed = composePlaygroundPart(part, request.target.policy.delivery);
      const body = composed.text ?? '';
      if (body.length === 0) {
        return rejected('permanent', 'empty_text', 'a text delivery has no text to publish');
      }
      try {
        const published = store.transaction(() => publish(request, body));
        return { kind: 'delivered', messages: [published], recordedByHost: true };
      } catch (error) {
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