/**
 * Frozen conversation inputs for the host-neutral instant messaging contract:
 * one Telegram supergroup, one Telegram private chat and one local playground
 * room, plus the send-rate policy every host is expected to honour.
 */

import { toChatId, toConversationId, type ImConversationRef } from '../../src/platform/im-host/identity.ts';
import type { ImSendRatePolicy } from '../../src/platform/im-host/policy.ts';

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
