import { expect, test } from 'vitest';
import type { TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import { createSendTools } from '../../src/capabilities/send/index.ts';
import { duplicateSendGuard } from '../../src/capabilities/send/support.ts';
import { invocationCapabilities, testSendToolEnv, type TestInvocationContext } from '../helpers.ts';
import { conversationContext, sendAudit, sendsUsed, setup, toolAudit } from './fixtures.ts';

/**
 * Contract for `agent.send_empty_text_fallback_*`: with the fallback on, a text
 * message the model sends without `text` goes out as one of the configured
 * texts instead of being refused. The fallback is filled in before any check,
 * so the audit row, the duplicate guard and the host all see the text that was
 * actually published, and the model is told which text that was.
 */

interface SentText {
  readonly text: string;
  readonly replyTo: number | undefined;
  readonly parseMode: string | undefined;
}

function recordingApi(): TelegramTransport & { readonly sent: SentText[] } {
  const sent: SentText[] = [];
  return {
    sent,
    sendMessage: async (_chatId, text, options) => {
      sent.push({ text, replyTo: options.reply_parameters?.message_id, parseMode: options.parse_mode });
      return { message_id: 500 + sent.length, date: 1_700_000_100 + sent.length, chat: { id: 123456789 } };
    },
    sendSticker: async () => {
      throw new Error('no sticker is sent in these tests');
    },
  };
}

function makeTools(
  fixture: Awaited<ReturnType<typeof setup>>,
  context: TestInvocationContext,
  api: TelegramTransport,
  emptyTextFallback: readonly string[] | undefined,
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
    ...(emptyTextFallback === undefined ? {} : { emptyTextFallback }),
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
  });
}

function arguments_(fixture: Awaited<ReturnType<typeof setup>>, toolCallId: string): unknown {
  const row = fixture.store.db
    .prepare<[string], { arguments_json: string }>('SELECT arguments_json FROM tool_calls WHERE tool_call_id = ?')
    .get(toolCallId);
  return row === undefined ? undefined : JSON.parse(row.arguments_json);
}

test('a send without text publishes the fallback as plain text and tells the model what went out', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const { send } = makeTools(fixture, context, api, ['……']);

  const result = await send.execute('bare', { reply_to_message_id: '10', parse_mode: 'MarkdownV2' });

  expect(api.sent).toEqual([{ text: '……', replyTo: 10, parseMode: undefined }]);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: 'Sent Telegram message 501 The call had no text, so the configured fallback text "……" was sent.',
    },
  ]);
  expect(result.details).toEqual({ telegramMessageId: '501' });
  // The audit keeps what was published, so later guards compare the real text.
  expect(arguments_(fixture, 'bare')).toEqual({ kind: 'text', text: '……', reply_to_message_id: '10' });
  expect(toolAudit(fixture.store)).toEqual([{ tool_call_id: 'bare', state: 'success', error_code: null }]);
  expect(sendAudit(fixture.store)).toEqual([{ state: 'success', error_code: null, request_json: expect.any(String) }]);
  expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
  fixture.close();
});

test('the fallback is a published text like any other: repeating it is a duplicate', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const { send } = makeTools(fixture, context, api, ['……']);

  await send.execute('first', {});
  await expect(send.execute('again', {})).rejects.toThrow('send_duplicate');

  expect(api.sent).toHaveLength(1);
  expect(toolAudit(fixture.store)).toEqual([
    { tool_call_id: 'first', state: 'success', error_code: null },
    { tool_call_id: 'again', state: 'error', error_code: 'send_duplicate' },
  ]);
  fixture.close();
});

test('send_reply fills each part without text and names the parts in its result', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = recordingApi();
  const { sendReply } = makeTools(fixture, context, api, ['……']);

  const result = await sendReply.execute('multi', { reply_to_message_id: '10', parts: [{ text: 'well' }, {}] });

  expect(api.sent).toEqual([
    { text: 'well', replyTo: 10, parseMode: undefined },
    { text: '……', replyTo: undefined, parseMode: undefined },
  ]);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: 'Sent 2 Telegram messages in order: 501, 502 Part 2 had no text, so the configured fallback text "……" was sent.',
    },
  ]);
  expect(arguments_(fixture, 'multi')).toEqual({
    reply_to_message_id: '10',
    parts: [{ text: 'well' }, { text: '……' }],
  });
  expect(arguments_(fixture, 'multi:2')).toEqual({ kind: 'text', text: '……' });
  fixture.close();
});
