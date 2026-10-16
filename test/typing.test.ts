/**
 * Chat action behaviour, now split across the seam it lives on.
 *
 * The host owns when an action is requested, how often it is refreshed, when it
 * is given up on, and that publishing into a conversation ends it. The platform
 * only decides that a model asked for one. These tests drive both layers
 * through their public entry points, never through a Telegram client.
 */

import { afterEach, expect, test, vi } from 'vitest';

import { createTyping } from '../src/capabilities/typing-tool.ts';
import { identityConversation, type ImDeliveryTarget } from '../src/platform/im-host.ts';
import { grammyTelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { testTelegramHost, type TelegramHost, type TelegramTransport } from './helpers.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const GROUP = '-100123';

function transportFixture() {
  const typing: { chatId: string; threadId: bigint }[] = [];
  const sendTyping = vi.fn(async (chatId: string, threadId: bigint, _signal: AbortSignal) => {
    typing.push({ chatId, threadId });
  });
  const sendMessage = vi.fn(
    async (chatId: string, _text: string, _options: { readonly message_thread_id?: number }) => ({
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: Number(chatId) },
    }),
  );
  const transport: TelegramTransport = { sendTyping, sendMessage, sendSticker: sendMessage };
  return { transport, sendTyping, sendMessage, typing };
}

function targetOf(host: TelegramHost, chatId: string, threadId: bigint): ImDeliveryTarget {
  const conversation = identityConversation(
    { chatId: BigInt(chatId), threadId, conversationId: 1n },
    'telegram',
    'group',
  );
  return { conversation, policy: host.policy(conversation) };
}

function toolFixture() {
  vi.useFakeTimers();
  const f = transportFixture();
  const host = testTelegramHost(f.transport);
  const abort = new AbortController();
  const target = targetOf(host, GROUP, 42n);
  const typing = createTyping(host.activity, target, abort.signal);
  const start = () => typing.tool.execute('typing-call', {});
  return { ...f, host, target, abort, typing, start, stop: typing.stop };
}

function activityFixture() {
  vi.useFakeTimers();
  const f = transportFixture();
  const host = testTelegramHost(f.transport);
  return { ...f, host };
}

/* -------------------------------------------------------------------------- */
/* The platform tool                                                          */
/* -------------------------------------------------------------------------- */

test('typing is opt-in and repeated calls neither duplicate refreshes nor reset the cap', async () => {
  const f = toolFixture();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping).not.toHaveBeenCalled();
  await f.start();
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
  expect(f.sendTyping).toHaveBeenCalledWith(GROUP, 42n, expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(40_000);
  await f.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(14);
  await f.start();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(14);
  f.stop();
});

test('idle cleanup stops refreshes and a later round can start again', async () => {
  const f = toolFixture();
  await f.start();
  await vi.advanceTimersByTimeAsync(0);
  f.stop();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
  await f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledTimes(2);
  f.stop();
});

test('abort ends the round and a cancelled call reports it', async () => {
  const f = toolFixture();
  f.sendTyping.mockImplementationOnce(
    (_chatId: string, _threadId: bigint, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  await f.start();
  await vi.advanceTimersByTimeAsync(0);
  const requestSignal = f.sendTyping.mock.calls[0]![2] as AbortSignal;
  f.abort.abort();
  expect(requestSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
  await expect(f.start()).rejects.toThrow('Typing cancelled');

  // A run that ended before the request went out must not leave one behind.
  const other = createTyping(f.host.activity, targetOf(f.host, GROUP, 99n), new AbortController().signal);
  const queued = other.tool.execute('queued', {});
  other.stop();
  await queued;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
});

/* -------------------------------------------------------------------------- */
/* The host transport                                                         */
/* -------------------------------------------------------------------------- */

test('the grammY transport skips overlapping requests and throttles each chat and topic separately', async () => {
  vi.useFakeTimers();
  const sendChatAction = vi.fn(async (_chatId: string, _action: string, _options: Record<string, unknown>) => true);
  let finish!: () => void;
  sendChatAction.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      }),
  );
  const transport = grammyTelegramTransport({ sendChatAction } as never);
  const signal = new AbortController().signal;
  const first = transport.sendTyping!(GROUP, 42n, signal);
  await vi.advanceTimersByTimeAsync(8_000);
  await transport.sendTyping!(GROUP, 42n, signal);
  expect(sendChatAction).toHaveBeenCalledTimes(1);
  await transport.sendTyping!(GROUP, 0n, signal);
  expect(sendChatAction.mock.calls[1]![2]).toEqual({});
  await transport.sendTyping!('-100456', 42n, signal);
  finish();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  await transport.sendTyping!(GROUP, 42n, signal);
  await transport.sendTyping!(GROUP, 42n, signal);
  expect(sendChatAction).toHaveBeenCalledTimes(4);
});

/* -------------------------------------------------------------------------- */
/* The host activity                                                          */
/* -------------------------------------------------------------------------- */

