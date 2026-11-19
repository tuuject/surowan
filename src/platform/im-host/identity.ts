/** Where a conversation physically lives. The tuple is the one source; the union derives from it. */
export const HOST_KINDS = ['telegram', 'playground'] as const;

export type HostKind = (typeof HOST_KINDS)[number];

/** Whether `value` is one of the host kinds this build serves. */
export function isHostKind(value: unknown): value is HostKind {
  return (HOST_KINDS as readonly unknown[]).includes(value);
}

/**
 * Reads a stored `host_kind` — or fails loudly.
 *
 * Storage outlives the build that wrote it: a kind this build does not know
 * must stop the read with an error that names the value, never be folded into
 * a host it may not mean. Everything a stored kind decides for one operation
 * — scheduling, delivery, model accounting, media access — goes through this
 * parser; batch loops that must not let one bad row stall the rest ask
 * {@link isHostKind} instead.
 */
export function parseHostKind(value: unknown): HostKind {
  if (isHostKind(value)) {
    return value;
  }
  throw new Error(`Unknown host kind: ${String(value)}`);
}

/** The `default` arm of a `switch` that already covers every `HostKind`. */
export function unreachableHostKind(kind: never): never {
  throw new Error(`Unhandled host kind: ${String(kind)}`);
}

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

/** One conversation, resolved by the server and bound to its host. */
export interface ImConversationRef {
  readonly host: HostKind;
  /** Internal. Never rendered into a prompt. */
  readonly id: ConversationId;
  /** Internal. Never rendered into a prompt. */
  readonly chatId: ChatId;
  /** Host-side sub-conversation (a Telegram forum topic). `null` for the whole chat. */
  readonly topicId: bigint | null;
  readonly scope: ConversationScope;
}

export function sameConversation(left: ImConversationRef, right: ImConversationRef): boolean {
  return (
    left.host === right.host && left.id === right.id && left.chatId === right.chatId && left.topicId === right.topicId
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
  target: {
    readonly hostChatId: bigint | null;
    readonly internalChatId: bigint;
    readonly threadId: bigint;
    readonly conversationId: bigint;
  },
  host: HostKind,
  scope: ConversationScope,
): ImConversationRef {
  return {
    host,
    id: toConversationId(target.conversationId),
    chatId: toChatId(wireChatId(target, host)),
    topicId: target.threadId === 0n ? null : target.threadId,
    scope,
  };
}

/**
 * The id a ref puts on the wire, mirroring the `chatSource` profile trait (kept
 * in `host-profile.ts`, which cannot be imported here): a `config` chat is
 * addressed by its host-native id, a `room` chat by its internal chat id. A
 * missing native id on a `config` host is a data bug — never the internal id.
 */
function wireChatId(
  target: { readonly hostChatId: bigint | null; readonly internalChatId: bigint },
  host: HostKind,
): string {
  switch (host) {
    case 'telegram':
      if (target.hostChatId === null) {
        throw new Error(`Telegram target ${target.internalChatId} has no host chat id`);
      }
      return target.hostChatId.toString();
    case 'playground':
      return target.internalChatId.toString();
    default:
      return unreachableHostKind(host);
  }
}
