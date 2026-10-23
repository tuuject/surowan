import { GrammyError, HttpError } from 'grammy';
import { describe, expect, test } from 'vitest';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  makeTool,
  sendAudit,
  sendsUsed,
  setup,
} from './reply-dedup-fixtures.ts';

describe('reply deduplication', () => {
  test('an unknown delivery outcome blocks further replies to the same message', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let calls = 0;
    const api: TelegramTransport = {
      sendMessage: async () => {
        calls += 1;
        throw new HttpError('network failed', new Error('socket closed'));
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await expect(tool.execute('u-1', { kind: 'text', text: 'first', reply_to_message_id: '10' })).rejects.toThrow(
      'outcome is unknown',
    );
    await expectRejected(tool, 'u-2', { kind: 'text', text: 'second', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'u-2')).toBe('reply_delivery_unknown');
    expect(calls).toBe(1);
    expect(sendAudit(fixture.store)).toEqual([
      { state: 'outcome_unknown', error_code: 'telegram_network', request_json: expect.stringContaining('"10"') },
    ]);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    fixture.close();
  });

  test('an explicit Telegram rejection still allows retrying the same reply target', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let calls = 0;
    const api: TelegramTransport = {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) {
          throw new GrammyError(
            'Bad Request: message text is empty',
            { ok: false, error_code: 400, description: 'Bad Request: message text is empty' },
            'sendMessage',
            {},
          );
        }
        return { message_id: 500 + calls, date: 1_700_000_100 + calls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await expect(tool.execute('err-1', { kind: 'text', text: 'bad', reply_to_message_id: '10' })).rejects.toThrow(
      'Telegram send failed',
    );
    expect(errorCodeOf(fixture.store, 'err-1')).toBe('telegram_400');
    const result = await tool.execute('err-2', { kind: 'text', text: 'good', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '502' });
    expect(calls).toBe(2);
    expect(sendAudit(fixture.store)).toEqual([
      { state: 'error', error_code: 'telegram_400', request_json: expect.any(String) },
      { state: 'success', error_code: null, request_json: expect.any(String) },
    ]);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(2n);
    fixture.close();
  });

  test('a reply Telegram accepted still blocks retries when the outgoing record fails', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    fixture.store.db.exec(
      "CREATE TRIGGER fail_outgoing BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    const result = await tool.execute('acc-1', { kind: 'text', text: 'hello', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '501' });
    await expectRejected(tool, 'acc-2', { kind: 'text', text: 'again', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'acc-2')).toBe('reply_already_sent');
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    fixture.close();
  });
});
