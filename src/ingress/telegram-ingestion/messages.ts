/**
 * Telegram message normalization: turns one grammY `Message` plus the context
 * the ingestion entry point resolved (chat ids, thread, timings, cues, ignored
 * members) into an `InboundMessage` the neutral intake path stores. All
 * transport reading lives here; the intake path never sees a `Message`.
 */
import type { Message, User } from 'grammy/types';
import { EMPTY_MESSAGE_CUES, type BotIdentity } from '../../platform/im-host/cues.ts';
import {
  type ImageDocument,
  isImageDocument,
  richMessageMarkdown,
  type TelegramPhoto,
} from '../../platform/telegram-markdown/index.ts';
import type { InboundMedia, InboundMessage, InboundSender } from '../intake/index.ts';
import { telegramMessageCues } from './cues.ts';

/**
 * The Telegram fields that carry a message's own payload, most specific first:
 * for backward compatibility Telegram sets a plainer field beside some of them
 * (an animation is also a document, a venue also a location), so the first
 * match wins.
 *
 * The key is also the stored `kind`, because that string is what the panel
 * lists and what the model reads as `[kind]` when the message has no body of
 * its own: `[video]` says what arrived, `[unsupported]` only said that the
 * runtime could not use it.
 */
const CONTENT_KEYS = {
  photo: true,
  animation: true,
  video: true,
  video_note: true,
  audio: true,
  voice: true,
  document: true,
  sticker: true,
  paid_media: true,
  story: true,
  poll: true,
  checklist: true,
  dice: true,
  game: true,
  venue: true,
  location: true,
  contact: true,
  invoice: true,
  successful_payment: true,
  refunded_payment: true,
  giveaway: true,
  giveaway_winners: true,
  gift: true,
  unique_gift: true,
  users_shared: true,
  chat_shared: true,
  web_app_data: true,
  connected_website: true,
  boost_added: true,
  chat_background_set: true,
  passport_data: true,
} satisfies Partial<Record<keyof Message, true>>;

const SERVICE_KEYS: Record<string, true> = {
  new_chat_members: true,
  left_chat_member: true,
  new_chat_title: true,
  new_chat_photo: true,
  delete_chat_photo: true,
  group_chat_created: true,
  supergroup_chat_created: true,
  channel_chat_created: true,
  message_auto_delete_timer_changed: true,
  migrate_to_chat_id: true,
  migrate_from_chat_id: true,
  pinned_message: true,
  forum_topic_created: true,
  forum_topic_closed: true,
  forum_topic_reopened: true,
  forum_topic_edited: true,
  general_forum_topic_hidden: true,
  general_forum_topic_unhidden: true,
  video_chat_scheduled: true,
  video_chat_started: true,
  video_chat_ended: true,
  video_chat_participants_invited: true,
};

interface NormalizedMessage {
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly replyToMessageId: bigint | null;
  readonly replySnapshot: string | null;
  readonly forwardOrigin: string | null;
  readonly media: readonly InboundMedia[];
}

/** What the caller already resolved: admission, thread, timing and ignore state. */
export interface InboundContext {
  readonly bot: BotIdentity;
  readonly internalChatId: bigint;
  readonly hostChatId: bigint;
  readonly chatType: string;
  readonly threadId: bigint;
  readonly receivedAt: Date;
  readonly edited: boolean;
  readonly ignoredUserIds: readonly number[];
}

/**
 * Normalizes one Telegram message into the neutral inbound contract. Cues are
 * part of that contract, so a delivery proven to be an edit carries the empty
 * cue set — exactly as the old flow never extracted cues for edits.
 */
