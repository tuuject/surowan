import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { invocations, hostSends, toolCalls } from '../../src/store/schema/index.ts';
import { renderInvocationContext } from '../helpers.ts';
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
  test('sends without a reply_to_message_id are never deduplicated', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    await tool.execute('nr-1', { kind: 'text', text: 'first' });
    await tool.execute('nr-2', { kind: 'text', text: 'second' });
    await tool.execute('nr-3', { kind: 'text', text: 'reply', reply_to_message_id: '10' });
    expect(api.calls).toBe(3);
    expect(sendAudit(fixture.store)).toHaveLength(3);
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(3n);
    // The no-reply rows neither block nor are blocked by the reply dedup.
    await expectRejected(tool, 'nr-4', { kind: 'text', text: 'reply-dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'nr-4')).toBe('reply_already_sent');
    expect(api.calls).toBe(3);
    expect(sendAudit(fixture.store)).toHaveLength(3);
    fixture.close();
  });

  test.each([undefined, true])('a pending reply obeys allow_reply_message_multiple_times=%s', async (allow) => {
    const fixture = await setup(undefined, allow);
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const gate = Promise.withResolvers<void>();
    const api = countingApi(gate.promise);
    const { tool } = makeTool(fixture.store, fixture.config, context, { api });
    const first = tool.execute('conc-1', { kind: 'text', text: 'first', reply_to_message_id: '10' });
    // execute() runs synchronously up to the API call, so the pending row is
    // committed before the promise is returned.
    expect(sendAudit(fixture.store)).toEqual([expect.objectContaining({ state: 'pending' })]);
    const second = tool.execute('conc-2', { kind: 'text', text: 'second', reply_to_message_id: '10' });
    gate.resolve();
    if (allow === true) {
      await second;
      expect(errorCodeOf(fixture.store, 'conc-2')).toBeNull();
    } else {
      await expect(second).rejects.toThrow('reply_delivery_unknown');
      expect(errorCodeOf(fixture.store, 'conc-2')).toBe('reply_delivery_unknown');
    }
    await first;
    const expectedSends = allow === true ? 2 : 1;
    expect(api.calls).toBe(expectedSends);
    expect(sendAudit(fixture.store).map((row) => row.state)).toEqual(Array(expectedSends).fill('success'));
    expect(sendsUsed(fixture.store, context.invocationId)).toBe(BigInt(expectedSends));
    fixture.close();
  });

  test('a pending reply left by a crashed run stays blocked after reopen and recovery', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const now = new Date().toISOString();
    // This is the durable state at a crash after the claim but before an API result.
    fixture.store.transaction(() => {
      const call = fixture.store.orm
        .insert(toolCalls)
        .values({
          invocationId: context.invocationId,
          toolCallId: 'crashed',
          toolName: 'send',
          argumentsJson: JSON.stringify({ text: 'answer', reply_to_message_id: '10' }),
          state: 'pending',
          sideEffect: true,
          createdAt: now,
        })
        .returning({ id: toolCalls.id })
        .get()!;
      fixture.store.orm
        .insert(hostSends)
        .values({
          toolCallId: call.id,
          conversationId: context.conversationId,
          kind: 'text',
          requestJson: JSON.stringify({ kind: 'text', reply_to_message_id: '10' }),
          state: 'pending',
          createdAt: now,
        })
        .run();
      fixture.store.orm
        .update(invocations)
        .set({ state: 'running', sideEffectStarted: true, sendsUsed: 1n })
        .where(eq(invocations.id, context.invocationId))
        .run();
    });
    fixture.close();
    const reopened = await SqliteStore.open(fixture.config);
    try {
      new InvocationQueueService(reopened, fixture.configStore).recover();
      expect(
        reopened.orm
          .select({ state: invocations.state })
          .from(invocations)
          .where(eq(invocations.id, context.invocationId))
          .get()?.state,
      ).toBe('outcome_unknown');
      const rebuilt = renderInvocationContext(reopened, fixture.config, context.invocationId);
      const api = countingApi();
      const { tool } = makeTool(reopened, fixture.config, rebuilt, { api });
      await expect(tool.execute('after-restart', { text: 'answer again', reply_to_message_id: '10' })).rejects.toThrow(
        'reply_delivery_unknown',
      );
      expect(errorCodeOf(reopened, 'after-restart')).toBe('reply_delivery_unknown');
      expect(api.calls).toBe(0);
      expect(sendAudit(reopened)).toEqual([expect.objectContaining({ state: 'pending' })]);
      expect(sendsUsed(reopened, context.invocationId)).toBe(1n);
    } finally {
      reopened.close();
    }
  });
});
