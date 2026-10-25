import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, until } from './hot-inject-fixtures.ts';
import { sleep } from '../helpers.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test('keeps a batch collecting while the round runs instead of attaching it mid-round', async () => {
    const fixtureSetup = await fixture();
    const faux = fauxAgent();
    const requests: string[] = [];
    // A batch whose window closes while the model is still working on its round
    // must keep collecting: the agent is not free, so the batch's window has not
    // started yet. Handing it over mid-round would inject a batch that collected
    // almost nothing (and is exactly what the round-end anchor prevents).
    let collectingDuringRound = 0n;
    let attachedDuringRound = 0n;
    faux.setResponses([
      async (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
        scheduler.wake();
        await sleep(200);
        collectingDuringRound =
          fixtureSetup.store.db
            .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM buckets WHERE state = 'collecting'")
            .get()?.count ?? 0n;
        attachedDuringRound =
          fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
            ?.count ?? 0n;
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async (invocationId, snapshot, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, snapshot, signal);
        finished();
        return outcome;
      },
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await finishedSignal;
      // Let the scheduler's terminal-state transaction land before asserting.
      await sleep(50);

      // The batch stayed out of the run for the whole round, then joined it once
      // the agent was free again: exactly one invocation, one batch per round.
      expect(collectingDuringRound).toBe(1n);
      expect(attachedDuringRound).toBe(1n);
      expect(started).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(requests[1]).not.toContain('second message');
      expect(requests[2]).toContain('second message');
      const attached2 = fixtureSetup.store.db
        .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets')
        .get();
      expect(attached2?.count).toBe(2n);
      expect(
        fixtureSetup.store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id').all(),
      ).toEqual([{ state: 'completed' }, { state: 'completed' }]);
      const head = fixtureSetup.store.db
        .prepare<[], { is_checkpoint: bigint; role: string }>(
          'SELECT is_checkpoint, role FROM context_messages ORDER BY seq',
        )
        .all()
        .filter((row) => row.is_checkpoint === 1n);
      // One checkpoint per injected batch, always on the batch's user message.
      expect(head).toEqual([
        { is_checkpoint: 1n, role: 'user' },
        { is_checkpoint: 1n, role: 'user' },
      ]);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a batch that collects during a round is injected one window after that round ends', async () => {
    // The collection window is anchored at the moment the agent becomes free
    // again, not at the batch's own first message: messages arriving while a round
    // runs are gathered into one batch whose window starts at the round end, so a
    // quick reply never cuts the conversation into two batches.
    const fixtureSetup = await fixture((config) => {
      config.telegram.bucket_window_seconds = 1;
      config.agent!.context!.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    let roundEnd = 0;
    let injectedAt = 0;
    let collectingDuringRound = '';
    faux.setResponses([
      async (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
        scheduler.wake();
        // The round outlives the batch's own window, so a batch handed over on
        // its own deadline would be injected while the model is still working.
        await sleep(1_500);
        collectingDuringRound =
          fixtureSetup.store.db
            .prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1')
            .get()?.state ?? '';
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        // A turn without tool calls ends the round: the agent is free from this
        // instant, which is where the pending batch's window starts.
        roundEnd = Date.now();
        return fauxAssistantMessage('');
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async (invocationId, snapshot, signal) => {
        const poll = setInterval(recordInjection, 25);
        try {
          const outcome = await runtime.run(invocationId, snapshot, signal);
          finished();
          return outcome;
        } finally {
          clearInterval(poll);
        }
      },
      fixtureSetup.conversationRuntime,
    );
    function recordInjection(): void {
      const row = fixtureSetup.store.db
        .prepare<[], { injected_at: string | null }>(
          'SELECT injected_at FROM invocation_buckets ORDER BY bucket_id DESC LIMIT 1',
        )
        .get();
      if (row?.injected_at !== null && row?.injected_at !== undefined) {
        injectedAt = Date.parse(row.injected_at);
      }
    }
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await finishedSignal;
      await sleep(50);

      // The window restarted at the round end, so the batch waited out a full
      // window from there: without the round-end anchor it would have been
      // injected on its own deadline, which fell mid-round.
      expect(roundEnd).toBeGreaterThan(0);
      expect(collectingDuringRound).toBe('collecting');
      expect(injectedAt).toBeGreaterThan(0);
      expect(injectedAt - roundEnd).toBeGreaterThanOrEqual(900);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count,
      ).toBe(1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('does not pay the idle grace between the steps of one round', async () => {
    // Regression: the grace used to be awaited after *every* turn, so a round
    // that called send twice waited out the grace twice (and a batch injected
    // while the model was working waited before being answered). The grace
    // belongs to the end of a round, where the run would otherwise stop.
    const fixtureSetup = await fixture((config) => {
      config.agent!.context!.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    const callTimes: number[] = [];
    faux.setResponses([
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first' }), { stopReason: 'toolUse' });
      },
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'second' }), { stopReason: 'toolUse' });
      },
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage('');
      },
      () => fauxAssistantMessage(''),
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
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await until(() => callTimes.length === 3, 'the third model call');
      // Step two followed step one immediately: nothing was pending, so there was
      // nothing to wait for.
      expect((callTimes[1] ?? 0) - (callTimes[0] ?? 0)).toBeLessThan(1_500);
      expect((callTimes[2] ?? 0) - (callTimes[1] ?? 0)).toBeLessThan(1_500);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
