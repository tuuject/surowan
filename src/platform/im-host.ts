/**
 * Host-neutral instant messaging contract.
 *
 * The *platform* (prompt rendering, tool schemas, tool argument parsing, tool
 * result and error copy) is host-neutral: it never sees a transport client.
 * This module is the whole vocabulary that crosses that seam. Everything a
 * transport needs in order to put one modelled message on the wire, and
 * everything the platform needs back from it, is expressed here as values.
 *
 * Three rules keep the boundary honest.
 *
 * 1. This is a leaf module: no IO, no storage, no clock, no configuration
 *    reads. Policy values arrive as arguments.
 * 2. No transport library type may appear in these signatures. Telegram is
 *    expressed as host kind + conversation policy + ordered delivery parts +
 *    a delivery-failure vocabulary. The mapping onto the Telegram API lives in
 *    `src/adapters/local-monolith/telegram-host.ts`, and only there.
 * 3. Internal identifiers and model-visible references are different things.
 *    Models never see a chat id or a raw transport user id; they see a rendered
 *    `SenderRef` or nothing at all. See {@link SenderRef}.
 *
 * Ownership of the model-facing surface, so later changes land on one side:
 *
 * - The platform owns prompt text, the message-envelope format, tool names,
 *   tool schemas, argument validation messages, and the copy returned to the
 *   model for a rejected send.
 * - The host owns delivery part order, transport limits, mention entity
 *   construction, retry classification, and activity cadence.
 */

/** Where a conversation physically lives. */
export type HostKind = 'telegram' | 'playground';

export const HOST_KINDS = ['telegram', 'playground'] as const satisfies readonly HostKind[];

/**
 * Whether a conversation is a one-to-one chat or a shared room. Scope, not
 * channel, because Telegram and the local playground disagree about almost
 * everything else but agree about this distinction.
 */
export type ConversationScope = 'private' | 'group';

declare const internalIdBrand: unique symbol;

type Branded<Kind extends string, Value> = Value & { readonly [internalIdBrand]: Kind };

/** Host-native chat identifier. Telegram: a decimal string, negative for groups. */
export type ChatId = Branded<'chat', string>;

/** Storage identifier of the resolved conversation row. */
export type ConversationId = Branded<'conversation', bigint>;

/** Host-native sender identifier. Telegram: the numeric user id. */
export type SenderId = Branded<'sender', bigint>;

export function toChatId(value: string): ChatId {
  return value as ChatId;
}

export function toConversationId(value: bigint): ConversationId {
  return value as ConversationId;
}

export function toSenderId(value: bigint): SenderId {
  return value as SenderId;
}

/**
 * A sender reference the model is allowed to see.
 *
 * Telegram exposes the numeric user id as `uid:<id>`. A host that scopes its
 * senders to a room may instead hand out an opaque per-room handle, and a host
 * that refuses to expose senders at all returns `null`, in which case the
 * platform renders the sender without a reference and the model cannot address
 * it. The rendering decision is policy, never a transport detail, so the same
 * prompt shape works for both hosts.
 */
export type SenderRef = string | null;

/** How a host renders a sender for the model. */
export type SenderRefStyle = 'uid' | 'opaque' | 'none';

export function renderSenderRef(style: SenderRefStyle, id: SenderId): SenderRef {
  switch (style) {
    case 'uid':
      return `uid:${id.toString()}`;
    case 'opaque':
      return `s${id.toString()}`;
    case 'none':
      return null;
  }
}

/** One participant of one conversation, as the platform needs it. */
export interface ImSender {
  /** Internal. Never rendered into a prompt. */
  readonly id: SenderId;
  readonly displayName: string;
  readonly username: string | null;
  /** Internal. The host's own database row for this participant, when it has one. */
  readonly rowId?: bigint;
}

