import type { SenderId } from './identity.ts';
import type { ImDeliveryPolicy, ImDeliveryTarget } from './policy.ts';

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImTextPart {
  readonly kind: 'text';
  readonly text: string;
  /**
   * Markup the model asked for. Neutral on purpose: the platform knows that
   * `markdown_v2` exists, the host knows what it means on the wire.
   */
  readonly markup?: 'markdown_v2';
  /**
   * Sender to resolve as a clickable mention at the head of this text. The
   * host, not the caller, decides how that reaches the wire, and it is the host
   * that knows how long the rendered prefix turned out to be.
   */
  readonly mention?: ImMentionRequest;
}

export interface ImMentionRequest {
  readonly senderId: SenderId;
  readonly displayName: string;
}

export interface ImStickerPart {
  readonly kind: 'sticker';
  /** Host sticker reference the server already authorized. */
  readonly stickerRef: string;
}

export interface ImPhotoPart {
  readonly kind: 'photo';
  readonly bytes: Uint8Array;
  readonly fileName: string;
  /**
   * The producing side's media type (`image/png`, …). A host that stores the
   * bytes itself needs it to type the stored media; a host that uploads them
   * to a wire re-derives the type from the payload.
   */
  readonly mime?: string;
  readonly caption?: string;
}

export interface ImPhotoAlbumPart {
  readonly kind: 'photo_album';
  readonly pictures: readonly { readonly bytes: Uint8Array; readonly fileName: string; readonly mime?: string }[];
  readonly caption?: string;
}

export type ImOutgoingPart = ImTextPart | ImStickerPart | ImPhotoPart | ImPhotoAlbumPart;

export interface ImDeliveryRequest {
  readonly target: ImDeliveryTarget;
  readonly parts: readonly ImOutgoingPart[];
  /**
   * The send-ledger row this delivery is recorded against, already reserved by
   * the caller before the request was built.
   *
   * A host that publishes messages of its own keys delivery on it, so a repeat
   * of the same row publishes nothing new; a host that only talks to a wire
   * ignores it and lets the caller finalize the ledger.
   */
  readonly sendId: bigint;
  /**
   * Host-native id of the message the first part replies to: the id the model
   * was shown (a Telegram message id, a room sequence number), already
   * authorized by the server against the conversation context. The host
   * resolves it inside the target conversation; it is never a storage row id.
   */
  readonly replyToMessageId?: bigint;
  readonly signal: AbortSignal | undefined;
}

/**
 * Why a delivery did not happen. Callers branch on `reason`, never on a
 * transport's own error code, so a new host only has to fill this vocabulary in.
 */
export type ImDeliveryFailureReason =
  | 'rate_limited'
  | 'transient'
  | 'permanent'
  | 'network'
  | 'aborted'
  | 'unsupported';

export interface ImDeliveryFailure {
  readonly reason: ImDeliveryFailureReason;
  /** Stable operator-facing code for the audit trail, e.g. `telegram_429`. */
  readonly code: string;
  /**
   * True when the request may have reached the host before failing, so the
   * caller must treat the outcome as unknown rather than as "not sent".
   * Retrying an unknown outcome is a user decision, not a retry policy.
   */
  readonly outcomeUnknown: boolean;
  /** Present for `rate_limited` when the host states a delay. */
  readonly retryAfterSeconds?: number;
  /** Host-supplied description. Host-reported rejections show it to the model so it can correct the send. */
  readonly description: string;
}

/** One host message produced by one part of the request. */
export interface ImDeliveredMessage {
  readonly partIndex: number;
  /**
   * Host-native id of the published message (a Telegram message id, a room
   * sequence number): the id the model is told, and may reply to later. Never
   * a storage row id.
   */
  readonly messageId: bigint;
  /** When the host accepted the message, in Unix seconds. */
  readonly sentAtSeconds: number;
  /** Largest picture of this message, when it carried one. */
  readonly photo?: ImDeliveredPhoto;
}

export interface ImDeliveredPhoto {
  /** Host file reference, for redelivering or editing the picture later. */
  readonly fileRef: string;
  /** Host file identity, stable across references. */
  readonly fileUniqueRef: string;
  readonly width: number;
  readonly height: number;
}

export type ImDeliveryOutcome =
  | {
      readonly kind: 'delivered';
      readonly messages: readonly ImDeliveredMessage[];
      /**
       * True when the host published these messages *and* recorded the delivery
       * itself, in one transaction, so the caller must not write it again.
       *
       * A host with a wire can only report what it accepted; the caller then
       * mirrors the accepted messages and finalizes the ledger. A virtual host
       * has nothing to report from - it owns both writes - so it sets this and
       * the caller only updates its own tool-call record.
       */
      readonly recordedByHost: boolean;
    }
  | { readonly kind: 'rejected'; readonly failure: ImDeliveryFailure };

/**
 * A rejected delivery that a caller may legitimately retry. An unknown outcome
 * never is, whatever its reason: the message may already be out, and sending
 * it again would publish it twice.
 */
export function isRetryableFailure(failure: ImDeliveryFailure): boolean {
  if (failure.outcomeUnknown) {
    return false;
  }
  return failure.reason === 'rate_limited' || failure.reason === 'transient' || failure.reason === 'network';
}

export interface ImDelivery {
  /**
   * Pure preview of what one part will carry once the host has shaped it,
   * including any mention prefix. The platform validates against this rather
   * than against the model's raw text, so a host that renders a long mention
   * cannot smuggle an oversized message past the size limits.
   *
   * `text` is `null` for parts that carry no text or caption.
   */
  compose(part: ImOutgoingPart, policy: ImDeliveryPolicy): ImComposedPart;
  /**
   * Publishes every part in order. A rejection reports the first part that did
   * not go out; already-published parts stay published, and the host must not
   * undo them.
   */
  deliver(request: ImDeliveryRequest): Promise<ImDeliveryOutcome>;
  /**
   * Whether `deliver` may publish into a conversation other than the one its
   * caller belongs to. Telegram allows a reply into another topic, which is a
   * different conversation row; a virtual room is bound to exactly one
   * conversation, so a target from a neighbouring room must be rejected rather
   * than trusted.
   */
  readonly crossConversationTargets: boolean;
}

export interface ImComposedPart {
  readonly text: string | null;
  readonly markup: 'markdown_v2' | null;
}
