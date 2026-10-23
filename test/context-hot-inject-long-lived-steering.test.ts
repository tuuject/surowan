import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, until } from './context-hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test('the input estimate does not grow with the number of model calls', async () => {
    // Regression: every model call added one tool-registry estimate on top of the
    // reported input tokens, which already count the tool schemas the request
    // carried. The estimate therefore grew by one registry per turn, so a long run
    // crossed `hard_token_ratio` and then `context_stop_ratio` on turn count alone:
    // GC discarded live history and the run ended as `context_limit` while the real
    // context was still tiny.
    const fixtureSetup = await fixture((config) => {
      config.agent!.rate_limits!.turns_per_injection = 40;
    });
    // A window just wide enough for the registry: the drift used to cross
    // `context_stop_ratio` (0.8) well inside the turn budget below.
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 40_000, maxTokens: 1_000 }],
    });
    // Distinct paths, so the repeated-failure breaker does not end the loop first.
    const responses = Array.from(
      { length: 30 },
      (_, index) => () =>
        fauxAssistantMessage(fauxToolCall('read', { path: `system:///missing-${index}.md` }), {
          stopReason: 'toolUse',
        }),
    );
    faux.setResponses([...responses, () => fauxAssistantMessage('done')]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.configStore, {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => undefined,
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);

      const outcome = await runtime.run(
        invocationId,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      // The run ends because the model stopped calling tools, not because the
      // estimate said the window was full.
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      const requests = fixtureSetup.store.db
        .prepare<[], { tools_json: string }>('SELECT tools_json FROM model_calls ORDER BY id')
        .all();
      expect(requests).toHaveLength(31);
      // Closing mode trims the registry to send-only, so a full registry on the
      // last request is the observable proof that the estimate stayed put.
      expect(JSON.parse(requests.at(-1)?.tools_json ?? '[]')).toContain('execute');
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a steered batch whose transcript write fails is re-queued, not lost', async () => {
    // Regression: the bucket was marked injected as soon as it was steered, but
    // `steer` only queues the message. When persisting it then failed, Pi turned
    // the listener error into a failed run, and the injected mark kept
    // `releaseUninjectedBuckets` from re-queuing a batch that never reached the
    // canonical history. The failed run's cached agent, which already held the
    // message, also had to go so the retry replays durable history only.
    const fixtureSetup = await fixture();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first answer'), () => fauxAssistantMessage('second answer')]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    // Fails the steered batch's own write, and only while the first run is the
    // only invocation, so the re-queued run can persist it.
    fixtureSetup.store.db.exec(`CREATE TRIGGER fail_steered BEFORE INSERT ON context_messages
      WHEN NEW.payload_json LIKE '%second%' AND (SELECT COUNT(*) FROM invocations) = 1
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      scheduler.wake();
      await until(
        () =>
          fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()
            ?.count === 1n,
        'the first model call',
      );
      // Lands during the idle grace: attached, steered, and its write fails.
      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      scheduler.wake();
      await until(
        () =>
          fixtureSetup.store.db
            .prepare<[], { state: string }>('SELECT state FROM invocations WHERE bucket_id = 2')
            .get()?.state === 'completed',
        'the re-queued batch to run as its own invocation',
      );
      expect(
        fixtureSetup.store.db.prepare<[], { state: string }>('SELECT state FROM invocations WHERE id = 1').get()?.state,
      ).toBe('failed');
      // The batch reached the canonical history exactly once, after the first turn.
      const userTexts = fixtureSetup.store.db
        .prepare<[], { payload_json: string }>(
          "SELECT payload_json FROM context_messages WHERE role = 'user' AND evicted_at IS NULL ORDER BY seq",
        )
        .all()
        .map((row) => row.payload_json);
      expect(userTexts).toHaveLength(2);
      expect(userTexts[0]).not.toContain('second');
      expect(userTexts[1]).toContain('second');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('releases an un-injected batch before the run closes its buckets', async () => {
    // Regression: the terminal transaction closed every bucket in
    // `invocation_buckets` first and released the un-injected ones afterwards, so
    // the release found nothing in state `running` and only its bucket-state write
    // was a no-op — the new invocation was still queued. The batch was therefore
    // re-processed while its bucket read `completed`, and the state never returned
    // to the normal queued → running → terminal path.
    const fixtureSetup = await fixture();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // A stub attachment target is what makes this deterministic: the real runtime
    // would inject the batch at its next turn boundary, and the state under test is
    // the one where the run ends before that boundary is reached.
    const attachment = {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: () => undefined,
    };
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async () => {
        await gate;
        return { state: 'completed', reason: 'completed' };
      },
      attachment,
    );
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      scheduler.start();
      scheduler.wake();
      await until(
        () =>
          fixtureSetup.store.db
            .prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1")
            .get() !== undefined,
        'the opening invocation to start',
      );
      const openingInvocation = fixtureSetup.store.db
        .prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1")
        .get();
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached but never injected'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.configStore, attachment);
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(2n);

      // Stop first so the released invocation is not launched before the assertions;
      // `stop` clears the running flag synchronously, then waits for this run.
      const stopping = scheduler.stop();
      release();
      await stopping;

      // The opening bucket closes with the run; the un-injected batch goes back to
      // `queued` and owns the fresh invocation that will replay it.
      expect(
        fixtureSetup.store.db
          .prepare<[], { id: bigint; state: string }>('SELECT id, state FROM buckets ORDER BY id')
          .all(),
      ).toEqual([
        { id: 1n, state: 'completed' },
        { id: 2n, state: 'queued' },
      ]);
      const queued = fixtureSetup.store.db
        .prepare<[], { id: bigint; bucket_id: bigint }>("SELECT id, bucket_id FROM invocations WHERE state = 'queued'")
        .all();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.bucket_id).toBe(2n);
      expect(queued[0]?.id).not.toBe(openingInvocation?.id);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