/** One conversation, resolved by the server and bound to its host. */
export interface ImConversationRef {
  readonly host: HostKind;
  /** Internal. Never rendered into a prompt. */
  readonly id: ConversationId;
  /** Internal. Never rendered into a prompt. */
  readonly chatId: ChatId;
  /** Host-side sub-conversation (a Telegram forum topic). `null` for the whole chat. */
  readonly topicId: number | null;
  readonly scope: ConversationScope;
}

export function sameConversation(left: ImConversationRef, right: ImConversationRef): boolean {
  return (
    left.host === right.host &&
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.topicId === right.topicId
  );
}

/**
 * The scope a delivery or activity call acts on, as an opaque key. Used for
 * per-target bookkeeping (rate windows, activity loops) that must not depend on
 * a transport's own notion of a target.
 */
export function conversationKey(conversation: ImConversationRef): string {
  return `${conversation.host}:${conversation.chatId}:${conversation.topicId ?? '0'}`;
}

/* -------------------------------------------------------------------------- */
/* Conversation policy                                                        */
/* -------------------------------------------------------------------------- */

/** How a reply reference reaches the wire. */
export type ReplyDelivery = 'inline' | 'unsupported';

/** How a clickable mention reaches the wire. */
export type MentionDelivery = 'entity' | 'plain';

export type ActivityKind = 'typing' | 'none';

export interface ImDeliveryPolicy {
  readonly reply: ReplyDelivery;
  readonly mention: MentionDelivery;
  /** Upper bound for one text part, in UTF-16 code units. */
  readonly maxTextLength: number;
  /** Upper bound for one media caption, in UTF-16 code units. */
  readonly maxCaptionLength: number;
  /** Whether several generated pictures may be published as one album part. */
  readonly albums: boolean;
}

export interface ImActivityPolicy {
  readonly kind: ActivityKind;
  /** How often the indicator must be refreshed while work continues. `null` when inert. */
  readonly refreshMs: number | null;
  /** How long one activity round may live before the host stops it on its own. */
  readonly capMs: number | null;
}

export interface ImSendRatePolicy {
  readonly sendsPerWindow: number;
  readonly windowSeconds: number;
}

/**
 * Behaviour that belongs to a conversation, not to a caller. A delivery or
 * activity call is only meaningful together with the policy it was resolved
 * under, which is why {@link ImDeliveryTarget} pairs the two.
 */
export interface ImConversationPolicy {
  readonly delivery: ImDeliveryPolicy;
  readonly activity: ImActivityPolicy;
  readonly sendRate: ImSendRatePolicy;
  readonly senderRef: SenderRefStyle;
}

/** Everything a bound delivery or activity call acts on. */
export interface ImDeliveryTarget {
  readonly conversation: ImConversationRef;
  readonly policy: ImConversationPolicy;
}

/** Telegram retains a chat action for up to five seconds. */
export const TELEGRAM_ACTIVITY_REFRESH_MS = 4_000;
/** Leave the five-second tail inside the cap. */
export const TELEGRAM_ACTIVITY_CAP_MS = 55_000;
export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1_024;

export interface ConversationPolicyInput {
  readonly host: HostKind;
  readonly scope: ConversationScope;
  readonly sendRate: ImSendRatePolicy;
}

/**
 * The pinned behaviour of each host. Pure: the same input always produces the
 * same policy, so the contract tests can freeze it and so a caller can compare
 * two conversations without touching a transport.
 */
