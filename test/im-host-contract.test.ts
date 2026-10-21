/**
 * Host contract conformance.
 *
 * The point of this file is that one set of assertions holds for a Telegram host
 * and for a local virtual host, with no transport type in sight. If a later
 * change to the Telegram adapter stops satisfying the contract, the shared
 * conformance block fails before any behaviour test does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import {
  conversationKey,
  isRetryableFailure,
  renderSenderRef,
  resolveConversationPolicy,
  sameConversation,
  toChatId,
  toConversationId,
  toSenderId,
  type HostKind,
  type ImConversationRef,
  type ImDeliveryFailure,
  type ImDeliveryOutcome,
  type ImDeliveryRequest,
  type ImDeliveryTarget,
  type ImHost,
  type ImOutgoingPart,
} from '../src/platform/im-host.ts';
import {
  PINNED_PLAYGROUND_ROOM,
  PINNED_PLAYGROUND_ROOM_POLICY,
  PINNED_SEND_RATE,
  PINNED_SENDER_A,
  PINNED_SENDER_B,
  PINNED_TELEGRAM_GROUP,
  PINNED_TELEGRAM_GROUP_POLICY,
  PINNED_TELEGRAM_PRIVATE,
  PINNED_TELEGRAM_PRIVATE_POLICY,
  PINNED_VISIBLE_SENDER_REFS,
} from './fixtures/im-host.ts';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A host with no transport at all. Both fakes below share it, so the
 * conformance block only exercises the contract.
 */
function createFakeHost(host: HostKind): {
  readonly host: ImHost;
  readonly delivered: ImDeliveryRequest[];
} {
  const delivered: ImDeliveryRequest[] = [];
  const active = new Set<string>();
  const instance: ImHost = {
    host,
    policy: (conversation) =>
      resolveConversationPolicy({
        host,
        scope: conversation.scope,
        sendRate: PINNED_SEND_RATE,
      }),
    delivery: {
      crossConversationTargets: host === 'telegram',
      compose: (part) =>
        part.kind === 'text'
          ? { text: part.text, markup: part.markup ?? null }
          : { text: part.kind === 'sticker' ? null : (part.caption ?? null), markup: null },
      deliver: async (request) => {
        delivered.push(request);
        return {
          kind: 'delivered',
          recordedByHost: false,
          messages: request.parts.map((_part, partIndex) => ({
            partIndex,
            messageId: BigInt(partIndex + 1),
            sentAtSeconds: 1_700_000_000,
          })),
        };
      },
    },
    activity: {
      start: (target) => void active.add(conversationKey(target.conversation)),
      stop: (conversation) => void active.delete(conversationKey(conversation)),
      stopAll: () => void active.clear(),
    },
  };
  return { host: instance, delivered };
}

function boundTarget(conversation: ImConversationRef, host: ImHost): ImDeliveryTarget {
  return { conversation, policy: host.policy(conversation) };
}

async function deliverOne(host: ImHost, conversation: ImConversationRef, parts: readonly ImOutgoingPart[]) {
  return host.delivery.deliver({
    target: boundTarget(conversation, host),
    parts,
    sendId: 1n,
    signal: new AbortController().signal,
  });
}

/* -------------------------------------------------------------------------- */
/* Conformance, run against every host kind                                   */
/* -------------------------------------------------------------------------- */

