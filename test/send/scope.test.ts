import { describe, expect, test } from 'vitest';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  makeTool,
  sendAudit,
  sendsUsed,
  setup,
} from './fixtures.ts';

describe('reply deduplication', () => {
  test('dedup is scoped per conversation and authorization still wins', async () => {
    const fixture = await setup([123456789, 987654321]);
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const contextA = await conversationContext(fixture, 1, 10, t0); // chat A sees message 10
    const apiA = countingApi();
    const { tool: toolA } = makeTool(fixture.store, fixture.config, contextA, { api: apiA });
    await toolA.execute('a-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });

    // Conversation B has never seen message 10: the reply must fail
    // authorization, not dedup, even though conversation A already replied to a
    // message id 10.
    const t1 = new Date(t0.getTime() + 60_000);
    const contextB = await conversationContext(fixture, 2, 1, t1, 'other', 987654321);
    const apiB = countingApi();
    const { tool: toolB } = makeTool(fixture.store, fixture.config, contextB, { api: apiB });
    await expect(toolB.execute('b-1', { kind: 'text', text: '?', reply_to_message_id: '10' })).rejects.toThrow(
      'not visible',
    );
    expect(errorCodeOf(fixture.store, 'b-1')).toBe('reply_not_visible');
    expect(apiB.calls).toBe(0);

    // Once conversation B sees its own message 10, a reply there is allowed and
    // then deduplicated independently of conversation A's send.
    const t2 = new Date(t1.getTime() + 60_000);
    const contextB2 = await conversationContext(fixture, 3, 10, t2, 'hello too', 987654321);
    const { tool: toolB2 } = makeTool(fixture.store, fixture.config, contextB2, { api: apiB });
    const result = await toolB2.execute('b-2', { kind: 'text', text: 'answer too', reply_to_message_id: '10' });
    expect(result.details).toEqual({ telegramMessageId: '501' });
    await expectRejected(toolB2, 'b-3', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'b-3')).toBe('reply_already_sent');
    expect(apiB.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(2);
    fixture.close();
  });

  test('a dedup rejection costs nothing: no row, no API call, no quota, no barrier', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    let armed = false;
    let barrierChecks = 0;
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, {
      api,
      sendsPerWindow: 1,
      holdForNewMessages: () => {
        barrierChecks += 1;
        return armed;
      },
    });
    const first = await tool.execute('hyg-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });
    expect(first.details.telegramMessageId).toBeTruthy();
    armed = true;
    await expectRejected(tool, 'hyg-2', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'hyg-2')).toBe('reply_already_sent');
    expect(barrierChecks).toBe(1);
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    fixture.close();
  });
});
