import { afterAll, describe, expect, test } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { invocationCapabilities, testSendToolEnv } from './helpers.ts';
import { cleanupFixtureDirectories, processOne, setup, update } from './context-send-fixtures.ts';
import { SEND_BARRIER_TEXT } from '../src/capabilities/send-tool-support.ts';

afterAll(cleanupFixtureDirectories);

describe('send tool', () => {
  test('does not retry an unknown network outcome', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    let unknownCalls = 0;
    const unknownApi: TelegramTransport = {
      sendMessage: async () => {
        unknownCalls += 1;
        throw new HttpError('network failed', new Error('socket closed'));
      },
      sendSticker: async () => ({ message_id: 700, date: 1_700_000_300, chat: { id: 123456789 } }),
    };
    const unknownTool = createSendTool({
      store,
      ...testSendToolEnv(unknownApi, context),
      context,
      capabilities: invocationCapabilities(store, config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    });
    await expect(unknownTool.execute('unknown-1', { kind: 'text', text: 'uncertain' })).rejects.toThrow(
      'outcome is unknown',
    );
    expect(unknownCalls).toBe(1);
    expect(
      store.db
        .prepare<[], { state: string }>('SELECT state FROM host_sends WHERE id = (SELECT MAX(id) FROM host_sends)')
        .get()?.state,
    ).toBe('outcome_unknown');
    store.close();
  });

  async function sendFixture(overrides: {
    readonly api: TelegramTransport;
    readonly deadline?: number;
    readonly holdForNewMessages?: () => boolean;
  }) {
    const fixture = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    fixture.ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(fixture.scheduler, new Date(received.getTime() + 15_000));
    const context = fixture.build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const tool = createSendTool({
      store: fixture.store,
      ...testSendToolEnv(overrides.api, context),
      context,
      capabilities: invocationCapabilities(fixture.store, fixture.config, context.header),
      sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: overrides.deadline ?? Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      ...(overrides.holdForNewMessages === undefined ? {} : { holdForNewMessages: overrides.holdForNewMessages }),
    });
    const audit = () => ({
      toolCalls: fixture.store.db
        .prepare<[], { state: string; error_code: string | null }>(
          'SELECT state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
      sends: fixture.store.db
        .prepare<[], { state: string; error_code: string | null; telegram_message_id: bigint | null }>(
          'SELECT state, error_code, telegram_message_id FROM host_sends ORDER BY id',
        )
        .all(),
    });
    return { ...fixture, tool, audit };
  }

  function countingApi(onSend: () => Promise<{ message_id: number }>): TelegramTransport & { calls: number } {
    const api = {
      calls: 0,
      sendMessage: async () => {
        api.calls += 1;
        const { message_id } = await onSend();
        return { message_id, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 700, date: 1_700_000_300, chat: { id: 123456789 } }),
    };
    return api;
  }

  test('an aborted or expired run records a known non-send without calling Telegram', async () => {
    const api = countingApi(async () => ({ message_id: 500 }));
    const aborted = await sendFixture({ api });
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.tool.execute('aborted-1', { kind: 'text', text: 'late' }, controller.signal)).rejects.toThrow(
      'Not sent: aborted',
    );
    expect(aborted.audit()).toEqual({ toolCalls: [{ state: 'error', error_code: 'aborted' }], sends: [] });
    aborted.store.close();

    const expired = await sendFixture({ api, deadline: Date.now() - 1 });
    await expect(expired.tool.execute('expired-1', { kind: 'text', text: 'late' })).rejects.toThrow(
      'Not sent: deadline_exceeded',
    );
    expect(expired.audit()).toEqual({ toolCalls: [{ state: 'error', error_code: 'deadline_exceeded' }], sends: [] });
    expect(api.calls).toBe(0);
    expired.store.close();
  });

  test('a 429 retry is held back without blocking a later reply to the same target', async () => {
    let attempts = 0;
    const api = countingApi(async () => {
      attempts += 1;
      if (attempts > 1) {
        return { message_id: 501 };
      }
      throw new GrammyError(
        'Too Many Requests',
        { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } },
        'sendMessage',
        {},
      );
    });
    let holdChecks = 0;
    // The first check (before the first attempt) finds nothing; the batch
    // arrives while the 429 wait runs.
    const fixture = await sendFixture({
      api,
      holdForNewMessages: () => {
        holdChecks += 1;
        return holdChecks === 2;
      },
    });
    await expect(
      fixture.tool.execute('held-1', { kind: 'text', text: 'stale', reply_to_message_id: '10' }),
    ).rejects.toThrow(SEND_BARRIER_TEXT);
    expect(api.calls).toBe(1);
    expect(fixture.audit()).toEqual({
      toolCalls: [{ state: 'error', error_code: 'send_barrier' }],
      sends: [{ state: 'error', error_code: 'send_barrier', telegram_message_id: null }],
    });
    await fixture.tool.execute('held-2', { kind: 'text', text: 'updated answer', reply_to_message_id: '10' });
    expect(api.calls).toBe(2);
    expect(fixture.audit()).toEqual({
      toolCalls: [
        { state: 'error', error_code: 'send_barrier' },
        { state: 'success', error_code: null },
      ],
      sends: [
        { state: 'error', error_code: 'send_barrier', telegram_message_id: null },
        { state: 'success', error_code: null, telegram_message_id: 501n },
      ],
    });
    fixture.store.close();
  });

  test('a 429 without retry_after stops after one attempt instead of retrying', async () => {
    const api = countingApi(async () => {
      throw new GrammyError(
        'Too Many Requests',
        { ok: false, error_code: 429, description: 'Too Many Requests', parameters: {} },
        'sendMessage',
        {},
      );
    });
    const fixture = await sendFixture({ api });
    await expect(fixture.tool.execute('no-delay-1', { kind: 'text', text: 'hello' })).rejects.toThrow('telegram_429');
    expect(api.calls).toBe(1);
    expect(fixture.audit()).toEqual({
      toolCalls: [{ state: 'error', error_code: 'telegram_429' }],
      sends: [{ state: 'error', error_code: 'telegram_429', telegram_message_id: null }],
    });
    fixture.store.close();
  });

  test('a message Telegram accepted stays a success when recording the outgoing copy fails', async () => {
    const api = countingApi(async () => ({ message_id: 501 }));
    const fixture = await sendFixture({ api });
    fixture.store.db.exec(
      "CREATE TRIGGER fail_outgoing BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const result = await fixture.tool.execute('accepted-1', { kind: 'text', text: 'hello' });
    expect(result.details).toEqual({ telegramMessageId: '501' });
    expect(api.calls).toBe(1);
    expect(fixture.audit()).toEqual({
      toolCalls: [{ state: 'success', error_code: null }],
      sends: [{ state: 'success', error_code: null, telegram_message_id: 501n }],
    });
    fixture.store.close();
  });
});