for (const host of ['telegram', 'playground'] as const) {
  test(`${host}: satisfies the host contract for a private and a group conversation`, async () => {
    const { host: instance, delivered } = createFakeHost(host);

    expect(instance.host).toBe(host);
    const group: ImConversationRef = host === 'telegram' ? PINNED_TELEGRAM_GROUP : PINNED_PLAYGROUND_ROOM;
    const policy = instance.policy(group);
    expect(policy.delivery.maxTextLength).toBe(4096);
    expect(policy.sendRate).toEqual(PINNED_SEND_RATE);

    const outcome = await deliverOne(instance, group, [
      { kind: 'text', text: 'hello' },
      { kind: 'sticker', stickerRef: 'file' },
    ]);
    expect(outcome.kind).toBe('delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.parts.map((part) => part.kind)).toEqual(['text', 'sticker']);

    instance.activity.start(boundTarget(group, instance), 'until_stop');
    instance.activity.stop(group);
    instance.activity.stopAll();
  });
}

/* -------------------------------------------------------------------------- */
/* Pinned policy table                                                        */
/* -------------------------------------------------------------------------- */

test('the Telegram policy table is pinned', () => {
  expect(resolveConversationPolicy({ host: 'telegram', scope: 'group', sendRate: PINNED_SEND_RATE })).toEqual(
    PINNED_TELEGRAM_GROUP_POLICY,
  );
  expect(resolveConversationPolicy({ host: 'telegram', scope: 'private', sendRate: PINNED_SEND_RATE })).toEqual(
    PINNED_TELEGRAM_PRIVATE_POLICY,
  );
});

test('the playground policy table is pinned', () => {
  expect(resolveConversationPolicy({ host: 'playground', scope: 'group', sendRate: PINNED_SEND_RATE })).toEqual(
    PINNED_PLAYGROUND_ROOM_POLICY,
  );
  expect(resolveConversationPolicy({ host: 'playground', scope: 'group', sendRate: PINNED_SEND_RATE }).senderRef).toBe(
    'opaque',
  );
});

test('policy resolution is pure and does not depend on the conversation identity', () => {
  const a = resolveConversationPolicy({ host: 'telegram', scope: 'group', sendRate: PINNED_SEND_RATE });
  const b = resolveConversationPolicy({ host: 'telegram', scope: 'group', sendRate: PINNED_SEND_RATE });
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
});

test('a Telegram conversation always shows an activity indicator', () => {
  expect(PINNED_TELEGRAM_GROUP_POLICY.activity).toEqual({ kind: 'typing', refreshMs: 4000, capMs: 55000 });
  expect(PINNED_TELEGRAM_PRIVATE_POLICY.activity).toEqual({ kind: 'typing', refreshMs: 4000, capMs: 55000 });
});

/* -------------------------------------------------------------------------- */
/* Internal ids versus model-visible refs                                      */
/* -------------------------------------------------------------------------- */

test('a sender ref never carries an internal id verbatim for the playground', () => {
  expect(renderSenderRef('uid', PINNED_SENDER_A)).toBe(PINNED_VISIBLE_SENDER_REFS.telegram);
  expect(renderSenderRef('opaque', PINNED_SENDER_A)).toBe(PINNED_VISIBLE_SENDER_REFS.playground);
  expect(renderSenderRef('uid', PINNED_SENDER_B)).toBe('uid:2002');
  expect(renderSenderRef('opaque', PINNED_SENDER_B)).toBe('s2002');
});

test('a host may refuse to expose a sender to the model', () => {
  expect(renderSenderRef('none', PINNED_SENDER_A)).toBeNull();
});

test('internal conversation identity is compared on internal fields only', () => {
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP })).toBe(true);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, topicId: 43 })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_GROUP, { ...PINNED_TELEGRAM_GROUP, host: 'playground' })).toBe(false);
  expect(sameConversation(PINNED_TELEGRAM_PRIVATE, PINNED_TELEGRAM_GROUP)).toBe(false);
});

test('a conversation key distinguishes host, chat, and topic', () => {
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).toBe('telegram:-1001234567890:42');
  expect(conversationKey(PINNED_TELEGRAM_PRIVATE)).toBe('telegram:55501:0');
  expect(conversationKey(PINNED_PLAYGROUND_ROOM)).toBe('playground:playground-room-3:0');
  expect(conversationKey(PINNED_TELEGRAM_GROUP)).not.toBe(conversationKey({ ...PINNED_TELEGRAM_GROUP, topicId: 43 }));
});

/* -------------------------------------------------------------------------- */
/* Delivery vocabulary                                                        */
/* -------------------------------------------------------------------------- */

