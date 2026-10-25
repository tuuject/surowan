import { describe, expect, test } from 'vitest';
import { ConversationContextStore } from '../../src/context/store.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { renderInvocationContext } from '../helpers.ts';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  makeTool,
  processOne,
  sendAudit,
  sendsUsed,
  setup,
  update,
} from './fixtures.ts';

describe('reply deduplication', () => {
  test('dedup survives new invocations, rebuilt tools and a SQLite reopen', async () => {
    const fixture = await setup();
    const t0 = new Date('2026-08-15T00:00:00.000Z');
    const context1 = await conversationContext(fixture, 1, 10, t0);
    const api1 = countingApi();
    const { tool: tool1 } = makeTool(fixture.store, fixture.config, context1, { api: api1 });
    await tool1.execute('inv-1', { kind: 'text', text: 'answer', reply_to_message_id: '10' });
    expect(api1.calls).toBe(1);

    // A new invocation and a freshly built tool in the same process stay blocked.
    const t1 = new Date(t0.getTime() + 60_000);
    const context2 = await conversationContext(fixture, 2, 11, t1, 'again');
    const api2 = countingApi();
    const { tool: tool2 } = makeTool(fixture.store, fixture.config, context2, { api: api2 });
    await expectRejected(tool2, 'inv-2', { kind: 'text', text: 'dup', reply_to_message_id: '10' });
    expect(errorCodeOf(fixture.store, 'inv-2')).toBe('reply_already_sent');
    expect(api2.calls).toBe(0);
    expect(sendsUsed(fixture.store, context2.invocationId)).toBe(0n);

    // Closing and reopening the database keeps the retained audit: a fresh
    // store, a fresh context header object and a fresh tool still see the
    // earlier reply.
    fixture.store.close();
    const store2 = await SqliteStore.open(fixture.config);
    const ingestion2 = new TelegramIngestion(store2, fixture.configStore, { id: 999 });
    const scheduler2 = new BucketScheduler(store2, fixture.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const t2 = new Date(t1.getTime() + 60_000);
    ingestion2.ingest(update(3, 12, 'third'), t2);
    const invocationId3 = processOne(scheduler2, new Date(t2.getTime() + 15_000));
    const context3 = renderInvocationContext(store2, fixture.config, invocationId3, {
      contextWindow: 200_000,
      maxOutputTokens: 32768,
    });
    const api3 = countingApi();
    const { tool: tool3 } = makeTool(store2, fixture.config, context3, { api: api3 });
    await expectRejected(tool3, 'inv-3', { kind: 'text', text: 'dup-again', reply_to_message_id: '10' });
    expect(errorCodeOf(store2, 'inv-3')).toBe('reply_already_sent');
    expect(api3.calls).toBe(0);
    expect(sendsUsed(store2, invocationId3)).toBe(0n);
    expect(store2.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count).toBe(1n);
    store2.close();
  });

  test('a context reset cannot forget delivery, while a different message can still receive a reply', async () => {
    const fixture = await setup();
    try {
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      const first = await conversationContext(fixture, 1, 10, t0);
      const api = countingApi();
      await makeTool(fixture.store, fixture.config, first, { api }).tool.execute('before-reset', {
        text: 'answer',
        reply_to_message_id: '10',
      });
      const contexts = new ConversationContextStore(fixture.store);
      expect(contexts.open(first.conversationId, 'changed-system-prompt').rebuilt).toBe(true);
      expect(fixture.store.db.prepare('SELECT * FROM context_refs').all()).toEqual([]);
      // Re-expose the old batch so visibility does not mask the delivery check.
      fixture.build(first.invocationId);
      const second = await conversationContext(fixture, 2, 11, new Date(t0.getTime() + 60_000));
      const { tool } = makeTool(fixture.store, fixture.config, second, { api });
      await expect(tool.execute('after-reset', { text: 'answer again', reply_to_message_id: '10' })).rejects.toThrow(
        'reply_already_sent',
      );
      expect(errorCodeOf(fixture.store, 'after-reset')).toBe('reply_already_sent');
      await tool.execute('new-target', { text: 'new answer', reply_to_message_id: '11' });
      expect(api.calls).toBe(2);
      expect(sendAudit(fixture.store).map((row) => JSON.parse(row.request_json).reply_to_message_id)).toEqual([
        '10',
        '11',
      ]);
      expect(sendsUsed(fixture.store, second.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });
});