export function toInboundMessage(message: Message, context: InboundContext): InboundMessage {
  const service = isServiceMessage(message);
  const normalized = normalizeMessage(message, service, context.ignoredUserIds);
  return {
    host: 'telegram',
    internalChatId: context.internalChatId,
    hostChatId: context.hostChatId,
    chatType: context.chatType,
    threadId: context.threadId,
    messageNo: BigInt(message.message_id),
    sentAt: new Date(message.date * 1000),
    receivedAt: context.receivedAt,
    edited: context.edited,
    cues: context.edited
      ? EMPTY_MESSAGE_CUES
      : telegramMessageCues(message, { id: context.bot.id, username: context.bot.username }),
    sender: senderOf(message),
    fromUserId: message.from === undefined ? null : BigInt(message.from.id),
    service,
    kind: normalized.kind,
    text: normalized.text,
    caption: normalized.caption,
    replyToMessageNo: normalized.replyToMessageId,
    replySnapshotJson: normalized.replySnapshot,
    forwardOriginJson: normalized.forwardOrigin,
    mediaGroupId: message.media_group_id ?? null,
    media: normalized.media,
    rawFragmentJson: JSON.stringify(message),
  };
}

/**
 * The effective author: a `sender_chat` identity wins over the sending
 * account (anonymous admins and channel posts carry a placeholder bot user),
 * and a sender-less delivery stores no sender at all.
 */
function senderOf(message: Message): InboundSender | null {
  const senderChat = message.sender_chat;
  if (senderChat !== undefined) {
    return {
      type: 'sender_chat',
      id: BigInt(senderChat.id),
      displayName: senderChat.title ?? senderChat.username ?? senderChat.id.toString(),
      username: senderChat.username ?? null,
      isBot: false,
    };
  }
  const from = message.from;
  if (from === undefined) {
    return null;
  }
  return {
    type: 'user',
    id: BigInt(from.id),
    displayName: [from.first_name, from.last_name].filter((part) => part !== undefined).join(' '),
    username: from.username ?? null,
    isBot: from.is_bot,
  };
}

function normalizeMessage(message: Message, service: boolean, ignoredUserIds: readonly number[]): NormalizedMessage {
  const media: InboundMedia[] = [];
  let kind = service ? 'service' : contentKind(message);
  if (message.text !== undefined) {
    kind = 'text';
  }
  // A rich message has no text of its own: the revision stores its Markdown,
  // and its photos become the revision's media in document order, matching
  // the placeholders the snapshot builder later finds in that Markdown.
  const rich = message.rich_message === undefined ? undefined : richMessageMarkdown(message.rich_message);
  if (rich !== undefined) {
    kind = 'rich_message';
    for (const item of rich.media) {
      media.push(item.kind === 'photo' ? photoMedia(item.photo) : documentMedia(item.document));
    }
  }
  if (message.photo !== undefined) {
    kind = 'photo';
    const photo = message.photo.at(-1);
    if (photo !== undefined) {
      media.push(photoMedia(photo));
    }
  }
  const document = message.document;
  if (document !== undefined && isImageDocument(document)) {
    kind = 'document';
    media.push(documentMedia(document));
  }
  const sticker = message.sticker;
  if (sticker !== undefined) {
    kind = 'sticker';
    media.push({
      kind: 'sticker',
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      mimeType: sticker.is_video ? 'video/webm' : sticker.is_animated ? 'application/x-tgsticker' : 'image/webp',
      fileSize: sticker.file_size === undefined ? null : BigInt(sticker.file_size),
      width: BigInt(sticker.width),
      height: BigInt(sticker.height),
      rawJson: JSON.stringify(sticker),
    });
  }
  const reply = message.reply_to_message;
  const visibleReply = reply !== undefined && !isIgnoredUser(reply, ignoredUserIds) ? reply : undefined;
  // A join or a leave has no body of its own, so the runtime writes what
  // happened; the header already names whoever caused it.
  const body =
    message.text ??
    (rich === undefined || rich.text.length === 0 ? null : rich.text) ??
    serviceText(message, ignoredUserIds);
  return {
    kind,
    text: body,
    caption: message.caption ?? null,
    replyToMessageId: visibleReply === undefined ? null : BigInt(visibleReply.message_id),
    replySnapshot: visibleReply === undefined ? null : JSON.stringify(compactReply(visibleReply)),
    forwardOrigin: message.forward_origin === undefined ? null : JSON.stringify(message.forward_origin),
    media,
  };
}

