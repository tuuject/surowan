/**
 * Frozen inputs for the host-neutral instant messaging contract.
 *
 * These are deliberately plain values, not helpers: they are the regression
 * anchor for the Telegram extraction and for the virtual host that follows it.
 * A host adapter must produce the same policy table, the same sender refs, and
 * the same failure vocabulary for these inputs, whatever it does underneath.
 */

import {
  toChatId,
  toConversationId,
  toSenderId,
  type ImConversationPolicy,
  type ImConversationRef,
  type ImSendRatePolicy,
} from '../../src/platform/im-host.ts';

export const PINNED_SEND_RATE: ImSendRatePolicy = { sendsPerWindow: 20, windowSeconds: 60 };

/** A Telegram supergroup with forum topics enabled. */
export const PINNED_TELEGRAM_GROUP: ImConversationRef = {
  host: 'telegram',
  id: toConversationId(7n),
  chatId: toChatId('-1001234567890'),
  topicId: 42,
  scope: 'group',
};

/** A Telegram private chat: no topic, no activity. */
export const PINNED_TELEGRAM_PRIVATE: ImConversationRef = {
  host: 'telegram',
  id: toConversationId(8n),
  chatId: toChatId('55501'),
  topicId: null,
  scope: 'private',
};

/** A local playground room. Same shape, no transport behind it. */
export const PINNED_PLAYGROUND_ROOM: ImConversationRef = {
  host: 'playground',
  id: toConversationId(11n),
  chatId: toChatId('playground-room-3'),
  topicId: null,
  scope: 'group',
};

export const PINNED_SENDER_A = toSenderId(1001n);
export const PINNED_SENDER_B = toSenderId(2002n);

export const PINNED_TELEGRAM_GROUP_POLICY: ImConversationPolicy = {
  delivery: {
    reply: 'inline',
    mention: 'entity',
    maxTextLength: 4096,
    maxCaptionLength: 1024,
    albums: true,
  },
  activity: { kind: 'typing', refreshMs: 4000, capMs: 55000 },
  sendRate: PINNED_SEND_RATE,
  senderRef: 'uid',
};

export const PINNED_TELEGRAM_PRIVATE_POLICY: ImConversationPolicy = {
  delivery: {
    reply: 'inline',
    mention: 'entity',
    maxTextLength: 4096,
    maxCaptionLength: 1024,
    albums: true,
  },
  activity: { kind: 'none', refreshMs: null, capMs: null },
  sendRate: PINNED_SEND_RATE,
  senderRef: 'uid',
};

export const PINNED_PLAYGROUND_ROOM_POLICY: ImConversationPolicy = {
  delivery: {
    reply: 'inline',
    mention: 'plain',
    maxTextLength: 4096,
    maxCaptionLength: 1024,
    albums: true,
  },
  activity: { kind: 'typing', refreshMs: 4000, capMs: 55000 },
  sendRate: PINNED_SEND_RATE,
  senderRef: 'opaque',
};

/** Sender refs the model is allowed to see, per pinned host. */
export const PINNED_VISIBLE_SENDER_REFS = {
  telegram: 'uid:1001',
  playground: 's1001',
} as const;