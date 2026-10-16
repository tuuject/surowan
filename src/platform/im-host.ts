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

/**
 * A conversation assembled from invocation identity alone.
 *
 * Only for call paths that never reach a transport - replaying a retained
 * scene, or validating tools from the doctor - where a well-formed ref is all
 * that is needed. A real delivery must use a ref the server resolved from
 * storage, so that a group and a private chat with the same id cannot be
 * confused.
 */
export function identityConversation(
  target: { readonly chatId: bigint; readonly threadId: bigint; readonly conversationId: bigint },
  host: HostKind,
  scope: ConversationScope,
): ImConversationRef {
  return {
    host,
    id: toConversationId(target.conversationId),
    chatId: toChatId(target.chatId.toString()),
    topicId: target.threadId === 0n ? null : Number(target.threadId),
    scope,
  };
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
/**
 * A virtual room has no wire to refresh, so its working indicator is only
 * local state. It expires on its own rather than being retried, long enough
 * for a normal run and short enough that a wedged one does not hang around.
 */
export const PLAYGROUND_ACTIVITY_CAP_MS = 600_000;

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
          // Telegram shows a chat action in private chats too, and the model's
          // own `typing` call has always been available there.
          kind: 'typing',
          refreshMs: TELEGRAM_ACTIVITY_REFRESH_MS,
          capMs: TELEGRAM_ACTIVITY_CAP_MS,
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
          // Nothing leaves the machine, so there is no chat action to refresh
          // from: the room UI reads the working state off the invocation. A
          // local entry only needs to stop by itself if the run never does.
          kind: 'none',
          refreshMs: null,
          capMs: PLAYGROUND_ACTIVITY_CAP_MS,
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
   * The send-ledger row this delivery is recorded against, already reserved by
   * the caller before the request was built.
   *
   * A host that publishes messages of its own keys delivery on it, so a repeat
   * of the same row publishes nothing new; a host that only talks to a wire
   * ignores it and lets the caller finalize the ledger.
   */
  readonly sendId: bigint;
  /**
   * Host-native message the first part replies to, already resolved by the
   * server. Never a model-supplied string.
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
  /** Internal. Never rendered into a prompt; the model sees a message ref. */
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

/** A rejected delivery that a caller may legitimately retry. */
export function isRetryableFailure(failure: ImDeliveryFailure): boolean {
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

/**
 * A host that carries nothing. Used where the platform must be able to build
 * its tools but must never reach a transport, such as replaying a retained
 * scene. It refuses every delivery and ignores every activity, rather than
 * throwing, so a stray call fails at the send audit - where it is visible -
 * instead of in the middle of message rendering.
 */
export function unwiredImHost(host: HostKind, reason: string): ImHost {
  const policy = (conversation: ImConversationRef): ImConversationPolicy =>
    resolveConversationPolicy({ host, scope: conversation.scope, sendRate: { sendsPerWindow: 1, windowSeconds: 1 } });
  return {
    host,
    policy,
    delivery: {
      // It never delivers anywhere, so no target is ever in scope.
      crossConversationTargets: false,
      // There is no wire to shape for, so the part is previewed as it stands.
      compose: (part) =>
        part.kind === 'text'
          ? { text: part.text, markup: part.markup ?? null }
          : {
              text: part.kind === 'sticker' ? null : (part.caption ?? null),
              markup: null,
            },
      deliver: () =>
        Promise.resolve<ImDeliveryOutcome>({
          kind: 'rejected',
          failure: { reason: 'unsupported', code: 'send_unsupported', outcomeUnknown: false, description: reason },
        }),
    },
    activity: {
      start: () => undefined,
      stop: () => undefined,
      stopAll: () => undefined,
    },
  };
}