test('an unsupported delivery is reported as an outcome, not thrown', async () => {
  const { host } = createFakeHost('playground');
  const stub: ImHost = {
    ...host,
    delivery: {
      crossConversationTargets: false,
      compose: host.delivery.compose,
      deliver: () =>
        Promise.resolve<ImDeliveryOutcome>({
          kind: 'rejected',
          failure: {
            reason: 'unsupported',
            code: 'send_unsupported',
            outcomeUnknown: false,
            description: 'this host has no transport',
          },
        }),
    },
  };
  const outcome = await deliverOne(stub, PINNED_PLAYGROUND_ROOM, [{ kind: 'text', text: 'hi' }]);
  expect(outcome.kind).toBe('rejected');
  expect(outcome.kind === 'rejected' && outcome.failure.reason).toBe('unsupported');
});

test('retryability is a property of the failure reason, not of a transport error', () => {
  const reasons: readonly [ImDeliveryFailure['reason'], boolean][] = [
    ['rate_limited', true],
    ['transient', true],
    ['network', true],
    ['permanent', false],
    ['aborted', false],
    ['unsupported', false],
  ];
  for (const [reason, retryable] of reasons) {
    expect(isRetryableFailure({ reason, code: reason, outcomeUnknown: false, description: reason })).toBe(retryable);
    // A message that may already be out is never safe to send again.
    expect(isRetryableFailure({ reason, code: reason, outcomeUnknown: true, description: reason })).toBe(false);
  }
});

test('a partial delivery reports the parts that did go out', async () => {
  const base = createFakeHost('telegram').host;
  const host: ImHost = {
    ...base,
    delivery: {
      crossConversationTargets: true,
      compose: base.delivery.compose,
      deliver: () =>
        Promise.resolve<ImDeliveryOutcome>({
          kind: 'delivered',
          recordedByHost: false,
          messages: [{ partIndex: 0, messageId: 900n, sentAtSeconds: 1_700_000_000 }],
        }),
    },
  };
  const outcome = await deliverOne(host, PINNED_TELEGRAM_GROUP, [
    { kind: 'text', text: 'one' },
    { kind: 'text', text: 'two' },
  ]);
  expect(outcome.kind === 'delivered' && outcome.messages.map((m) => m.messageId)).toEqual([900n]);
});

test('a delivery request carries the bound target, so policy travels with the call', async () => {
  const { host, delivered } = createFakeHost('telegram');
  await deliverOne(host, PINNED_TELEGRAM_GROUP, [{ kind: 'text', text: 'ping' }]);
  expect(delivered[0]?.target.conversation).toEqual(PINNED_TELEGRAM_GROUP);
  expect(delivered[0]?.target.policy).toEqual(PINNED_TELEGRAM_GROUP_POLICY);
});

/* -------------------------------------------------------------------------- */
/* The seam stays a leaf                                                      */
/* -------------------------------------------------------------------------- */

test('the contract module is a leaf: no imports, no transport library', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/platform/im-host.ts', import.meta.url)), 'utf8');
  expect(source).not.toMatch(/^\s*import\b/m);
  expect(source).not.toMatch(/grammy|telegraf/i);
});

test('the contract can name Telegram and virtual targets without a transport type', () => {
  const refs: readonly ImConversationRef[] = [PINNED_TELEGRAM_GROUP, PINNED_TELEGRAM_PRIVATE, PINNED_PLAYGROUND_ROOM];
  expect(refs.map((ref) => ref.host)).toEqual(['telegram', 'telegram', 'playground']);
  expect(refs.map((ref) => sameConversation(ref, { ...ref }))).toEqual([true, true, true]);
});

test('the same numeric ids on different hosts are different conversations', () => {
  const telegram: ImConversationRef = PINNED_TELEGRAM_GROUP;
  const playground: ImConversationRef = { ...PINNED_TELEGRAM_GROUP, host: 'playground' };
  expect(sameConversation(telegram, playground)).toBe(false);
  expect(conversationKey(telegram)).not.toBe(conversationKey(playground));
});

test('a chat id is opaque to the platform', () => {
  expect(String(toChatId('-1001234567890'))).toBe('-1001234567890');
  expect(String(toConversationId(7n))).toBe('7');
  expect(String(toSenderId(1001n))).toBe('1001');
});
