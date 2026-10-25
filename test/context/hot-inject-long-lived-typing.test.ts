import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { identityConversation } from '../../src/platform/im-host/identity.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, until, CHAT_ID } from './hot-inject-fixtures.ts';
import { sleep } from '../helpers.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test.each([false, true])('silence and quick replies do not start typing with send=%s', async (send) => {
    const f = await fixture((config) => {
      config.agent!.context!.idle_grace_seconds = 0;
    });
    const faux = fauxAgent();
    faux.setResponses([
      send
        ? fauxAssistantMessage(fauxToolCall('send', { text: 'hello' }), { stopReason: 'toolUse' })
        : fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const { runtime, snapshot } = await f.runtimeAndSnapshot(faux);
    const service = new InvocationQueueService(f.store, f.configStore, f.conversationRuntime);
    try {
      f.ingestion.ingest(update(1, 10, 'hello'), new Date());
      const [id] = service.processDue(new Date());
      expect(id).toBeDefined();
      expect((await runtime.run(id!, snapshot, new AbortController().signal)).state).toBe('completed');
      expect(f.typingSignals).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });

  test('a mention status started at ingestion ends with the round, even when the model stays silent', async () => {
    const f = await fixture((config) => {
      config.agent!.context!.idle_grace_seconds = 0;
    });
    const faux = fauxAgent();
    faux.setResponses([fauxAssistantMessage(''), fauxAssistantMessage('')]);
    const { runtime, snapshot } = await f.runtimeAndSnapshot(faux);
    const service = new InvocationQueueService(f.store, f.configStore, f.conversationRuntime);
    try {
      f.ingestion.ingest(update(1, 10, 'hello'), new Date());
      f.host.activity.start(
        {
          conversation: identityConversation(
            { chatId: BigInt(CHAT_ID), threadId: 0n, conversationId: 1n },
            'telegram',
            'private',
          ),
          policy: f.host.policy(
            identityConversation({ chatId: BigInt(CHAT_ID), threadId: 0n, conversationId: 1n }, 'telegram', 'private'),
          ),
        },
        'until_delivery',
      );
      await until(() => f.typingSignals.length === 1, 'mention status shown at ingestion');
      expect(f.typingSignals[0]!.aborted).toBe(false);
      const [id] = service.processDue(new Date());
      expect((await runtime.run(id!, snapshot, new AbortController().signal)).state).toBe('completed');
      expect(f.typingSignals[0]!.aborted).toBe(true);
    } finally {
      f.host.activity.stopAll();
      f.store.close();
    }
  });

  test('model-requested typing stops before idle and restarts only when the next round requests it', async () => {
    const f = await fixture();
    const faux = fauxAgent();
    let requests = 0;
    const typingCall = () => {
      requests += 1;
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'typing', input: {} }), {
        stopReason: 'toolUse',
      });
    };
    faux.setResponses([typingCall, fauxAssistantMessage(''), typingCall, fauxAssistantMessage('')]);
    const runtime = await f.runtimeWith(faux);
    const scheduler = new BucketScheduler(
      f.store,
      f.configStore,
      (id, snapshot, signal) => runtime.run(id, snapshot, signal),
      f.conversationRuntime,
    );
    try {
      scheduler.start();
      f.ingestion.ingest(update(1, 10, 'first'), new Date());
      scheduler.wake();
      await until(() => f.typingSignals.length === 1 && f.typingSignals[0]!.aborted, 'typing stopped before idle');
      expect(requests).toBe(1);
      f.ingestion.ingest(update(2, 11, 'second'), new Date());
      scheduler.wake();
      await until(() => f.typingSignals.length === 2 && f.typingSignals[1]!.aborted, 'second round typing stopped');
      expect(requests).toBe(2);
      expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
      expect(
        f.store.db
          .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'execute' AND state = 'success'")
          .get(),
      ).toEqual({ count: 2n });
    } finally {
      await scheduler.stop(2_000);
      expect(f.typingSignals.every((signal) => signal.aborted)).toBe(true);
      f.store.close();
    }
  });

  test('a message sent while the run is active still waits its own bucket window', async () => {
    // Regression: the ingestion pace rule used to treat any message arriving
    // while an invocation was active as immediately due. That was harmless while
    // a due bucket could not be consumed before the run ended, but a long-lived
    // invocation consumes due buckets on the spot — so once a run outlived one
    // window, every single message became its own zero-length bucket and its own
    // injection (observed in production: six messages sent inside 1.4 s produced
    // six separate injections).
    //
    // This covers the message that arrives after the round ended: the agent is
    // already free, so its window runs from the message itself. A message that
    // arrives *during* a round is covered by the round-end test below.
    const fixtureSetup = await fixture((config) => {
      config.telegram.bucket_window_seconds = 1;
      // Must stay >= the bucket window, else check-config rejects the pairing.
      config.agent!.context!.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('first answer');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
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
      await until(() => requests.length === 1, 'the first model call');

      // Sent while the run is active: it must still collect a full window of its
      // own before it is injected, however long the run has been going.
      const secondIngestAt = Date.now();
      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      scheduler.wake();
      await sleep(150);

      const bucket = fixtureSetup.store.db
        .prepare<[], { id: bigint; state: string; first_received_at: string; deadline_at: string }>(
          'SELECT id, state, first_received_at, deadline_at FROM buckets ORDER BY id DESC LIMIT 1',
        )
        .get();
      if (bucket === undefined) {
        throw new Error('Expected a second bucket');
      }
      // The bucket is still collecting its own window instead of being injected a
      // few milliseconds after it was created.
      expect(bucket.state).toBe('collecting');
      const windowMilliseconds = Date.parse(bucket.deadline_at) - Date.parse(bucket.first_received_at);
      expect(windowMilliseconds).toBeGreaterThanOrEqual(1_000);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(1n);

      // It is injected once its own window closes, into the same invocation.
      await until(() => requests.length === 2, 'the second batch');
      const attachments = fixtureSetup.store.db
        .prepare<[], { invocation_id: bigint; bucket_id: bigint; injected_at: string | null }>(
          'SELECT invocation_id, bucket_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
        )
        .all();
      expect(attachments).toHaveLength(2);
      expect(attachments[0]?.invocation_id).toBe(attachments[1]?.invocation_id);
      const injectedAt = Date.parse(attachments[1]?.injected_at ?? '');
      expect(injectedAt - secondIngestAt).toBeGreaterThanOrEqual(950);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
