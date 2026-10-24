import { afterAll, describe, expect, test } from 'vitest';
import { GrammyError } from 'grammy';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { cleanupTestDirectories, insertAlarm, setup, update } from './alarm-fixtures.ts';
import { invocationCapabilities, testSendToolEnv } from './helpers.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

describe('alarm send mention', () => {
  test('prefixes the first successful text send with a target mention and leaves later sends alone', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });
    expect(context.completion).not.toBe(null);

    const requests: Array<{ text: string; options: Parameters<TelegramTransport['sendMessage']>[2] }> = [];
    const api: TelegramTransport = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    });
    // A sticker ref comes from search_stickers: without one, send refuses, and a
    // successful sticker send carries no alarm mention.
    await expect(tool.execute('sticker-1', { kind: 'sticker', sticker_ref: 'stk_unknown' })).rejects.toThrow(
      'not authorized',
    );
    const stickerRef = capabilities.registerStickerRef('file-id');
    await tool.execute('sticker-2', { kind: 'sticker', sticker_ref: stickerRef });
    expect(requests).toHaveLength(0);
    await tool.execute('text-1', { kind: 'text', text: 'how are you now?' });
    expect(requests[0]?.text).toBe('@Alice how are you now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    await tool.execute('text-2', { kind: 'text', text: 'second message' });
    expect(requests[1]?.text).toBe('second message');
    expect(requests[1]?.options.entities).toBeUndefined();
    store.close();
  });
});

describe('alarm send mention', () => {
  test('retries the first target contact after a Telegram text failure', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    const requests: Array<{ text: string; options: Parameters<TelegramTransport['sendMessage']>[2] }> = [];
    let calls = 0;
    const api: TelegramTransport = {
      sendMessage: async (_chatId, text, options) => {
        calls += 1;
        if (calls === 1) {
          throw new GrammyError(
            'Bad Request',
            { ok: false, error_code: 400, description: 'bad request', parameters: {} } as never,
            'sendMessage',
            {},
          );
        }
        requests.push({ text, options });
        return { message_id: 500 + calls, date: 1_700_000_100 + calls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    });
    await expect(tool.execute('fail-1', { kind: 'text', text: 'are you ok?' })).rejects.toThrow(
      'Telegram send failed: telegram_400',
    );
    await tool.execute('ok-1', { kind: 'text', text: 'are you ok now?' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe('@Alice are you ok now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    expect(
      store.db
        .prepare<[], { state: string; error_code: string | null }>(
          "SELECT state, error_code FROM tool_calls WHERE tool_call_id = 'fail-1'",
        )
        .get(),
    ).toEqual({ state: 'error', error_code: 'telegram_400' });
    store.close();
  });

  test('keeps MarkdownV2 parsing while adding the first-text mention', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Back\\slash!ok[test]' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    const requests: Array<{ text: string; options: Parameters<TelegramTransport['sendMessage']>[2] }> = [];
    const api: TelegramTransport = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100 + requests.length, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    });
    await tool.execute('md-1', { kind: 'text', text: '*bold* ok', parse_mode: 'MarkdownV2' });
    expect(requests[0]?.text).toBe('[@Back\\\\slash\\!ok\\[test\\]](tg://user?id=42) *bold* ok');
    expect(requests[0]?.options.parse_mode).toBe('MarkdownV2');
    expect(requests[0]?.options.entities).toBeUndefined();
    store.close();
  });

  test('applies length and blank-line checks after adding the mention prefix', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = build(alarmInvocation, { contextWindow: 200_000, maxOutputTokens: 32768 });

    let sendCalls = 0;
    const api: TelegramTransport = {
      sendMessage: async () => {
        sendCalls += 1;
        return { message_id: 500 + sendCalls, date: 1_700_000_100 + sendCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const capabilities = invocationCapabilities(store, config, context.header);
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: 20,
      disallowBlankLines: true,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    });
    await expect(tool.execute('long-1', { kind: 'text', text: 'x'.repeat(20) })).rejects.toThrow('exceeds');
    await expect(tool.execute('blank-1', { kind: 'text', text: 'a\n\nb' })).rejects.toThrow('blank lines');
    expect(sendCalls).toBe(0);
    await tool.execute('ok-1', { kind: 'text', text: 'ok' });
    expect(sendCalls).toBe(1);
    store.close();
  });
});
