import { afterAll, describe, expect, test } from 'vitest';
import { Compile } from 'typebox/compile';
import type { TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import { createSendTool } from '../../src/capabilities/send/index.ts';
import { invocationCapabilities, testSendToolEnv } from '../helpers.ts';
import { cleanupFixtureDirectories, processOne, setup, update } from './send-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('send tool', () => {
  test('sends plain text and MarkdownV2 while auditing Telegram-visible history', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const requests: Array<{ text: string; options: Parameters<TelegramTransport['sendMessage']>[2] }> = [];
    const api: TelegramTransport = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 503, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    });
    expect(tool.description).toContain(
      'Use this only after deciding the new messages or a current task completion require a reply',
    );
    expect(tool.description).toContain('Text must fit the schema limit.');
    expect(tool.description).toContain('do not claim it was sent and do not blindly retry');
    // Unrelated discussions get one send each. The description must not talk the
    // model back into merging them, which is what made group replies run together.
    expect(tool.description).toContain('keep one message to one discussion');
    expect(tool.description).not.toContain('instead of splitting it');
    expect(Compile(tool.parameters).Check({ text: 'world', reply_to_message_id: '10' })).toBe(true);
    expect(Compile(tool.parameters).Check({ text: '*formatted*', parse_mode: 'MarkdownV2' })).toBe(true);
    expect(Compile(tool.parameters).Check({ text: '<b>formatted</b>', parse_mode: 'HTML' })).toBe(false);
    await tool.execute('call-1', { text: 'world', reply_to_message_id: '10' });
    await tool.execute('call-2', { text: '*formatted*', parse_mode: 'MarkdownV2' });
    expect(requests).toEqual([
      { text: 'world', options: { reply_parameters: { message_id: 10 } } },
      { text: '*formatted*', options: { parse_mode: 'MarkdownV2' } },
    ]);
    const audits = store.db
      .prepare<[], { tool_state: string; send_state: string; sent_by_bot: bigint; text: string }>(
        'SELECT tc.state AS tool_state, ts.state AS send_state, m.sent_by_bot, r.text FROM tool_calls tc JOIN host_sends ts ON ts.tool_call_id = tc.id JOIN messages m ON m.telegram_message_id = ts.telegram_message_id JOIN message_revisions r ON r.id = m.current_revision_id ORDER BY tc.id',
      )
      .all();
    expect(audits).toEqual([
      { tool_state: 'success', send_state: 'success', sent_by_bot: 1n, text: 'world' },
      { tool_state: 'success', send_state: 'success', sent_by_bot: 1n, text: '*formatted*' },
    ]);
    store.close();
  });

  test('rejects and audits a reply outside visible context', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const api: TelegramTransport = {
      sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      ...testSendToolEnv(api, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    });
    await expect(tool.execute('call-1', { kind: 'text', text: 'world', reply_to_message_id: '9999' })).rejects.toThrow(
      'not visible',
    );
    const row = store.db
      .prepare<[], { state: string; error_code: string }>('SELECT state, error_code FROM tool_calls')
      .get();
    expect(row).toEqual({ state: 'error', error_code: 'reply_not_visible' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count).toBe(0n);
    store.close();
  });
  test('limits sends to the sliding window and does not retry an unknown network outcome', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    let successfulCalls = 0;
    const successApi: TelegramTransport = {
      sendMessage: async () => {
        successfulCalls += 1;
        return { message_id: 500 + successfulCalls, date: 1_700_000_100 + successfulCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const quotaTool = createSendTool({
      store,
      ...testSendToolEnv(successApi, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    });
    for (let index = 0; index < 6; index += 1) {
      await quotaTool.execute(`quota-${index}`, { kind: 'text', text: `message-${index}` });
    }
    // Failed attempts still count. Before, the window only counted success, pending
    // and unknown outcomes, so a loop whose every send Telegram rejected had no brake.
    store.db
      .prepare("UPDATE host_sends SET state = 'error' WHERE id IN (SELECT id FROM host_sends ORDER BY id LIMIT 3)")
      .run();
    await expect(quotaTool.execute('quota-6', { kind: 'text', text: 'seventh' })).rejects.toThrow('send rate limit');
    expect(successfulCalls).toBe(6);
    // The rejection is audited as an error tool call, not as a silent no-op.
    expect(
      store.db
        .prepare<[], { state: string; error_code: string | null }>(
          "SELECT state, error_code FROM tool_calls WHERE tool_call_id = 'quota-6'",
        )
        .get(),
    ).toEqual({ state: 'error', error_code: 'send_rate_limited' });
    store.close();
  });
});
