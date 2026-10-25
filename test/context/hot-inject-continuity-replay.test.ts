import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, withoutIdleWait } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('conversation continuity', () => {
  test('runs a later invocation after the cached agent is dropped from a provider-shaped history', async () => {
    // Regression: the canonical history is written from what the provider
    // returned, and providers report their own usage counters. A decoder that
    // enumerated a fixed set of them rejected the stored rows, so seeding threw
    // before the first model call and every later invocation of the conversation
    // failed instantly — but only once the in-memory agent was gone (process
    // restart or LRU eviction), which is why a whole conversation went dark right
    // after a restart.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      () => fauxAssistantMessage('first answer'),
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
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
      // Rewrite the stored row the way a real provider payload reads: the
      // encoder copies `usage` verbatim, so `reasoning` and the cache write split
      // sit in the column exactly like this.
      const stored = fixtureSetup.store.db
        .prepare<[], { seq: bigint; payload_json: string }>(
          "SELECT seq, payload_json FROM context_messages WHERE role = 'assistant'",
        )
        .get();
      if (stored === undefined) {
        throw new Error('Expected a stored assistant message');
      }
      const payload = JSON.parse(stored.payload_json) as { usage: Record<string, unknown> };
      payload.usage.reasoning = 0;
      payload.usage.cacheWrite1h = 12;
      fixtureSetup.store.db
        .prepare('UPDATE context_messages SET payload_json = ? WHERE seq = ?')
        .run(JSON.stringify(payload), stored.seq);

      // The agent cache is gone — a restart in production, an LRU eviction here.
      const conversationId = fixtureSetup.store.db
        .prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
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
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string; content: unknown }[];
      // The stored assistant turn was replayed from SQLite, not lost.
      expect(JSON.stringify(carried)).toContain('first answer');
      const latestUser = [...carried].reverse().find((message) => message.role === 'user');
      const latestText =
        (latestUser?.content as { type: string; text?: string }[] | undefined)
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n') ?? '';
      expect(latestText).toContain('\n[11 ');
      expect(latestText).not.toContain('\n[10 ');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('seeds from a turn boundary when the retained window starts mid-turn', async () => {
    // Regression: `/cut_topic` moves `head_seq` to the end of the history, so a tool
    // result an aborting run still had in flight lands above the new head with its
    // assistant tool call already dropped. `pi-ai` repairs a missing tool result but
    // forwards an orphaned one verbatim, so the provider rejected every request and
    // the whole Conversation stayed broken until someone cut the topic again.
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
      // The state a cut racing a run leaves behind: everything up to and including
      // the assistant turn that made the call is evicted, and the `send` tool result
      // is the first row of the retained window.
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
      // The window had no turn boundary to cut forward to, so it was dropped: the
      // request carries the new batch alone and no orphaned tool result.
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string }[];
      // pi 1.x requests lead with the runtime-owned system message.
      expect(carried.filter((message) => message.role !== 'system').map((message) => message.role)).toEqual(['user']);
      const head = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; next_seq: bigint }>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      expect(head?.head_seq).toBeGreaterThan(sendResult.seq);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