test('an activity round shows typing immediately, refreshes, and a repeat neither duplicates nor resets the cap', async () => {
  const f = activityFixture();
  f.host.activity.start(targetOf(f.host, GROUP, 42n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
  expect(f.sendTyping).toHaveBeenCalledWith(GROUP, 42n, expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(40_000);
  f.host.activity.start(targetOf(f.host, GROUP, 42n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(20_000);
  // One request at t=0 and one every 4s until the 55s cap: 14 in total, none from the repeat.
  expect(f.sendTyping).toHaveBeenCalledTimes(14);
  f.host.activity.stopAll();
});

test('an activity round after the previous one hit its cap starts a fresh round', async () => {
  const f = activityFixture();
  f.host.activity.start(targetOf(f.host, GROUP, 0n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(60_000);
  const before = f.sendTyping.mock.calls.length;
  f.host.activity.start(targetOf(f.host, GROUP, 0n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledTimes(before + 1);
  expect(f.sendTyping.mock.calls.at(-1)![1]).toBe(0n);
  f.host.activity.stopAll();
});

test('stop ends one round and chats and topics are independent', async () => {
  const f = activityFixture();
  f.host.activity.start(targetOf(f.host, GROUP, 42n), 'until_delivery');
  f.host.activity.start(targetOf(f.host, GROUP, 43n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledTimes(2);
  f.host.activity.stop(targetOf(f.host, GROUP, 42n).conversation);
  await vi.advanceTimersByTimeAsync(8_000);
  // Only the 43 topic keeps refreshing.
  expect(f.typing.filter((call) => call.threadId === 42n)).toHaveLength(1);
  expect(f.typing.filter((call) => call.threadId === 43n).length).toBeGreaterThan(1);
  f.host.activity.stopAll();
  const settled = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(settled);
});

test('publishing into the chat and topic ends its activity, other topics keep theirs', async () => {
  const f = activityFixture();
  f.host.activity.start(targetOf(f.host, GROUP, 42n), 'until_delivery');
  f.host.activity.start(targetOf(f.host, GROUP, 43n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(0);
  const target = targetOf(f.host, GROUP, 42n);
  const outcome = await f.host.delivery.deliver({
    target,
    parts: [{ kind: 'text', text: 'hi' }],
    sendId: 1n,
    signal: undefined,
  });
  expect(outcome.kind).toBe('delivered');
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  const afterSend = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  const later = f.typing.slice(afterSend);
  expect(later.length).toBeGreaterThan(0);
  expect(later.every((call) => call.threadId === 43n)).toBe(true);
  f.host.activity.stopAll();
});

test('typing the model asked for keeps refreshing after a send, and a later call is not lost', async () => {
  const f = toolFixture();
  await f.start();
  await vi.advanceTimersByTimeAsync(0);
  const outcome = await f.host.delivery.deliver({
    target: f.target,
    parts: [{ kind: 'text', text: 'first part of the answer' }],
    sendId: 1n,
    signal: undefined,
  });
  expect(outcome.kind).toBe('delivered');
  const afterSend = f.sendTyping.mock.calls.length;
  // The slow work continues after the message, so the status comes back.
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping.mock.calls.length).toBeGreaterThan(afterSend);
  await f.start();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping.mock.calls.length).toBeGreaterThan(afterSend + 1);
  f.stop();
});

test('a model request takes over a mention round, which then outlives the send', async () => {
  const f = toolFixture();
  f.host.activity.start(f.target, 'until_delivery');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sendTyping).toHaveBeenCalledTimes(1);
  await f.start();
  await vi.advanceTimersByTimeAsync(0);
  await f.host.delivery.deliver({
    target: f.target,
    parts: [{ kind: 'text', text: 'hi' }],
    sendId: 1n,
    signal: undefined,
  });
  const afterSend = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping.mock.calls.length).toBeGreaterThan(afterSend);
  // A later mention neither duplicates nor shortens the model's round.
  f.host.activity.start(f.target, 'until_delivery');
  await f.host.delivery.deliver({
    target: f.target,
    parts: [{ kind: 'text', text: 'again' }],
    sendId: 2n,
    signal: undefined,
  });
  const afterSecond = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping.mock.calls.length).toBeGreaterThan(afterSecond);
  f.stop();
  const settled = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.sendTyping).toHaveBeenCalledTimes(settled);
});

test('a failed send keeps the status, and platform failures stay cosmetic', async () => {
  const f = activityFixture();
  f.sendTyping.mockRejectedValue(new Error('Telegram unavailable'));
  f.sendMessage.mockRejectedValueOnce(new Error('send failed'));
  f.host.activity.start(targetOf(f.host, GROUP, 0n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(8_000);
  const outcome = await f.host.delivery.deliver({
    target: targetOf(f.host, GROUP, 0n),
    parts: [{ kind: 'text', text: 'hi' }],
    sendId: 1n,
    signal: undefined,
  });
  expect(outcome).toMatchObject({ kind: 'rejected' });
  const before = f.sendTyping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.sendTyping.mock.calls.length).toBeGreaterThan(before);
  f.host.activity.stopAll();
});

test('hosts without chat actions get no round and deliver anyway', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => ({ message_id: 1, date: 1_700_000_000, chat: { id: 1 } }));
  const bare: TelegramTransport = { sendMessage: send, sendSticker: send };
  const host = testTelegramHost(bare);
  host.activity.start(targetOf(host, GROUP, 0n), 'until_delivery');
  await vi.advanceTimersByTimeAsync(8_000);
  expect(send).not.toHaveBeenCalled();
  const outcome = await host.delivery.deliver({
    target: targetOf(host, GROUP, 0n),
    parts: [{ kind: 'text', text: 'hi' }],
    sendId: 1n,
    signal: undefined,
  });
  expect(outcome.kind).toBe('delivered');
  expect(send).toHaveBeenCalledTimes(1);
});
