import { describe, expect, test } from 'vitest';
import type { CompletionContext } from '../src/platform/invocation-context.ts';
import {
  GENERATION_ID,
  OTHER_CHAT_ID,
  START,
  buildTool,
  completeInvocation,
  fakeTelegram,
  imageRequests,
  openConversation,
  sendRows,
  sendsUsed,
  setup,
  toolCalls,
} from './image-delivery-fixtures.ts';

describe('send image delivery ledger', () => {
  test('resend is image-only and needs an explicit user turn', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, { api });

    await expect(tool.execute('t-1', { kind: 'text', text: 'hello', resend: true })).rejects.toThrow(
      'resend applies only to kind:image; omit it for kind:text',
    );
    await expect(tool.execute('t-2', { kind: 'sticker', sticker_ref: 'stk_missing', resend: true })).rejects.toThrow(
      'resend applies only to kind:image; omit it for kind:sticker',
    );

    const receipt: CompletionContext = {
      taskId: 5n,
      pluginId: 'test',
      payload: null,
      status: 'completed',
      delivery: { bypassDailyBudget: false },
    };
    const receiptTool = buildTool(fixture, context, { api, context: { completion: receipt, callerUserId: 42n } }).tool;
    await expect(
      receiptTool.execute('t-3', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow('explicit new user request');

    const anonymousTool = buildTool(fixture, context, { api, context: { callerUserId: null } }).tool;
    await expect(
      anonymousTool.execute('t-4', { kind: 'image', image_generation_id: GENERATION_ID, resend: true }),
    ).rejects.toThrow('explicit new user request');

    expect(api.photoAttempts).toHaveLength(0);
    expect(api.textSends).toBe(0);
    expect(api.stickerSends).toBe(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store).map((row) => row.error_code)).toEqual([
      'send_input_invalid',
      'send_input_invalid',
      'image_resend_requires_user',
      'image_resend_requires_user',
    ]);
    fixture.store.close();
  });

  test('an explicit resend on an ordinary user turn delivers the same assets again', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const { tool, api } = buildTool(fixture, context);

    await tool.execute('re-1', { kind: 'image', image_generation_id: GENERATION_ID });
    const resent = await tool.execute('re-2', { kind: 'image', image_generation_id: GENERATION_ID, resend: true });

    expect(resent.details).toEqual({ telegramMessageId: '501' });
    expect(api.photoDeliveries.map((delivery) => delivery.fileNames)).toEqual([['a.png'], ['a.png']]);
    expect(
      sendRows(fixture.store).map((row) => ({ state: row.state, telegram_message_id: row.telegram_message_id })),
    ).toEqual([
      { state: 'success', telegram_message_id: 500n },
      { state: 'success', telegram_message_id: 501n },
    ]);
    expect(imageRequests(fixture.store).map((request) => request.asset_ids)).toEqual([['asset-a'], ['asset-a']]);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 're-1', state: 'success', side_effect: 1n, error_code: null },
      { tool_call_id: 're-2', state: 'success', side_effect: 1n, error_code: null },
    ]);
    expect(sendsUsed(fixture.store)).toEqual([2n]);
    fixture.store.close();
  });

  test('a delivery in one conversation does not suppress the same generation in another', async () => {
    const fixture = await setup([OTHER_CHAT_ID]);
    const api = fakeTelegram();
    const first = openConversation(fixture, 1, START);
    await buildTool(fixture, first, { api }).tool.execute('c-1', { kind: 'image', image_generation_id: GENERATION_ID });
    completeInvocation(fixture.store, first.invocationId);

    const second = openConversation(fixture, 2, new Date(START.getTime() + 20_000), OTHER_CHAT_ID);
    expect(second.chatId).toBe(BigInt(OTHER_CHAT_ID));
    const result = await buildTool(fixture, second, { api }).tool.execute('c-2', {
      kind: 'image',
      image_generation_id: GENERATION_ID,
    });

    expect(result.details.replayed).not.toBe(true);
    expect(api.photoDeliveries).toHaveLength(2);
    expect(sendRows(fixture.store).map((row) => row.conversation_id)).toEqual([
      first.conversationId,
      second.conversationId,
    ]);
    fixture.store.close();
  });
});