function photoMedia(photo: TelegramPhoto): InboundMedia {
  return {
    kind: 'photo',
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id,
    mimeType: 'image/jpeg',
    fileSize: photo.file_size === undefined ? null : BigInt(photo.file_size),
    width: BigInt(photo.width),
    height: BigInt(photo.height),
    rawJson: JSON.stringify(photo),
  };
}

function documentMedia(document: ImageDocument): InboundMedia {
  return {
    kind: 'document',
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    mimeType: document.mime_type,
    fileSize: BigInt(document.file_size),
    width: document.thumbnail === undefined ? null : BigInt(document.thumbnail.width),
    height: document.thumbnail === undefined ? null : BigInt(document.thumbnail.height),
    rawJson: JSON.stringify(document),
  };
}

export function isIgnoredUser(message: Message, ignoredUserIds: readonly number[]): boolean {
  if (message.sender_chat !== undefined || message.from === undefined) {
    return false;
  }
  const senderId = BigInt(message.from.id);
  return ignoredUserIds.some((ignoredUserId) => BigInt(ignoredUserId) === senderId);
}

function compactReply(message: Message): Record<string, unknown> {
  const sender = message.sender_chat ?? message.from;
  const senderName =
    sender === undefined
      ? 'unknown'
      : 'title' in sender
        ? sender.title
        : [sender.first_name, sender.last_name].filter((part) => part !== undefined).join(' ');
  const rich = message.rich_message === undefined ? '' : richMessageMarkdown(message.rich_message).text;
  const content = message.text ?? message.caption ?? (rich.length === 0 ? undefined : rich);
  return {
    message_id: String(message.message_id),
    sender: senderName,
    content: content === undefined ? `[${contentKind(message)}]` : content.slice(0, 500),
  };
}

function contentKind(message: Message): string {
  for (const key of Object.keys(CONTENT_KEYS)) {
    if (key in message) {
      return key;
    }
  }
  return 'unsupported';
}

/**
 * What a service event says, in the same terse voice as the runtime's other
 * bracket tokens. Events outside this list keep an empty body and render as
 * `[service]`: naming an event the runtime does not describe would be worse
 * than admitting it has nothing to say.
 *
 * An ignored member is left out of the description, as their own messages and
 * the replies quoting them are; an event that names only ignored members keeps
 * an empty body.
 */
function serviceText(message: Message, ignoredUserIds: readonly number[]): string | null {
  const shown = (users: readonly User[]): readonly User[] => users.filter((user) => !ignoredUserIds.includes(user.id));
  const actor = message.from;
  const joined = message.new_chat_members;
  if (joined !== undefined) {
    // Only a lone joiner who is also the sender joined on their own; any
    // other shape names every member, so none of them drops out of the line.
    if (actor !== undefined && joined.length === 1 && joined[0]?.id === actor.id) {
      return 'joined the group';
    }
    const added = shown(joined);
    return added.length === 0 ? null : `added ${userNames(added)} to the group`;
  }
  const left = message.left_chat_member;
  if (left !== undefined) {
    if (actor === undefined || actor.id === left.id) {
      return 'left the group';
    }
    return shown([left]).length === 0 ? null : `removed ${userName(left)} from the group`;
  }
  const invited = message.video_chat_participants_invited?.users;
  if (invited !== undefined) {
    const named = shown(invited);
    return named.length === 0 ? null : `invited ${userNames(named)} to a video chat`;
  }
  return null;
}

function userNames(users: readonly User[]): string {
  const names = users.map(userName);
  const last = names.at(-1);
  if (last === undefined) {
    return 'someone';
  }
  return names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/** A display name is Telegram's text, so it must stay on one line. */
function userName(user: User): string {
  const name = [user.first_name, user.last_name]
    .filter((part) => part !== undefined)
    .join(' ')
    .trim();
  return (name.length === 0 ? (user.username ?? String(user.id)) : name).replace(/\s+/g, ' ');
}

function isServiceMessage(message: Message): boolean {
  for (const key of Object.keys(SERVICE_KEYS)) {
    if (key in message) {
      return true;
    }
  }
  return false;
}
