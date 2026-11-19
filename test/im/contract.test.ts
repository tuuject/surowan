/**
 * Host contract identity.
 *
 * Pins the conversation identity the Telegram host and the local virtual host
 * share: which fields make two conversations the same, and that a conversation
 * key never collides across hosts or forum topics.
 */

import { expect, test } from 'vitest';

import { conversationKey, identityConversation, sameConversation } from '../../src/platform/im-host/identity.ts';
import { PINNED_PLAYGROUND_ROOM, PINNED_TELEGRAM_GROUP, PINNED_TELEGRAM_PRIVATE } from '../fixtures/im-host.ts';

test('internal conversation identity is compared on internal fields only', () => {
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP })).toBe(true);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, topicId: 43n })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, host: 'playground' })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_PRIVATE, PINNED_TELEGRAM_GROUP)).toBe(false);
});

test('a conversation key distinguishes host, chat, and topic', () => {
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).not.toBe(conversationKey({ ...PINNED_TELEGRAM_GROUP, topicId: 43n }));
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).not.toBe(conversationKey(PINNED_PLAYGROUND_ROOM));
});

test('a topic id beyond the number range survives ref construction unchanged', () => {
  // 2^53 + 1 has no exact IEEE-754 representation: any `number` stop on the
  // way to the ref rounds it into a different topic.
  const threadId = 9_007_199_254_740_993n;
  const conversation = identityConversation(
    { hostChatId: -1001234567890n, internalChatId: -1001234567890n, threadId, conversationId: 7n },
    'telegram',
    'group',
  );
  expect(conversation.topicId).toBe(threadId);
  expect(conversationKey(conversation)).toBe(`telegram:-1001234567890:${threadId.toString()}`);
});

test('topic ids that only differ in low bits produce different conversation keys', () => {
  // Both values round to the same number, so rate windows and typing loops
  // keyed by a rounded id would silently share state across two topics.
  const ref = (threadId: bigint) =>
    identityConversation(
      { hostChatId: -1001234567890n, internalChatId: -1001234567890n, threadId, conversationId: 7n },
      'telegram',
      'group',
    );
  expect(conversationKey(ref(9_007_199_254_740_995n))).not.toBe(conversationKey(ref(9_007_199_254_740_996n)));
});
