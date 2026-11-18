/**
 * Lossless topic ids end to end.
 *
 * A forum topic id is a 64-bit value: SQLite stores it exactly, but any
 * `number` stop on the way rounds an id past 2^53 into a *different* topic.
 * These tests pin every stage the id crosses — stored-conversation resolution,
 * the send-target build and its audit claim, and the single conversion at the
 * wire — so a large id is either preserved exactly or refused, never rounded.
 */

import { expect, test } from 'vitest';

import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { resolveConversation } from '../../src/adapters/local-monolith/runtime/support.ts';
import type { TelegramMessageOptions, TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import { prepareSend } from '../../src/capabilities/send/deliver.ts';
import { deliverSend } from '../../src/capabilities/send/publish.ts';
import type { SendToolEnvironment } from '../../src/capabilities/send/support.ts';
import { toChatId, toConversationId, type ImConversationRef } from '../../src/platform/im-host/identity.ts';
import { previewContext, unavailableCapabilities } from '../../src/platform/invocation-context.ts';
import { testSendToolEnv, testTelegramHost } from '../helpers.ts';
import { openTestStore, seedInvocation, seedTelegramConversation } from './fixtures.ts';

/** 2^53 + 1: no exact `number` exists for this topic id. */
const UNSAFE_TOPIC = 9_007_199_254_740_993n;

function spyingTransport(calls: unknown[][]): TelegramTransport {
  return {
    sendMessage: async (chatId: string, text: string, options: TelegramMessageOptions) => {
      calls.push(['sendMessage', chatId, text, options]);
      return { message_id: 1, date: 1, chat: { id: 1 } };
    },
    sendSticker: async () => {
      throw new Error('not used by these tests');
    },
  } as unknown as TelegramTransport;
}

function sendEnvironment(
  store: SqliteStore,
  transport: TelegramTransport,
  ids: {
    readonly chatId: bigint;
    readonly threadId: bigint;
    readonly conversationId: bigint;
    readonly invocationId: bigint;
    readonly internalChatId: bigint;
  },
): SendToolEnvironment {
  const { host, conversation } = testSendToolEnv(
    transport,
    { chatId: ids.chatId, threadId: ids.threadId, conversationId: ids.conversationId },
    { scope: 'group' },
  );
  return {
    store,
    host,
    conversation,
    context: {
      ...previewContext('telegram'),
      invocationId: ids.invocationId,
      conversationId: ids.conversationId,
      chatId: ids.chatId,
      internalChatId: ids.internalChatId,
      threadId: ids.threadId,
    },
    capabilities: unavailableCapabilities(),
    sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    deadline: Date.now() + 60_000,
    bot: { id: 42n, displayName: 'Bot', username: 'bot' },
  };
}

test('a topic id beyond the number range survives stored-conversation resolution', async () => {
  const { store } = await openTestStore();
  const { conversationId } = seedTelegramConversation(store, { threadId: UNSAFE_TOPIC });
  const ref = resolveConversation(store, { chatId: 123456789n, threadId: UNSAFE_TOPIC, conversationId });
  expect(ref.topicId).toBe(UNSAFE_TOPIC);
});

test('a topic id beyond the number range survives send-target resolution', async () => {
  const { store } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store, { threadId: UNSAFE_TOPIC });
  seedInvocation(store, 5n, conversationId);
  const environment = sendEnvironment(store, spyingTransport([]), {
    chatId: 123456789n,
    threadId: UNSAFE_TOPIC,
    conversationId,
    invocationId: 5n,
    internalChatId: chatId,
  });
  const outcome = await prepareSend(environment, new Set(), 'call-lossless', { kind: 'text', text: 'hi' }, undefined, {
    barrier: false,
  });
  expect(outcome.kind).toBe('ready');
  if (outcome.kind !== 'ready') {
    return;
  }
  expect(outcome.prepared.target.conversation.topicId).toBe(UNSAFE_TOPIC);
  // The claim is real audit state: one pending send reserved against the run.
  const sends = store.db.prepare('SELECT state FROM host_sends').all() as { state: string }[];
  expect(sends).toEqual([{ state: 'pending' }]);
});

test('a safe topic id reaches the wire as the same JSON number', async () => {
  const calls: unknown[][] = [];
  const host = testTelegramHost(spyingTransport(calls));
  const conversation: ImConversationRef = {
    host: 'telegram',
    id: toConversationId(7n),
    chatId: toChatId('-1001'),
    topicId: 42n,
    scope: 'group',
  };
  const outcome = await host.delivery.deliver({
    target: { conversation, policy: host.policy(conversation) },
    parts: [{ kind: 'text', text: 'hi' }],
    sendId: 1n,
    signal: undefined,
  });
  expect(outcome.kind).toBe('delivered');
  const options = (calls[0] as unknown[])[3] as { message_thread_id?: unknown };
  expect(typeof options.message_thread_id).toBe('number');
  expect(options.message_thread_id).toBe(42);
});

test('a topic id the wire cannot carry is refused instead of rounded', async () => {
  const { store } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store, { threadId: UNSAFE_TOPIC });
  seedInvocation(store, 5n, conversationId);
  const calls: unknown[][] = [];
  const environment = sendEnvironment(store, spyingTransport(calls), {
    chatId: 123456789n,
    threadId: UNSAFE_TOPIC,
    conversationId,
    invocationId: 5n,
    internalChatId: chatId,
  });
  await expect(
    deliverSend(environment, new Set(), 'call-unsafe', { kind: 'text', text: 'hi' }, undefined, { barrier: false }),
  ).rejects.toThrow(/topic/i);
  // Nothing reached the transport, and the ledger records a permanent refusal.
  expect(calls).toEqual([]);
  const sends = store.db.prepare('SELECT state, error_code AS errorCode FROM host_sends').all() as {
    state: string;
    errorCode: string;
  }[];
  expect(sends).toEqual([{ state: 'error', errorCode: 'telegram_topic_id_unsafe' }]);
  const tools = store.db.prepare('SELECT state, error_code AS errorCode FROM tool_calls').all() as {
    state: string;
    errorCode: string;
  }[];
  expect(tools).toEqual([{ state: 'error', errorCode: 'telegram_topic_id_unsafe' }]);
});
