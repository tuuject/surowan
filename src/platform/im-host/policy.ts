import type { ConversationScope, HostKind, ImConversationRef, SenderRefStyle } from './identity.ts';

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
