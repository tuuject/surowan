import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, withoutIdleWait } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('conversation continuity', () => {
  test('a collection that relieves token pressure does not push the run into closing mode', async () => {
    // Regression: the input estimate is a high-water mark that model usage only
    // raises. GC collected the old history at a turn boundary, but the closing
    // check right after still used the pre-GC estimate, so the run went send-only
    // and ended as `context_limit` although the retained transcript was tiny.
    const fixtureSetup = await fixture((config) => {
      withoutIdleWait(config);
      config.agent!.context_stop_ratio = 0.8;
      config.agent!.context!.hard_token_ratio = 0.6;
    });
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 40_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      () => fauxAssistantMessage('first answer'),
      () => fauxAssistantMessage(fauxToolCall('read', { path: 'system:///missing.md' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('second answer'),
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const runNext = async (updateId: number, messageId: number, text: string) => {
      fixtureSetup.ingestion.ingest(update(updateId, messageId, text), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error(`Expected an invocation for ${text}`);
      }
      const outcome = await runtime.run(
        invocationId,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      return outcome;
    };
    try {
      await runNext(1, 10, 'first');
      // Stands in for a long earlier history: the next run starts with an
      // estimate over `context_stop_ratio` that only this old row accounts for.
      fixtureSetup.store.db.prepare('UPDATE context_messages SET est_tokens = 31000 WHERE seq = 2').run();
      const outcome = await runNext(2, 11, 'second');

      // GC did run and dropped the heavy row…
      const context = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; last_gc_at: string | null }>(
          'SELECT head_seq, last_gc_at FROM conversation_contexts',
        )
        .get();
      expect(context?.head_seq).toBe(3n);
      expect(context?.last_gc_at).not.toBeNull();
      // …and the run carried on with its full registry instead of closing.
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      const requests = fixtureSetup.store.db
        .prepare<[], { tools_json: string }>('SELECT tools_json FROM model_calls ORDER BY id')
        .all();
      expect(requests).toHaveLength(3);
      expect(JSON.parse(requests.at(-1)?.tools_json ?? '[]')).toContain('execute');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a run that throws drops its cached agent so the next run replays durable history', async () => {
    // Regression: only a model error (`errorMessage`) evicted the cached agent. A
    // transcript write that failed twice — the message, then Pi's failure message
    // for it — made `prompt` throw with no `errorMessage`, after Pi had already
    // pushed both into `state.messages`. The next run reused those diverged arrays.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first answer'), () => fauxAssistantMessage('third answer')]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const runNext = async (updateId: number, messageId: number, text: string) => {
      fixtureSetup.ingestion.ingest(update(updateId, messageId, text), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error(`Expected an invocation for ${text}`);
      }
      try {
        return await runtime.run(
          invocationId,
          fixtureSetup.configStore.beginInvocation(),
          new AbortController().signal,
        );
      } finally {
        fixtureSetup.store.db
          .prepare("UPDATE invocations SET state = 'failed' WHERE id = ? AND state <> 'completed'")
          .run(invocationId);
        fixtureSetup.store.db
          .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
          .run(invocationId);
      }
    };
    try {
      await runNext(1, 10, 'first');
      // Both the transcript row and the audit row of Pi's failure message fail.
      for (const table of ['context_messages', 'agent_messages']) {
        fixtureSetup.store.db.exec(`CREATE TRIGGER fail_second_run_${table} BEFORE INSERT ON ${table}
          WHEN (SELECT COUNT(*) FROM invocations) = 2
          BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
      }
      await expect(runNext(2, 11, 'second')).rejects.toThrow('disk I/O error');
      const outcome = await runNext(3, 12, 'third');
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      // Durable history holds the first and third runs only.
      expect(
        fixtureSetup.store.db
          .prepare<[], { role: string }>('SELECT role FROM context_messages WHERE evicted_at IS NULL ORDER BY seq')
          .all()
          .map((row) => row.role),
      ).toEqual(['user', 'assistant', 'user', 'assistant']);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('GC judges token pressure against the model this run uses', async () => {
    // Regression: `#maybeCollect` sized the window from the constructor-time registry
    // model while the rest of the run used `modelSwitcher.model()`. After a runtime
    // `/model` switch GC therefore judged pressure against one window and closing
    // against another. Here the registry default is tiny and the run's model is large:
    // the old code saw constant pressure and collected live history on every turn.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxProvider({
      provider: 'agent',
      models: [
        { id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 1_000 },
        { id: 'tiny-model', input: ['text'], contextWindow: 40_000, maxTokens: 30_000 },
      ],
    });
    faux.setResponses([() => fauxAssistantMessage('first answer'), () => fauxAssistantMessage('second answer')]);
    const runtime = await fixtureSetup.runtimeWith(faux, { registryModelId: 'tiny-model' });
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      for (const [index, text] of ['first', 'second'].entries()) {
        fixtureSetup.ingestion.ingest(update(index + 1, 10 + index, text), new Date());
        const [invocationId] = scheduler.processDue(new Date());
        if (invocationId === undefined) {
          throw new Error(`Expected invocation ${index + 1}`);
        }
        await runtime.run(invocationId, fixtureSetup.configStore.beginInvocation(), new AbortController().signal);
        fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
        fixtureSetup.store.db
          .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
          .run(invocationId);
      }
      // Nothing was collected: the run's own window is nowhere near full.
      const context = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; last_gc_at: string | null }>(
          'SELECT head_seq, last_gc_at FROM conversation_contexts',
        )
        .get();
      expect(context).toEqual({ head_seq: 1n, last_gc_at: null });
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
