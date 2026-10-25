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
