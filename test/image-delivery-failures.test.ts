import { GrammyError, HttpError } from 'grammy';
import { describe, expect, test } from 'vitest';
import {
  ASSET_A,
  ASSET_B,
  GENERATION_ID,
  START,
  buildTool,
  fakeTelegram,
  openConversation,
  type Picture,
  sendRows,
  setup,
  toolCalls,
} from './image-delivery-fixtures.ts';

describe('send image delivery ledger', () => {
  test('a pending attempt is persisted before the await and blocks concurrent retries', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = fakeTelegram(async () => {
      await gate;
    });
    let pictures: readonly Picture[] = [ASSET_A];
    const { tool } = buildTool(fixture, context, { api, pictures: () => pictures });

    const first = tool.execute('pending-1', { kind: 'image', image_generation_id: GENERATION_ID });
    // The guard row is committed synchronously, before Telegram was awaited.
    const pending = sendRows(fixture.store);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: 'pending', conversation_id: context.conversationId });
    expect(JSON.parse(pending[0]!.request_json)).toMatchObject({ asset_ids: ['asset-a'] });

    // Any target asset of a pending attempt blocks the whole call, even a
    // resend and even when the request also carries a not-yet-delivered asset.
    pictures = [ASSET_A, ASSET_B];
    await expect(
      tool.execute('pending-2', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    await expect(tool.execute('pending-3', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      /pending or has an unknown outcome/,
    );
    release();
    await first;

    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png']]);
    expect(sendRows(fixture.store).map((row) => row.state)).toEqual(['success']);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'pending-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 'pending-2', state: 'error', side_effect: 1n, error_code: 'image_delivery_unknown' },
      { tool_call_id: 'pending-3', state: 'error', side_effect: 1n, error_code: 'image_delivery_unknown' },
    ]);
    fixture.store.close();
  });

  test('an unknown outcome, network or 5xx, blocks every retry', async () => {
    const network = await setup();
    const networkContext = openConversation(network, 1, START);
    const networkApi = fakeTelegram(() => {
      throw new HttpError('network failed', new Error('socket closed'));
    });
    const networkTool = buildTool(network, networkContext, { api: networkApi }).tool;
    await expect(networkTool.execute('u-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'outcome is unknown',
    );
    expect(sendRows(network.store)).toEqual([
      expect.objectContaining({
        state: 'outcome_unknown',
        error_code: 'telegram_network',
        telegram_message_id: null,
      }),
    ]);
    await expect(networkTool.execute('u-2', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      /pending or has an unknown outcome/,
    );
    await expect(
      networkTool.execute('u-3', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(networkApi.photoAttempts).toHaveLength(1);
    expect(sendRows(network.store)).toHaveLength(1);
    expect(
      toolCalls(network.store)
        .slice(1)
        .map((row) => row.error_code),
    ).toEqual(['image_delivery_unknown', 'image_delivery_unknown']);
    network.store.close();

    const server = await setup();
    const serverContext = openConversation(server, 1, START);
    const serverApi = fakeTelegram(() => {
      throw new GrammyError(
        'Internal Server Error',
        { ok: false, error_code: 500, description: 'Internal Server Error' },
        'sendPhoto',
        {},
      );
    });
    const serverTool = buildTool(server, serverContext, { api: serverApi }).tool;
    await expect(serverTool.execute('u-4', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'Telegram send outcome is unknown',
    );
    expect(sendRows(server.store)[0]).toMatchObject({ state: 'outcome_unknown', error_code: 'telegram_500' });
    await expect(
      serverTool.execute('u-5', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(serverApi.photoAttempts).toHaveLength(1);
    expect(sendRows(server.store)).toHaveLength(1);
    server.store.close();
  });

  test('a known 4xx failure can be retried', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let failNext = true;
    const api = fakeTelegram(() => {
      if (!failNext) {
        return;
      }
      failNext = false;
      throw new GrammyError('Bad Request', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendPhoto', {});
    });
    const { tool } = buildTool(fixture, context, { api });

    await expect(tool.execute('f-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'telegram_400',
    );
    expect(sendRows(fixture.store)[0]).toMatchObject({
      state: 'error',
      error_code: 'telegram_400',
      telegram_message_id: null,
    });

    // A known rejection delivered nothing, so the same asset may go out again.
    const retry = await tool.execute('f-2', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(retry.details).toEqual({ telegramMessageId: '500' });
    expect(api.photoAttempts).toHaveLength(2);
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png']]);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'f-1', state: 'error', side_effect: 1n, error_code: 'telegram_400' },
      { tool_call_id: 'f-2', state: 'success', side_effect: 1n, error_code: null },
    ]);
    fixture.store.close();
  });
});
