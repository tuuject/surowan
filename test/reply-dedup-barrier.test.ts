import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { attachBucketToInvocation } from '../src/orchestration/invocation-queue.ts';
import { buckets, invocationBuckets } from '../src/store/schema.ts';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  imageGeneration,
  makeTool,
  sendAudit,
  sendsUsed,
  setup,
  update,
} from './reply-dedup-fixtures.ts';

describe('reply deduplication', () => {
  test('a rejected-send audit failure cannot roll back a bucket the barrier already queued', async () => {
    const fixture = await setup();
    try {
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      const context = await conversationContext(fixture, 1, 10, t0);
      const now = new Date(t0.getTime() + 60_000);
      fixture.ingestion.ingest(update(2, 11, 'one more thing'), now);
      const collecting = fixture.store.orm
        .select({ id: buckets.id })
        .from(buckets)
        .where(eq(buckets.state, 'collecting'))
        .get()!;
      const runtime = new ConversationRuntime({ agentCacheSize: () => 1 });
      const api = countingApi();
      const { tool } = makeTool(fixture.store, fixture.config, context, {
        api,
        holdForNewMessages: () => {
          fixture.store.transaction(() =>
            attachBucketToInvocation(
              fixture.store,
              fixture.config.agent!.history_messages,
              context.invocationId,
              collecting.id,
              context.conversationId,
              now,
            ),
          );
          runtime.queueInjection(context.conversationId, collecting.id);
          return true;
        },
      });
      fixture.store.db.exec(
        "CREATE TRIGGER fail_send_rejection BEFORE INSERT ON tool_calls WHEN NEW.error_code = 'send_barrier' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
      await expect(tool.execute('held-audit-failed', { text: 'stale', reply_to_message_id: '10' })).rejects.toThrow(
        'disk full',
      );
      expect(runtime.takeInjections(context.conversationId)).toEqual([collecting.id]);
      expect(
        fixture.store.orm.select({ state: buckets.state }).from(buckets).where(eq(buckets.id, collecting.id)).get()
          ?.state,
      ).toBe('running');
      expect(
        fixture.store.orm
          .select({ invocationId: invocationBuckets.invocationId })
          .from(invocationBuckets)
          .where(eq(invocationBuckets.bucketId, collecting.id))
          .get()?.invocationId,
      ).toBe(context.invocationId);
      expect(api.calls).toBe(0);
      expect(sendAudit(fixture.store)).toEqual([]);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(0n);
    } finally {
      fixture.close();
    }
  });

  test('a fully delivered image replays as a no-op and still does not bypass dedup', async () => {
    const fixture = await setup();
    const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
    const api = countingApi();
    const { tool } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
    const first = await tool.execute('img-1', {
      kind: 'image',
      image_generation_id: 'gen-1',
      reply_to_message_id: '10',
    });
    expect(first.details).toEqual({ telegramMessageId: '701' });
    // Delivering the same generation again is a replayed no-op: no new send row.
    const replay = await tool.execute('img-2', {
      kind: 'image',
      image_generation_id: 'gen-1',
      reply_to_message_id: '10',
    });
    expect(replay.details).toEqual({ telegramMessageId: '701', replayed: true });
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    // A different generation on the same reply target is still a duplicate reply.
    await expectRejected(tool, 'img-3', {
      kind: 'image',
      image_generation_id: 'gen-2',
      resend: true,
      reply_to_message_id: '10',
    });
    expect(errorCodeOf(fixture.store, 'img-3')).toBe('reply_already_sent');
    expect(api.calls).toBe(1);
    expect(sendAudit(fixture.store)).toHaveLength(1);
    fixture.close();
  });
});
