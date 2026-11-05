/**
 * Host contract identity.
 *
 * Pins the conversation identity the Telegram host and the local virtual host
 * share: which fields make two conversations the same, and that a conversation
 * key never collides across hosts or forum topics.
 */

import { expect, test } from 'vitest';

import { conversationKey, sameConversation } from '../../src/platform/im-host/identity.ts';
import { PINNED_PLAYGROUND_ROOM, PINNED_TELEGRAM_GROUP, PINNED_TELEGRAM_PRIVATE } from '../fixtures/im-host.ts';

test('internal conversation identity is compared on internal fields only', () => {
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP })).toBe(true);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, topicId: 43 })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, host: 'playground' })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_PRIVATE, PINNED_TELEGRAM_GROUP)).toBe(false);
});

test('a conversation key distinguishes host, chat, and topic', () => {
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).not.toBe(conversationKey({ ...PINNED_TELEGRAM_GROUP, topicId: 43 }));
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).not.toBe(conversationKey(PINNED_PLAYGROUND_ROOM));
});
