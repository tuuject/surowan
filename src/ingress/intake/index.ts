/**
 * The host-neutral inbound contract. A host edge normalizes one platform
 * message into `InboundMessage` — internal chat id, thread, message number,
 * sender, source category, body, reply and media descriptors, the raw
 * fragment, and the cues it already extracted — and hands it to this path,
 * which owns everything after: sender / conversation / message / revision /
 * media writes, the `eligibleHuman` decision, the participation gate and the
 * Bucket append. No transport type appears here, so a test (or another host)
 * can drive the whole path with hand-built messages.
 */

import { hostIntakeSettings } from '../../platform/config/index.ts';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import type { MessageCues } from '../../platform/im-host/cues.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { evaluateParticipation, ParticipationRegistry } from '../../store/participation.ts';
import type { BusinessStore } from '../../store/store.ts';
import { appendToBucket, type IntakeDeps } from './buckets.ts';
import { storeInbound } from './messages.ts';

/** Who authored the message, as the host reports it. */
export interface InboundSender {
  /** `sender_chat` for a chat identity, `user` for an account. */
  readonly type: 'user' | 'sender_chat';
  /** The host's own sender id (a Telegram user/chat id, a room member id). */
  readonly id: bigint;
  readonly displayName: string;
  readonly username: string | null;
  readonly isBot: boolean;
}

/** One media attachment, already normalized to a storable descriptor. */
export interface InboundMedia {
  readonly kind: 'photo' | 'document' | 'sticker';
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
  /** The host's raw attachment JSON; stored as `media.telegram_json`. */
  readonly rawJson: string;
}

/**
 * One platform message an adapter normalized into storage shape. Everything
 * here is host data the edge already resolved — no transport object and no
 * delivery envelope — so the write path below stays the same whatever host
 * produced the message.
 */
export interface InboundMessage {
  /** The host this message arrived on; stored rows carry it verbatim. */
  readonly host: HostKind;
  /** Internal `chats.id`; the edge's admission already resolved and allowed it. */
  readonly internalChatId: bigint;
  /** The host's own chat id, for participation rules and log fields. */
  readonly hostChatId: bigint;
  /** `chat.type` the participation rule compiles against (`private` never gates). */
  readonly chatType: string;
  /** The conversation thread the message belongs to; `0` when it has none. */
  readonly threadId: bigint;
  /**
   * The host's own message number (`messages.message_no`): positive, unique
   * across the whole chat (`internalChatId`) — not only within a thread — and
   * stable across edits, since storage keys a message on `(chat_id,
   * message_no)`. An adapter whose platform numbers messages per thread must
   * map them to chat-wide numbers before calling intake, or a distinct
   * message collides with another thread's and an edit attaches to the wrong
   * message.
   */
  readonly messageNo: bigint;
  readonly sentAt: Date;
  readonly receivedAt: Date;
  /**
   * True when the delivery edits an earlier message: revisions still append,
   * but the delivery never opens a bucket or refreshes an attention window,
   * and its cues are the empty set.
   */
  readonly edited: boolean;
  readonly cues: MessageCues;
  /** The effective author (`sender_chat` wins), or `null` when there is none. */
  readonly sender: InboundSender | null;
  /**
   * The sending account's host id (`from.id` on Telegram) for the bot's
   * own-message drop; `null` when the delivery names no account.
   */
  readonly fromUserId: bigint | null;
  /** A service notice: stored, but never an eligible human trigger. */
  readonly service: boolean;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  /** The host message number this one replies to, after ignored-user filtering. */
  readonly replyToMessageNo: bigint | null;
  readonly replySnapshotJson: string | null;
  readonly forwardOriginJson: string | null;
  readonly mediaGroupId: string | null;
  readonly media: readonly InboundMedia[];
  /** The host's raw message fragment, stored on the revision for later reads. */
  readonly rawFragmentJson: string;
}

/** What the intake reports back; an adapter adds its own edge results. */
export interface IntakeResult {
  readonly messageId?: bigint;
  readonly bucketId?: bigint;
  /**
   * Set when a live eligible message carrying an ask or mention cue joined a
   * bucket, so the host can show typing before the bucket window closes.
   */
  readonly mention?: {
    readonly hostKind: HostKind;
    readonly hostChatId: bigint;
    readonly internalChatId: bigint;
    readonly threadId: bigint;
  };
}

/**
 * The host-neutral intake path: one `InboundMessage` is stored, gated and
 * appended to its bucket inside one synchronous transaction — the boundary an
 * Update always had. The store's transactions nest as savepoints, so a host
 * edge may run its own admission work in a wider transaction and the delivery
 * still lands or rolls back as one unit.
 */
export class InboundIntake {
  readonly #deps: IntakeDeps;
  readonly #participation: ParticipationRegistry;

  constructor(store: BusinessStore, configStore: RuntimeConfigurationStore, botId: bigint) {
    this.#deps = { store, configStore, botId };
    this.#participation = new ParticipationRegistry(configStore);
  }

  /** A live delivery: store, gate, then schedule bucket work. */
  ingest(message: InboundMessage): IntakeResult {
    return this.#deps.store.transaction(() => this.#route(message, true));
  }

  /** A replayed delivery: store and gate, but never open a realtime bucket. */
  ingestCatchUp(message: InboundMessage): IntakeResult {
    return this.#deps.store.transaction(() => this.#route(message, false));
  }

  #route(message: InboundMessage, schedule: boolean): IntakeResult {
    // This path only exists for bucket-intake hosts; a release host's intake
    // must never reach the writes below, let alone open a collecting bucket.
    if (hostExecutionProfile(message.host).intake !== 'bucket') {
      throw new Error(`inbound intake serves a bucket-intake host, got '${message.host}'`);
    }
    const stored = storeInbound(this.#deps, message);
    if (stored === undefined) {
      return {};
    }
    let bucketId: bigint | undefined;
    let mentioned = false;
    if (!message.edited) {
      // The window is refreshed even during catch-up, so a mention that
      // arrived while the process was down still leaves the chat awake.
      const rule = this.#participation.ruleFor(
        this.#deps.store.orm,
        { hostKind: message.host, hostChatId: message.hostChatId },
        message.chatType,
      );
      const decision = evaluateParticipation({
        orm: this.#deps.store.orm,
        rule,
        chatId: message.internalChatId,
        hostChatId: message.hostChatId,
        conversationId: stored.conversationId,
        cues: message.cues,
        messageNo: message.messageNo,
        receivedAt: message.receivedAt,
        eligibleHuman: stored.eligibleHuman,
      });
      if (schedule && (!rule?.askOnly || decision.bucketCreationAllowed)) {
        bucketId = appendToBucket(this.#deps, message, stored, decision.bucketCreationAllowed, rule?.askOnly === true);
      }
      mentioned =
        bucketId !== undefined &&
        stored.eligibleHuman &&
        hostIntakeSettings(this.#deps.configStore.current().config, message.host).mention_typing_enabled !== false &&
        (message.cues.asksBot || message.cues.mentionsBot);
    }
    return {
      messageId: stored.id,
      ...(bucketId === undefined ? {} : { bucketId }),
      ...(mentioned
        ? {
            mention: {
              hostKind: message.host,
              hostChatId: message.hostChatId,
              internalChatId: message.internalChatId,
              threadId: message.threadId,
            },
          }
        : {}),
    };
  }
}
