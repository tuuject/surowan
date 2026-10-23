import { afterAll, describe, expect, test, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import type { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';

import { cleanupFixtureDirectories, fixture, fauxAgent, update, type Fixture } from './context-hot-inject-fixtures.ts';
import { sleep } from './helpers.ts';
import { SEND_BARRIER_TEXT } from '../src/capabilities/send-tool-support.ts';

afterAll(cleanupFixtureDirectories);

describe('send barrier', () => {
  type Response = Parameters<ReturnType<typeof fauxAgent>['setResponses']>[0][number];

  /**
   * Runs one invocation through the real scheduler with the barrier on. Each
   * response records the context it was called with; `during` lets a response
   * deliver a Telegram update while the model is still working on the round.
   */
  async function runWithBarrier(
    steps: ReadonlyArray<{ readonly during?: Update; readonly reply: Parameters<typeof fauxAssistantMessage>[0] }>,
    enabled = true,
    /** Runs in a forum topic with the proactive reply gate on, sampling with `random`. */
    proactive?: { readonly threadId: number; readonly random: () => number },
  ): Promise<{
    readonly fixtureSetup: Fixture;
    readonly requests: string[];
    readonly started: bigint[];
  }> {
    const fixtureSetup = await fixture((config) => {
      config.agent!.send_barrier_enabled = enabled;
      if (proactive !== undefined) {
        config.telegram.proactive_reply = { enabled: true, base_probability: 0.5, increment: 0, hard_pity: 100 };
      }
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    let scheduler!: BucketScheduler;
    const responses: Response[] = steps.map(
      (step): Response =>
        (context, options) => {
          requests.push(JSON.stringify(context.messages));
          options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
          if (step.during !== undefined) {
            fixtureSetup.ingestion.ingest(step.during, new Date());
            scheduler.wake();
          }
          const toolUse =
            Array.isArray(step.reply) || (typeof step.reply === 'object' && step.reply.type === 'toolCall');
          return fauxAssistantMessage(step.reply, toolUse ? { stopReason: 'toolUse' } : {});
        },
    );
    faux.setResponses(responses);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async (invocationId, snapshot, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, snapshot, signal);
        finished();
        return outcome;
      },
      fixtureSetup.conversationRuntime,
      undefined,
      proactive === undefined ? undefined : { bot: { id: 999n, username: 'plasticwan' }, random: proactive.random },
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello', proactive?.threadId), new Date());
      scheduler.wake();
      await finishedSignal;
      // Let the scheduler's terminal-state transaction land before asserting.
      await sleep(50);
    } finally {
      await scheduler.stop();
    }
    return { fixtureSetup, requests, started };
  }

  function sendCalls(store: SqliteStore): { state: string; error_code: string | null }[] {
    return store.db
      .prepare<[], { state: string; error_code: string | null }>(
        "SELECT state, error_code FROM tool_calls WHERE tool_name = 'send' ORDER BY id",
      )
      .all();
  }

  function botTexts(store: SqliteStore): string[] {
    return store.db
      .prepare<[], { text: string }>(
        `SELECT r.text FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id
         WHERE m.sent_by_bot = 1 ORDER BY m.id`,
      )
      .all()
      .map((row) => row.text);
  }

  test("holds the round's first send back and injects the messages that arrived meanwhile", async () => {
    const { fixtureSetup, requests, started } = await runWithBarrier([
      {
        // The follow-up lands while the model is composing its reply, and the model
        // answers in two sends in one turn: both must wait for the new batch.
        during: update(2, 11, 'second message'),
        reply: [
          fauxToolCall('send', { kind: 'text', text: 'part one' }, { id: 'call-1' }),
          fauxToolCall('send', { kind: 'text', text: 'part two' }, { id: 'call-2' }),
        ],
      },
      { reply: fauxToolCall('send', { kind: 'text', text: 'combined answer' }) },
      { reply: '' },
    ]);
    const { store } = fixtureSetup;
    try {
      expect(started).toHaveLength(1);
      expect(requests[0]).not.toContain('second message');
      // The model reads the new batch together with the reason its sends were held.
      expect(requests[1]).toContain('second message');
      expect(requests[1]).toContain(SEND_BARRIER_TEXT);
      expect(sendCalls(store)).toEqual([
        { state: 'error', error_code: 'send_barrier' },
        { state: 'error', error_code: 'send_barrier' },
        { state: 'success', error_code: null },
      ]);
      expect(botTexts(store)).toEqual(['combined answer']);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM host_sends').get()?.count).toBe(1n);
      // The follow-up joined the running invocation as its own injected batch.
      expect(
        store.db
          .prepare<[bigint], { bucket_id: bigint; injected: bigint }>(
            'SELECT bucket_id, injected_at IS NOT NULL AS injected FROM invocation_buckets WHERE invocation_id = ? ORDER BY bucket_id',
          )
          .all(started[0] ?? 0n),
      ).toEqual([
        { bucket_id: 1n, injected: 1n },
        { bucket_id: 2n, injected: 1n },
      ]);
      expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id').all()).toEqual([
        { state: 'completed' },
        { state: 'completed' },
      ]);
      // Canonical history: one checkpoint per batch, and the held-back sends are
      // recorded as tool results ahead of the second batch.
      const rows = store.db
        .prepare<[], { seq: bigint; role: string; is_checkpoint: bigint; payload_json: string }>(
          'SELECT seq, role, is_checkpoint, payload_json FROM context_messages ORDER BY seq',
        )
        .all();
      expect(rows.filter((row) => row.is_checkpoint === 1n).map((row) => row.role)).toEqual(['user', 'user']);
      const heldSeq = rows.find((row) => row.role === 'toolResult' && row.payload_json.includes('Not sent'))?.seq;
      const secondBatchSeq = rows.find(
        (row) => row.is_checkpoint === 1n && row.payload_json.includes('second message'),
      )?.seq;
      expect(heldSeq).toBeDefined();
      expect(secondBatchSeq).toBeDefined();
      expect((heldSeq ?? 0n) < (secondBatchSeq ?? 0n)).toBe(true);
    } finally {
      store.close();
    }
  }, 30_000);

  test('holds back at most one send per round', async () => {
    const { fixtureSetup, requests, started } = await runWithBarrier([
      { during: update(2, 11, 'second message'), reply: fauxToolCall('send', { kind: 'text', text: 'first try' }) },
      // Another follow-up while the model answers the combined batch: the barrier
      // is spent, so this reply goes out and the follow-up waits for the next round.
      {
        during: update(3, 12, 'third message'),
        reply: fauxToolCall('send', { kind: 'text', text: 'combined answer' }),
      },
      { reply: '' },
      { reply: fauxToolCall('send', { kind: 'text', text: 'next round answer' }) },
      { reply: '' },
    ]);
    const { store } = fixtureSetup;
    try {
      expect(started).toHaveLength(1);
      expect(sendCalls(store)).toEqual([
        { state: 'error', error_code: 'send_barrier' },
        { state: 'success', error_code: null },
        { state: 'success', error_code: null },
      ]);
      expect(botTexts(store)).toEqual(['combined answer', 'next round answer']);
      expect(requests[2]).not.toContain('third message');
      expect(requests[3]).toContain('third message');
      expect(
        store.db
          .prepare<[], { count: bigint }>(
            'SELECT COUNT(*) AS count FROM invocation_buckets WHERE injected_at IS NOT NULL',
          )
          .get()?.count,
      ).toBe(3n);
    } finally {
      store.close();
    }
  }, 30_000);

  test('a held batch rides on the chance the running invocation already won', async () => {
    // Only the opening batch may sample: it hits, and any later sample would miss.
    const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(0.99);
    const { fixtureSetup, requests, started } = await runWithBarrier(
      [
        {
          during: update(2, 11, 'second message', 100),
          reply: fauxToolCall('send', { kind: 'text', text: 'first draft' }),
        },
        { reply: fauxToolCall('send', { kind: 'text', text: 'combined answer' }) },
        { reply: '' },
      ],
      true,
      { threadId: 100, random },
    );
    const { store } = fixtureSetup;
    try {
      expect(started).toHaveLength(1);
      expect(random).toHaveBeenCalledTimes(1);
      expect(requests[1]).toContain('second message');
      expect(sendCalls(store)).toEqual([
        { state: 'error', error_code: 'send_barrier' },
        { state: 'success', error_code: null },
      ]);
      expect(
        store.db
          .prepare<[bigint], { bucket_id: bigint; injected: bigint }>(
            'SELECT bucket_id, injected_at IS NOT NULL AS injected FROM invocation_buckets WHERE invocation_id = ? ORDER BY bucket_id',
          )
          .all(started[0] ?? 0n),
      ).toEqual([
        { bucket_id: 1n, injected: 1n },
        { bucket_id: 2n, injected: 1n },
      ]);
      expect(
        store.db.prepare<[], { error_code: string | null }>('SELECT error_code FROM buckets ORDER BY id').all(),
      ).toEqual([{ error_code: null }, { error_code: null }]);
      // The opening hit reset the counter; the held batch neither sampled nor counted a miss.
      expect(
        store.db
          .prepare<[], { consecutive_misses: bigint }>('SELECT consecutive_misses FROM proactive_reply_state')
          .all(),
      ).toEqual([{ consecutive_misses: 0n }]);
    } finally {
      store.close();
    }
  }, 30_000);

  test('lets a send through when nothing new arrived', async () => {
    const { fixtureSetup, started } = await runWithBarrier([
      { reply: fauxToolCall('send', { kind: 'text', text: 'answer' }) },
      { reply: '' },
    ]);
    const { store } = fixtureSetup;
    try {
      expect(started).toHaveLength(1);
      expect(sendCalls(store)).toEqual([{ state: 'success', error_code: null }]);
      expect(
        store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()?.count,
      ).toBe(1n);
    } finally {
      store.close();
    }
  }, 30_000);

  test('stays out of the way when disabled', async () => {
    const { fixtureSetup, requests } = await runWithBarrier(
      [
        {
          during: update(2, 11, 'second message'),
          reply: fauxToolCall('send', { kind: 'text', text: 'first answer' }),
        },
        { reply: '' },
        { reply: fauxToolCall('send', { kind: 'text', text: 'second answer' }) },
        { reply: '' },
      ],
      false,
    );
    const { store } = fixtureSetup;
    try {
      expect(sendCalls(store)).toEqual([
        { state: 'success', error_code: null },
        { state: 'success', error_code: null },
      ]);
      expect(botTexts(store)).toEqual(['first answer', 'second answer']);
      expect(requests[1]).not.toContain('second message');
      expect(requests[2]).toContain('second message');
    } finally {
      store.close();
    }
  }, 30_000);
});
