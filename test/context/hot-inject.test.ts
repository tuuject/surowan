import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update } from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test('a batch that comes due while the bot sleeps is skipped instead of attached', async () => {
    // Regression: the attach path logged the sleeping skip but attached and queued
    // the batch anyway, which woke a run idling through its grace period for
    // another model turn during sleep.
    const fixtureSetup = await fixture();
    try {
      const injected: bigint[] = [];
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.configStore, {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: (_conversationId, bucketId) => {
          injected.push(bucketId);
        },
      });
      const start = new Date();
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), start);
      const [invocationId] = service.processDue(new Date(start.getTime() + 60_000));
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('bot_sleep_until', new Date(start.getTime() + 3_600_000).toISOString(), start.toISOString());
      fixtureSetup.ingestion.ingest(update(2, 11, 'while asleep'), new Date(start.getTime() + 61_000));

      expect(service.processDue(new Date(start.getTime() + 120_000))).toEqual([]);
      expect(injected).toEqual([]);
      expect(
        fixtureSetup.store.db
          .prepare<[], { state: string; error_code: string | null }>(
            'SELECT state, error_code FROM buckets WHERE id = 2',
          )
          .get(),
      ).toEqual({ state: 'skipped_budget', error_code: 'sleeping' });
      expect(
        fixtureSetup.store.db
          .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets WHERE bucket_id = 2')
          .get()?.count,
      ).toBe(0n);
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('drops a queued batch that the run never injected instead of replaying it later', async () => {
    // Regression: `pendingBuckets` outlived the run. A batch attached between rounds
    // and left un-injected (here because the turn budget ends the run before the
    // inject step) stayed in memory, so the next invocation of the same Conversation
    // took it from the queue and injected it a second time — on top of the opening
    // injection that same batch had become in the meantime.
    const fixtureSetup = await fixture((config) => {
      config.agent!.rate_limits!.turns_per_injection = 1;
    });
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('answered')]);
    const runtime = await fixtureSetup.runtimeWith(faux);
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
      const conversationId = fixtureSetup.store.db
        .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
        .get(invocationId)?.conversation_id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // Models the attach that lands before the opening injection, when no round is
      // in progress yet: the batch is queued but the run stops on its turn budget
      // before any turn boundary drains the queue.
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached before the opening injection'), new Date());
      fixtureSetup.conversationRuntime.queueInjection(conversationId, 2n);

      const outcome = await runtime.run(
        invocationId,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      expect(outcome).toEqual({ state: 'completed', reason: 'turn_budget' });
      expect(fixtureSetup.conversationRuntime.hasPendingInjections(conversationId)).toBe(false);
      // Only the opening batch reached the transcript.
      expect(
        fixtureSetup.store.db
          .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM context_messages WHERE role = 'user'")
          .get()?.count,
      ).toBe(1n);
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);
});