export function resolveConversationPolicy(input: ConversationPolicyInput): ImConversationPolicy {
  switch (input.host) {
    case 'telegram':
      return {
        delivery: {
          reply: 'inline',
          mention: 'entity',
          maxTextLength: TELEGRAM_MAX_TEXT_LENGTH,
          maxCaptionLength: TELEGRAM_MAX_CAPTION_LENGTH,
          albums: true,
        },
        activity: {
          kind: input.scope === 'group' ? 'typing' : 'none',
          refreshMs: input.scope === 'group' ? TELEGRAM_ACTIVITY_REFRESH_MS : null,
          capMs: input.scope === 'group' ? TELEGRAM_ACTIVITY_CAP_MS : null,
        },
        sendRate: input.sendRate,
        senderRef: 'uid',
      };
    case 'playground':
      return {
        delivery: {
          reply: 'inline',
          mention: 'plain',
          maxTextLength: TELEGRAM_MAX_TEXT_LENGTH,
          maxCaptionLength: TELEGRAM_MAX_CAPTION_LENGTH,
          albums: true,
        },
        activity: {
          kind: 'typing',
          refreshMs: TELEGRAM_ACTIVITY_REFRESH_MS,
          capMs: TELEGRAM_ACTIVITY_CAP_MS,
        },
        sendRate: input.sendRate,
        senderRef: input.scope === 'group' ? 'opaque' : 'uid',
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImTextPart {
  readonly kind: 'text';
  readonly text: string;
  /**
   * Sender to resolve as a clickable mention in this text. The host, not the
   * caller, decides what that means on the wire.
   */
  readonly mention?: SenderId;
}

export interface ImStickerPart {
  readonly kind: 'sticker';
  readonly stickerSet: string;
  readonly stickerRef: string;
}

export interface ImPhotoPart {
  readonly kind: 'photo';
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly caption?: string;
}

export interface ImPhotoAlbumPart {
  readonly kind: 'photo_album';
  readonly pictures: readonly { readonly bytes: Uint8Array; readonly fileName: string }[];
  readonly caption?: string;
}

export type ImOutgoingPart = ImTextPart | ImStickerPart | ImPhotoPart | ImPhotoAlbumPart;

export interface ImDeliveryRequest {
  readonly target: ImDeliveryTarget;
  readonly parts: readonly ImOutgoingPart[];
  /**
   * Host-native message the first part replies to, already resolved by the
   * server. Never a model-supplied string.
   */
  readonly replyToMessageId?: bigint;
  readonly signal: AbortSignal;
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
  /** Present for `rate_limited` when the host states a delay. */
  readonly retryAfterSeconds?: number;
  /** Host-supplied description, for logs. Never shown to the model verbatim. */
  readonly description: string;
}

/** One host message produced by one part of the request. */
export interface ImDeliveredMessage {
  readonly partIndex: number;
  /** Internal. Never rendered into a prompt; the model sees a message ref. */
  readonly messageId: bigint;
}

export type ImDeliveryOutcome =
  | { readonly kind: 'delivered'; readonly messages: readonly ImDeliveredMessage[] }
  | { readonly kind: 'rejected'; readonly failure: ImDeliveryFailure };

/** A rejected delivery that a caller may legitimately retry. */
export function isRetryableFailure(failure: ImDeliveryFailure): boolean {
  return failure.reason === 'rate_limited' || failure.reason === 'transient' || failure.reason === 'network';
}

export interface ImDelivery {
  /**
   * Publishes every part in order. A rejection reports the first part that did
   * not go out; already-published parts stay published, and the host must not
   * undo them.
   */
  deliver(request: ImDeliveryRequest): Promise<ImDeliveryOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImActivity {
  /**
   * Shows the "working" indicator for one conversation and keeps it fresh.
   * Idempotent per conversation while a round is live; cosmetic failures are
   * swallowed by the host.
   */
  start(target: ImDeliveryTarget): void;
  /** Clears the indicator for one conversation. Safe when nothing is running. */
  stop(conversation: ImConversationRef): void;
  /** Clears every indicator this instance owns. */
  stopAll(): void;
}

/**
 * The transport seam. One instance per host kind; a caller resolves a
 * conversation through the server and then holds only this interface.
 */
export interface ImHost {
  readonly host: HostKind;
  /** Resolved policy for one conversation. Pure. */
  policy(conversation: ImConversationRef): ImConversationPolicy;
  readonly delivery: ImDelivery;
  readonly activity: ImActivity;
}