import { describe, expect, test } from 'vitest';
import { ContextRefStore } from '../src/context/context-refs.ts';
import {
  ASSET_A,
  GENERATION_ID,
  START,
  buildTool,
  fakeTelegram,
  openConversation,
  sendRows,
  setup,
  toolCalls,
} from './image-delivery-fixtures.ts';

describe('send image delivery ledger', () => {
  test('rejects a generation owned by another conversation before touching Telegram', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const seen: Array<{ generationId: string; conversationId: bigint }> = [];
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, {
      api,
      pictures: (generationId, conversationId) => {
        seen.push({ generationId, conversationId });
        return conversationId === context.conversationId + 1n ? [ASSET_A] : undefined;
      },
    });

    await expect(tool.execute('x-1', { kind: 'image', image_generation_id: GENERATION_ID })).rejects.toThrow(
      'does not name a finished generation of this conversation',
    );
    // The resolver decides ownership; it was asked about the invoking conversation.
    expect(seen).toEqual([{ generationId: GENERATION_ID, conversationId: context.conversationId }]);
    expect(api.photoAttempts).toHaveLength(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'x-1', state: 'error', side_effect: 1n, error_code: 'image_generation_not_authorized' },
    ]);
    fixture.store.close();
  });

  test('rejects an expired reply reference before resolving the generation', async () => {
    const fixture = await setup();
    const context = openConversation(fixture, 1, START);
    const refs = new ContextRefStore(fixture.store, { ttlHours: () => fixture.config.agent!.context!.ref_ttl_hours });
    refs.replyRef(
      context.header,
      '77',
      { conversationId: context.conversationId, threadId: context.threadId },
      context.header.nextSeq,
      new Date(Date.now() - 100 * 3_600_000),
    );
    const resolved: unknown[] = [];
    const api = fakeTelegram();
    const { tool } = buildTool(fixture, context, {
      api,
      pictures: (...args) => {
        resolved.push(args);
        return [ASSET_A];
      },
    });

    await expect(
      tool.execute('x-2', { kind: 'image', image_generation_id: GENERATION_ID, reply_to_message_id: '77' }),
    ).rejects.toThrow('not visible');
    expect(resolved).toHaveLength(0);
    expect(api.photoAttempts).toHaveLength(0);
    expect(sendRows(fixture.store)).toHaveLength(0);
    expect(toolCalls(fixture.store)).toEqual([
      { tool_call_id: 'x-2', state: 'error', side_effect: 1n, error_code: 'reply_not_visible' },
    ]);
    fixture.store.close();
  });
});
