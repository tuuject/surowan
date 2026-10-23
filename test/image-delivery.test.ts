import { HttpError } from 'grammy';
import { describe, expect, test } from 'vitest';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  ALREADY_DELIVERED,
  ASSET_A,
  ASSET_B,
  CHAT_ID,
  GENERATION_ID,
  OTHER_GENERATION_ID,
  START,
  THIRD_GENERATION_ID,
  buildTool,
  completeInvocation,
  contentText,
  fakeTelegram,
  imageRequests,
  openConversation,
  openedStores,
  type Picture,
  resultText,
  sendRows,
  sendsUsed,
  setup,
  toolCalls,
} from './image-delivery-fixtures.ts';

/**
 * `send kind:image` delivery-ledger boundary.
 *
 * Deduplication is per target conversation + generation id + asset id against
 * `host_sends.request_json` (`generation_id` / `asset_ids`): successful
 * deliveries are filtered out, a fully delivered generation replays as a
 * successful no-op that reaches no Telegram API and spends no rate window, and
 * pending / unknown attempts block every retry, resend or not. Authorization
 * (generation ownership, reply refs) runs before any side effect. The suite
 * drives the real store, ingestion and scheduler with a fake Telegram API and
 * mock picture bytes; no network, real config, key.json or serve process.
 */

describe('send image delivery ledger', () => {
  test('records the generation and its asset ids on the first delivery', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context);

    const result = await tool.execute('img-1', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
      text: 'harbor',
    });

    expect(result.details).toEqual({ telegramMessageId: '500' });
    expect(api.photoDeliveries).toEqual([{ chatId: String(CHAT_ID), fileNames: ['a.png'], caption: 'harbor' }]);
    const rows = sendRows(fixture.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'success',
      telegram_message_id: 500n,
      error_code: null,
      conversation_id: context.conversationId,
    });
    expect(JSON.parse(rows[0]!.request_json)).toMatchObject({
      kind: 'image',
      generation_id: GENERATION_ID,
      asset_ids: ['asset-a'],
    });
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'img-1', state: 'success', side_effect: 1n, error_code: null },
    ]);
    expect(sendsUsed(fixture.store)).toEqual([1n]);
    fixture.store.close();
  });

  test('a repeat is a no-op across tool instances and invocations', async () => {
    const fixture = await setup();
    const api = fakeTelegram();
    const first = openConversation(fixture, 1, START);
    await buildTool(fixture, first, { api }).tool.execute('img-1', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });

    // A fresh tool instance over the same invocation reads the delivery from the store.
    const repeated = await buildTool(fixture, first, { api }).tool.execute('img-2', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });
    expect(repeated.details).toEqual({ telegramMessageId: '500', replayed: true });
    expect(contentText(repeated)).toContain('500');

    // Persist the next invocation before closing the store, then read its
    // predecessor's delivery ledger through a freshly opened connection.
    completeInvocation(fixture.store, first.invocationId);
    const second = openConversation(fixture, 2, new Date(START.getTime() + 20_000));
    expect(second.invocationId).not.toBe(first.invocationId);
    fixture.store.close();
    const reopened = await SqliteStore.open(fixture.config);
    openedStores.push(reopened);
    const afterRestart = await buildTool({ ...fixture, store: reopened }, second, { api }).tool.execute('img-3', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });
    expect(afterRestart.details).toEqual({ telegramMessageId: '500', replayed: true });

    expect(api.photoAttempts).toHaveLength(1);
    expect(sendRows(reopened).map((row) => row.state)).toEqual(['success']);
    expect(toolCalls(reopened)).toEqual([
      { tool_call_id: 'img-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 'img-2', state: 'success', side_effect: 0n, error_code: null },
      { tool_call_id: 'img-3', state: 'success', side_effect: 0n, error_code: null },
    ]);
    expect(sendsUsed(reopened)).toEqual([1n, 0n]);
    expect(resultText(reopened, 'img-2')).toMatch(ALREADY_DELIVERED);
    expect(resultText(reopened, 'img-3')).toContain('500');

    // Unknown outcomes also survive a connection restart and still block retry.
    const unknownApi = fakeTelegram(() => {
      throw new HttpError('network failed', new Error('socket closed'));
    });
    await expect(
      buildTool({ ...fixture, store: reopened }, second, { api: unknownApi }).tool.execute('u-1', {
        kind: 'image',
        image_generation_id: OTHER_GENERATION_ID,
      }),
    ).rejects.toThrow('outcome is unknown');
    reopened.close();
    const restarted = await SqliteStore.open(fixture.config);
    openedStores.push(restarted);
    await expect(
      buildTool({ ...fixture, store: restarted }, second, { api: unknownApi }).tool.execute('u-2', {
        kind: 'image',
        image_generation_id: OTHER_GENERATION_ID,
      }),
    ).rejects.toThrow(/pending or has an unknown outcome/);
    expect(unknownApi.photoAttempts).toHaveLength(1);
    expect(sendRows(restarted).map((row) => row.state)).toEqual(['success', 'outcome_unknown']);
    expect(toolCalls(restarted).at(-1)).toMatchObject({
      tool_call_id: 'u-2',
      state: 'error',
      error_code: 'image_delivery_unknown',
    });
    restarted.close();
  });

  test('a no-op neither spends the send window nor sends_used', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context, { sendRateLimit: { sendsPerWindow: 2, windowSeconds: 300 } });

    await tool.execute('r-1', { kind: 'image', image_generation_id: GENERATION_ID });
    const replay = await tool.execute('r-2', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(replay.details).toEqual({ telegramMessageId: '500', replayed: true });

    // The no-op spent nothing, so the second window slot is still free for a
    // real send. A new generation is not judged by the old generation's ledger.
    await tool.execute('r-3', { kind: 'image', image_generation_id: OTHER_GENERATION_ID });
    expect(sendsUsed(fixture.store)).toEqual([2n]);

    // The window really is full now: it counts recorded sends, not no-ops.
    await expect(tool.execute('r-4', { kind: 'image', image_generation_id: THIRD_GENERATION_ID })).rejects.toThrow(
      'send rate limit',
    );
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['a.png']]);
    expect(sendRows(fixture.store)).toHaveLength(2);
    expect(toolCalls(fixture.store).at(-1)).toMatchObject({
      tool_call_id: 'r-4',
      state: 'error',
      error_code: 'send_rate_limited',
    });
    fixture.store.close();
  });

  test('a generation that gained an asset sends only the new asset', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    let pictures: readonly Picture[] = [ASSET_A];
    const { tool, api } = buildTool(fixture, context, { pictures: () => pictures });

    await tool.execute('ap-1', { kind: 'image', image_generation_id: GENERATION_ID });
    pictures = [ASSET_A, ASSET_B];
    const second = await tool.execute('ap-2', { kind: 'image', image_generation_id: GENERATION_ID });

    expect(second.details).toEqual({ telegramMessageId: '501' });
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['b.png']]);
    expect(imageRequests(fixture.store).map((request) => request.asset_ids)).toEqual([['asset-a'], ['asset-b']]);

    // With everything delivered, the same generation replays instead of resending.
    const third = await tool.execute('ap-3', { kind: 'image', image_generation_id: GENERATION_ID });
    expect(third.details.replayed).toBe(true);
    expect(contentText(third)).toContain('delivery message(s): 500, 501');
    expect(resultText(fixture.store, 'ap-3')).toBe(contentText(third));
    expect(api.photoDeliveries).toHaveLength(2);
    fixture.store.close();
  });
});
