import { afterAll, describe, expect, test } from 'vitest';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { invocationCapabilities, testSendToolEnv } from './helpers.ts';
import { cleanupFixtureDirectories, processOne, setup, update } from './context-send-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('send tool', () => {
  test('rejects text above the configured length limit without consuming send quota', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    let sendMessageCalls = 0;
    const api: TelegramTransport = {
      sendMessage: async () => {
        sendMessageCalls += 1;
        return { message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: 5,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    });
    expect(tool.description).toContain('Text must not exceed 5 characters.');
    await expect(tool.execute('call-1', { kind: 'text', text: 'too long' })).rejects.toThrow(
      'exceeds the configured limit of 5 characters',
    );
    expect(sendMessageCalls).toBe(0);
    const row = store.db
      .prepare<[], { state: string; error_code: string; arguments_json: string }>(
        'SELECT state, error_code, arguments_json FROM tool_calls',
      )
      .get();
    expect(row?.state).toBe('error');
    expect(row?.error_code).toBe('send_text_too_long');
    expect(JSON.parse(row?.arguments_json ?? '{}')).toEqual({ kind: 'text', text: 'too long' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count).toBe(0n);
    // A rejected send never reaches Telegram, so it costs nothing in the window.
    await tool.execute('call-2', { kind: 'text', text: 'ok' });
    expect(sendMessageCalls).toBe(1);
    store.close();
  });

  test('rejects blank lines only when the restriction is enabled', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const requests: string[] = [];
    const api: TelegramTransport = {
      sendMessage: async (_chatId, text) => {
        requests.push(text);
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const base = {
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    };
    const permissive = createSendTool({ ...base, disallowBlankLines: false });
    await permissive.execute('call-1', { kind: 'text', text: 'a\n\n\nb' });
    expect(requests).toEqual(['a\n\n\nb']);
    const strict = createSendTool({ ...base, disallowBlankLines: true });
    expect(strict.description).toContain('Text must not contain blank lines');
    await expect(strict.execute('call-2', { kind: 'text', text: 'a\n\nb' })).rejects.toThrow(
      'must not contain blank lines',
    );
    await expect(strict.execute('call-3', { kind: 'text', text: 'a\n  \nb' })).rejects.toThrow(
      'must not contain blank lines',
    );
    await strict.execute('call-4', { kind: 'text', text: 'a\nb' });
    await strict.execute('call-5', { kind: 'text', text: 'a\n b \nc' });
    expect(requests).toEqual(['a\n\n\nb', 'a\nb', 'a\n b \nc']);
    const rejected = store.db
      .prepare<[], { tool_call_id: string; error_code: string }>(
        "SELECT tool_call_id, error_code FROM tool_calls WHERE error_code = 'send_blank_lines' ORDER BY tool_call_id",
      )
      .all();
    expect(rejected).toEqual([
      { tool_call_id: 'call-2', error_code: 'send_blank_lines' },
      { tool_call_id: 'call-3', error_code: 'send_blank_lines' },
    ]);
    store.close();
  });
});
