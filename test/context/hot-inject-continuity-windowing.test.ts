import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { ConversationContextStore } from '../../src/context/store.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, withoutIdleWait } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('conversation continuity', () => {
  test('keeps the history after a mid-turn head when a later turn boundary exists', async () => {
    // The other half of the repair: when the broken window does contain a turn
    // boundary, only the tail of the interrupted turn is dropped and the rest of the
    // conversation survives.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage(''),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('second answer');
      },
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      await runtime.run(first, fixtureSetup.configStore.beginInvocation(), new AbortController().signal);
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      const conversationId = fixtureSetup.store.db
        .prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // A checkpoint after the interrupted turn, written through the real store so
      // `next_seq` stays consistent.
      const contexts = new ConversationContextStore(fixtureSetup.store);
      const header = contexts.header(conversationId);
      if (header === undefined) {
        throw new Error('Expected a context header');
      }
      const boundarySeq = contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'a later batch', timestamp: 1 }),
        role: 'user',
      });
      const sendResult = fixtureSetup.store.db
        .prepare<[], { seq: bigint }>("SELECT seq FROM context_messages WHERE role = 'toolResult' ORDER BY seq LIMIT 1")
        .get();
      if (sendResult === undefined) {
        throw new Error('Expected a stored send result');
      }
      fixtureSetup.store.db
        .prepare('UPDATE context_messages SET evicted_at = ? WHERE seq < ?')
        .run(new Date().toISOString(), sendResult.seq);
      fixtureSetup.store.db.prepare('UPDATE conversation_contexts SET head_seq = ?').run(sendResult.seq);
      fixtureSetup.conversationRuntime.forget(conversationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      const outcome = await runtime.run(
        second,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      // Head moved forward to the boundary, not to the end: the retained batch is
      // still replayed alongside the new one, and the orphan is gone.
      expect(
        fixtureSetup.store.db.prepare<[], { head_seq: bigint }>('SELECT head_seq FROM conversation_contexts').get()
          ?.head_seq,
      ).toBe(boundarySeq);
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string }[];
      expect(carried.filter((message) => message.role !== 'system').map((message) => message.role)).toEqual([
        'user',
        'user',
      ]);
      expect(requests[0]).toContain('a later batch');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('rebuilds the context when the stable system prompt changes', async () => {
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('')]);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      const firstRun = await fixtureSetup.runtimeAndSnapshot(faux, { systemPrompt: 'prompt A' });
      await firstRun.runtime.run(first, firstRun.snapshot, new AbortController().signal);
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      const before = fixtureSetup.store.db
        .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages')
        .get();
      expect(before?.count).toBeGreaterThan(0n);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      const secondRun = await fixtureSetup.runtimeAndSnapshot(faux, { systemPrompt: 'prompt B' });
      await secondRun.runtime.run(second, secondRun.snapshot, new AbortController().signal);

      // The old rows were dropped, so every row left in the canonical history
      // belongs to the new run and the retained window starts fresh.
      const retained = fixtureSetup.store.db
        .prepare<[], { invocation_id: bigint }>(
          'SELECT invocation_id FROM context_messages WHERE seq >= (SELECT head_seq FROM conversation_contexts)',
        )
        .all();
      expect(retained.length).toBeGreaterThan(0n);
      expect(retained.every((row) => row.invocation_id === second)).toBe(true);
      const head = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; next_seq: bigint }>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      expect(head?.head_seq).toBe(1n);
      expect(head?.next_seq).toBe(BigInt(retained.length) + 1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
