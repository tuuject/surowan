import { afterAll, describe, expect, test } from 'vitest';
import { getCurrentTools, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { cleanupFixtureDirectories, fixture, update } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test('another forum topic of the same chat never attaches to the running invocation', async () => {
    const fixtureSetup = await fixture();
    try {
      // The first conversation opens an invocation; a bucket that becomes due in
      // another topic of the same chat must wait for the chat to go idle instead
      // of being injected into a context it does not belong to.
      fixtureSetup.ingestion.ingest(update(1, 10, 'main thread'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.configStore, {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => {
          throw new Error('A bucket must never be injected into another conversation');
        },
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'topic', 100), new Date());
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db
          .prepare<[bigint], { count: bigint }>(
            'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ?',
          )
          .get(invocationId)?.count,
      ).toBe(1n);
      expect(
        fixtureSetup.store.db
          .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM buckets WHERE state = 'collecting'")
          .get()?.count,
      ).toBe(1n);
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('re-queues a bucket that was attached but never injected', async () => {
    const fixtureSetup = await fixture();
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
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
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached later'), new Date());
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(2n);

      // The run ended before injecting the batch: it becomes its own invocation
      // instead of being dropped, and the invocation that owned it keeps its
      // opening bucket as the only member.
      service.releaseUninjectedBuckets(invocationId, new Date());
      expect(
        fixtureSetup.store.db
          .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM invocations WHERE state = 'queued'")
          .get()?.count,
      ).toBe(1n);
      expect(
        fixtureSetup.store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id').all(),
      ).toEqual([{ state: 'running' }, { state: 'queued' }]);
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('does not attach to a run that is already closing', async () => {
    const fixtureSetup = await fixture();
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const injected: bigint[] = [];
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.configStore, {
        isClosing: () => true,
        isRoundInProgress: () => false,
        queueInjection: (_conversationId, bucketId) => injected.push(bucketId),
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      fixtureSetup.ingestion.ingest(update(2, 11, 'too late'), new Date());
      // A run that already decided to stop leaves the bucket collecting for the
      // next invocation instead of swallowing it.
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(injected).toEqual([]);
      expect(
        fixtureSetup.store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()
          ?.state,
      ).toBe('collecting');
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('closing mode grants one send-only turn before the run ends', async () => {
    // Regression: closing mode must let the send-only turn it schedules actually run.
    // With pi 1.x, `prepareNextTurnWithContext` sets `contextClosing` before that turn
    // streams and `finishTurn` (which runs before `turn_end`) stops at the flag's first
    // sight — after the send-only turn has published. The faux provider reports its own
    // prompt-size estimate as usage, so the threshold is lowered instead: the tool
    // registry alone crosses 2 % of the window, which puts the very first turn boundary
    // into closing mode.
    const fixtureSetup = await fixture((config) => {
      config.agent!.context_stop_ratio = 0.02;
      config.agent!.context!.hard_token_ratio = 0.02;
    });
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 40_000, maxTokens: 1_000 }],
    });
    const closingTools: string[][] = [];
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall('read', { path: 'system:///missing.md' }), { stopReason: 'toolUse' }),
      (context) => {
        closingTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'last words' }), {
          stopReason: 'toolUse',
        });
      },
      () => fauxAssistantMessage('should never be requested'),
    ]);
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
      expect(outcome).toEqual({ state: 'completed', reason: 'context_limit' });
      // Exactly one closing turn, and it only carried the send tools.
      expect(closingTools).toEqual([['send', 'send_reply']]);
      expect(
        fixtureSetup.store.db
          .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM host_sends WHERE state = 'success'")
          .get()?.count,
      ).toBe(1n);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()?.count,
      ).toBe(2n);
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);
});
