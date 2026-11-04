import { afterEach, expect, test, vi } from 'vitest';
import type { TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import { createSendTools } from '../../src/capabilities/send/index.ts';
import { duplicateSendGuard } from '../../src/capabilities/send/support.ts';
import { invocationCapabilities, testSendToolEnv, type TestInvocationContext } from '../helpers.ts';
import { conversationContext, type Fixture, sendAudit, sendsUsed, setup, toolAudit } from './fixtures.ts';

/**
 * Contract for `agent.send_empty_text_strategy = "silent_success"`: a text
 * message without `text` is a successful tool call that publishes nothing.
 * It adds no host send, spends no send budget and reports the silent handling
 * to the runtime's consecutive-silent breaker.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

interface SentText {
  readonly text: string;
  readonly replyTo: number | undefined;
}

function recordingApi(): TelegramTransport & { readonly sent: SentText[] } {
  const sent: SentText[] = [];
  return {
    sent,
    sendMessage: async (_chatId, text, options) => {
      sent.push({ text, replyTo: options.reply_parameters?.message_id });
      return { message_id: 500 + sent.length, date: 1_700_000_100 + sent.length, chat: { id: 123456789 } };
    },
    sendSticker: async () => {
      throw new Error('no sticker is sent in these tests');
    },
  };
}

function makeTools(
  fixture: Fixture,
  context: TestInvocationContext,
  api: TelegramTransport,
  onSendOutcome: (outcome: 'published' | 'silent') => void = () => {},
) {
  return createSendTools({
    store: fixture.store,
    ...testSendToolEnv(api, context),
    context,
    capabilities: invocationCapabilities(fixture.store, fixture.config, context.header),
    sendRateLimit: { sendsPerWindow: 10, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    ...duplicateSendGuard(true),
    emptyTextStrategy: 'silent_success',
    onSendOutcome,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
  });
}

function auditRow(
  fixture: Fixture,
  toolCallId: string,
): { state: string; side_effect: bigint; arguments_json: string } | undefined {
  return fixture.store.db
    .prepare<[string], { state: string; side_effect: bigint; arguments_json: string }>(
      'SELECT state, side_effect, arguments_json FROM tool_calls WHERE tool_call_id = ?',
    )
    .get(toolCallId);
}

test('a send without text succeeds without publishing anything', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const outcomes: Array<'published' | 'silent'> = [];
  const { send } = makeTools(fixture, context, api, (outcome) => outcomes.push(outcome));

  const result = await send.execute('bare', { reply_to_message_id: '10', parse_mode: 'MarkdownV2' });

  expect(api.sent).toEqual([]);
  expect(result.details).toEqual({});
  expect(result.content).toEqual([
    {
      type: 'text',
      text: 'Handled without sending: the call had no text, and the silent-success empty-text strategy processed it. No Telegram message was published, so this is a successful fallback rather than a delivery. Do not retry the same empty call.',
    },
  ]);
  expect(auditRow(fixture, 'bare')).toMatchObject({
    state: 'success',
    side_effect: 0n,
    arguments_json: JSON.stringify({ reply_to_message_id: '10', parse_mode: 'MarkdownV2' }),
  });
  expect(sendAudit(fixture.store)).toEqual([]);
  expect(sendsUsed(fixture.store, context.invocationId)).toBe(0n);
  expect(outcomes).toEqual(['silent']);
  fixture.close();
});

test('send_reply skips only the parts without text and attaches the reply target to the first sent part', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const outcomes: Array<'published' | 'silent'> = [];
  const { sendReply } = makeTools(fixture, context, api, (outcome) => outcomes.push(outcome));

  const result = await sendReply.execute('multi', { reply_to_message_id: '10', parts: [{}, { text: 'well' }] });

  expect(api.sent).toEqual([{ text: 'well', replyTo: 10 }]);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: 'Sent 1 Telegram messages in order: 501 Part 1 was handled without sending: it had no text, and the silent-success empty-text strategy processed it. No Telegram message was published for that part.',
    },
  ]);
  expect(result.details).toEqual({ telegramMessageIds: ['501'] });
  expect(toolAudit(fixture.store)).toEqual([
    { tool_call_id: 'multi', state: 'success', error_code: null },
    { tool_call_id: 'multi:1', state: 'success', error_code: null },
    { tool_call_id: 'multi:2', state: 'success', error_code: null },
  ]);
  expect(auditRow(fixture, 'multi')).toMatchObject({ side_effect: 1n });
  expect(auditRow(fixture, 'multi:1')).toMatchObject({ side_effect: 0n });
  expect(auditRow(fixture, 'multi:2')).toMatchObject({ side_effect: 1n });
  expect(outcomes).toEqual(['silent', 'published']);
  fixture.close();
});

test('a send_reply with no text in any part publishes nothing and still succeeds', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const { sendReply } = makeTools(fixture, context, api);

  const result = await sendReply.execute('empty', { parts: [{}, {}] });

  expect(api.sent).toEqual([]);
  expect(result.details).toEqual({});
  expect(result.content).toEqual([
    {
      type: 'text',
      text: 'Handled without sending: no Telegram messages were published. Part 1 was handled without sending: it had no text, and the silent-success empty-text strategy processed it. No Telegram message was published for that part. Part 2 was handled without sending: it had no text, and the silent-success empty-text strategy processed it. No Telegram message was published for that part.',
    },
  ]);
  expect(auditRow(fixture, 'empty')).toMatchObject({ state: 'success', side_effect: 0n });
  expect(sendAudit(fixture.store)).toEqual([]);
  expect(sendsUsed(fixture.store, context.invocationId)).toBe(0n);
  fixture.close();
});

test('other input errors stay errors under the silent strategy', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const outcomes: Array<'published' | 'silent'> = [];
  const { send } = makeTools(fixture, context, api, (outcome) => outcomes.push(outcome));

  await expect(send.execute('sticker', { kind: 'sticker' })).rejects.toThrow('kind:sticker needs sticker_ref');
  await expect(send.execute('image', { kind: 'image' })).rejects.toThrow('kind:image needs image_generation_id');
  await expect(send.execute('resend', { kind: 'text', resend: true })).rejects.toThrow(
    'resend applies only to kind:image',
  );

  expect(api.sent).toEqual([]);
  expect(outcomes).toEqual([]);
  expect(toolAudit(fixture.store)).toEqual([
    { tool_call_id: 'sticker', state: 'error', error_code: 'send_input_invalid' },
    { tool_call_id: 'image', state: 'error', error_code: 'send_input_invalid' },
    { tool_call_id: 'resend', state: 'error', error_code: 'send_input_invalid' },
  ]);
  fixture.close();
});

test('a text send that carries text is published normally', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const outcomes: Array<'published' | 'silent'> = [];
  const { send } = makeTools(fixture, context, api, (outcome) => outcomes.push(outcome));

  const result = await send.execute('words', { text: 'hello' });

  expect(api.sent).toEqual([{ text: 'hello', replyTo: undefined }]);
  expect(result.content).toEqual([{ type: 'text', text: 'Sent Telegram message 501' }]);
  expect(outcomes).toEqual(['published']);
  fixture.close();
});
