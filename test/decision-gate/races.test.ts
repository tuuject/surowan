import { afterEach, describe, expect, test, vi } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import { attachBucketToInvocation } from '../../src/orchestration/invocation-queue/index.ts';
import {
  answer,
  bucketRow,
  conversationIdOf,
  decisionRows,
  gate,
  groupMessage,
  internalChatId,
  invocationCount,
  resetHarness,
  settle,
  setup,
  START,
  until,
  WINDOW_MS,
  type Harness,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

/** A responder whose answer is released by the test, so a decision can be held mid-flight. */
function deferred() {
  const slots: ((response: Response) => void)[] = [];
  const responder = (): Promise<Response> =>
    new Promise<Response>((resolve) => {
      slots.push(resolve);
    });
  return {
    responder,
    release: (response: Response): void => {
      const next = slots.shift();
      if (next === undefined) {
        throw new Error('No decision request is waiting');
      }
      next(response);
    },
    pending: (): number => slots.length,
  };
}

function publish(harness: Harness, transform: (config: RawConfig) => void): void {
  const current = harness.configStore.current();
  const config = structuredClone(current.config);
  transform(config);
  harness.configStore.publish({ ...current, config, hash: `test-${Date.now()}` });
}

describe('messages arriving during a decision', () => {
  test('a drop is not applied, the batch is decided again, at most twice, then enters', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      const bucketId = first.bucketId ?? 0n;
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the first request');
      // The batch keeps collecting while the model reads it.
      harness.ingestion.ingest(groupMessage(2, 11), START);
      held.release(answer(0.1));
      await until(
        () => decisionRows(harness.store, bucketId).some((row) => row.state !== 'pending'),
        'the first verdict',
      );
      expect(decisionRows(harness.store, bucketId)).toMatchObject([{ state: 'stale', outcome: 'drop', applied: 0n }]);
      expect(bucketRow(harness.store, bucketId).state).toBe('collecting');

      harness.decisions.responder = held.responder;
      harness.scheduler.processDue(new Date());
      await until(() => held.pending() === 1, 'the second request');
      harness.ingestion.ingest(groupMessage(3, 12), START);
      held.release(answer(0.1));
      await until(
        () => decisionRows(harness.store, bucketId).filter((row) => row.state !== 'pending').length === 2,
        'the second verdict',
      );
      expect(decisionRows(harness.store, bucketId)[1]).toMatchObject({ state: 'stale', applied: 0n });

      harness.scheduler.processDue(new Date());
      await until(() => held.pending() === 1, 'the third request');
      harness.ingestion.ingest(groupMessage(4, 13), START);
      held.release(answer(0.1));
      await until(
        () => decisionRows(harness.store, bucketId).filter((row) => row.state !== 'pending').length === 3,
        'the third verdict',
      );
      // Two re-decisions were allowed; the third drop enters so the batch is not lost.
      expect(decisionRows(harness.store, bucketId)[2]).toMatchObject({
        state: 'success',
        outcome: 'enter',
        applied: 1n,
      });
      expect(harness.decisions.calls).toHaveLength(3);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(harness.decisions.calls).toHaveLength(3);
      expect(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
      ).toBe(4n);
    } finally {
      harness.store.close();
    }
  });

  test('an enter carries every message the batch received meanwhile', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      harness.ingestion.ingest(groupMessage(2, 11), START);
      held.release(answer(0.9));
      await until(
        () => decisionRows(harness.store, first.bucketId ?? 0n).some((row) => row.state !== 'pending'),
        'the verdict',
      );
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([{ outcome: 'enter', applied: 1n }]);
      harness.scheduler.processDue(new Date());
      const snapshots = harness.store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM invocation_messages WHERE section = 'new'")
        .get();
      expect(snapshots?.count).toBe(2n);
    } finally {
      harness.store.close();
    }
  });

  test('the send barrier taking the batch makes the verdict stale and leaves the batch alone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      // Exactly what the runtime's send barrier does.
      const conversationId = conversationIdOf(harness.store);
      harness.store.transaction(() => {
        harness.store.db
          .prepare(
            `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
             VALUES (900, ?, 'running', 'realtime', ?, ?, ?, ?)`,
          )
          .run(conversationId, START.toISOString(), START.toISOString(), START.toISOString(), START.toISOString());
        harness.store.db
          .prepare(
            `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
             VALUES (900, 900, ?, 'running', 'h', 1, ?)`,
          )
          .run(conversationId, START.toISOString());
        attachBucketToInvocation(harness.store, 20, 900n, first.bucketId ?? 0n, conversationId, 'telegram', new Date());
      });
      held.release(answer(0.1));
      await settle(harness);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([
        { state: 'stale', outcome: 'drop', applied: 0n },
      ]);
      expect(bucketRow(harness.store, first.bucketId ?? 0n).state).toBe('running');
    } finally {
      harness.store.close();
    }
  });
});

describe('one request per batch', () => {
  test('a second due pass never decides a batch that is still deciding', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      // Another path moving the deadline earlier must not open a second request.
      harness.store.db
        .prepare('UPDATE buckets SET deadline_at = ? WHERE id = ?')
        .run(START.toISOString(), first.bucketId ?? 0n);
      harness.scheduler.processDue(new Date());
      harness.scheduler.processDue(new Date());
      expect(harness.decisions.calls).toHaveLength(1);
      held.release(answer(0.9));
      await settle(harness);
      expect(harness.decisions.calls).toHaveLength(1);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });
});

describe('the Chat changes during a decision', () => {
  test('a paused Chat produces no Invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      harness.store.db
        .prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)')
        .run(internalChatId(harness.store), new Date().toISOString());
      held.release(answer(0.9));
      await settle(harness);
      expect(invocationCount(harness.store)).toBe(0);
      expect(bucketRow(harness.store, first.bucketId ?? 0n).state).toBe('collecting');
      harness.scheduler.processDue(new Date());
      expect(invocationCount(harness.store)).toBe(0);
    } finally {
      harness.store.close();
    }
  });

  test('a Chat removed from the configuration produces no Invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      publish(harness, (config) => {
        config.telegram.chats = [];
      });
      held.release(answer(0.9));
      await settle(harness);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([{ applied: 0n }]);
      harness.scheduler.processDue(new Date());
      expect(bucketRow(harness.store, first.bucketId ?? 0n)).toMatchObject({
        state: 'skipped_budget',
        error_code: 'chat_removed',
      });
      expect(invocationCount(harness.store)).toBe(0);
    } finally {
      harness.store.close();
    }
  });

  test('turning the gate off mid-request lets the verdict through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      publish(harness, (config) => {
        config.telegram.decision_gate = { ...config.telegram.decision_gate, enabled: false };
      });
      held.release(answer(0.1));
      await settle(harness);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([{ outcome: 'drop', applied: 0n }]);
      expect(bucketRow(harness.store, first.bucketId ?? 0n).state).toBe('collecting');
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });

  test('switching to shadow mid-request lets the verdict through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      publish(harness, (config) => {
        config.telegram.decision_gate = { ...config.telegram.decision_gate, mode: 'shadow' };
      });
      held.release(answer(0.1));
      await settle(harness);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([{ applied: 0n }]);
      harness.scheduler.processDue(new Date());
      expect(bucketRow(harness.store, first.bucketId ?? 0n).state).not.toBe('skipped_budget');
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });
});

describe('concurrency and shutdown', () => {
  test('a fifth in-flight decision enters with concurrency_limit and is not queued as a request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const CHATS = [1, 2, 3, 4, 5].map((index) => -1_001_234_500_000 - index);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: (config) => {
        config.telegram.chats = CHATS.map((id) => ({ id, instructions_file: 'chat-instructions.md' }));
      },
    });
    const held = deferred();
    harness.decisions.responder = held.responder;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const buckets: bigint[] = [];
      for (const [index, chatId] of CHATS.entries()) {
        const result = harness.ingestion.ingest(
          groupMessage(index + 1, 10 + index, { chat: { id: chatId, type: 'supergroup', title: `Group ${index}` } }),
          START,
        );
        buckets.push(result.bucketId ?? 0n);
      }
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 4, 'four in-flight requests');
      const rows = decisionRows(harness.store);
      expect(rows).toHaveLength(5);
      expect(rows.filter((row) => row.error_code === 'concurrency_limit')).toMatchObject([
        { state: 'error', outcome: 'enter', applied: 1n },
      ]);
      // The capped batch entered immediately: it opened its Invocation in this pass.
      expect(invocationCount(harness.store)).toBe(1);
      expect(bucketRow(harness.store, buckets[4] ?? 0n).state).toBe('queued');
      for (const bucketId of buckets.slice(0, 4)) {
        expect(bucketRow(harness.store, bucketId).state).toBe('collecting');
      }
      // Four answers release the rest; no second request for any of them.
      for (let index = 0; index < 4; index += 1) {
        held.release(answer(0.9));
      }
      await settle(harness);
      // Four requests were sent; the capped one never started one.
      expect(harness.decisions.calls).toHaveLength(4);
      expect(log).toBeDefined();
    } finally {
      harness.store.close();
    }
  });

  test('stopping mid-decision never hangs and writes nothing; a restart decides again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: (config) => {
        config.telegram.bucket_window_seconds = 0;
      },
    });
    harness.decisions.hang = true;
    let restarted: ReturnType<Harness['newScheduler']> | undefined;
    try {
      harness.scheduler.start();
      harness.ingestion.ingest(groupMessage(1, 10), new Date());
      harness.scheduler.wake();
      await until(() => harness.decisions.calls.length === 1, 'the request');
      const stopping = harness.scheduler.stop(1_000);
      await expect(Promise.race([stopping.then(() => 'stopped'), new Promise(() => undefined)])).resolves.toBe(
        'stopped',
      );
      expect(decisionRows(harness.store)).toMatchObject([{ state: 'pending' }]);
      await harness.scheduler.decisionsSettled();

      const reopened = await SqliteStore.open(harness.loaded.config);
      try {
        harness.decisions.hang = false;
        harness.decisions.responder = () => answer(0.9);
        restarted = harness.newScheduler({ store: reopened });
        restarted.start();
        expect(decisionRows(reopened)[0]).toMatchObject({
          state: 'error',
          error_code: 'interrupted',
          applied: 0n,
        });
        // The batch is still collecting and is decided again by the new process.
        await until(() => harness.decisions.calls.length === 2, 'the second request');
        await restarted.decisionsSettled();
        await until(
          () => decisionRows(reopened).filter((row) => row.state !== 'pending').length === 2,
          'the second verdict',
        );
        expect(decisionRows(reopened)[1]).toMatchObject({ state: 'success', outcome: 'enter', applied: 1n });
        await until(() => invocationCount(reopened) === 1, 'the queued Invocation');
      } finally {
        await restarted?.stop(1_000);
        reopened.close();
      }
    } finally {
      harness.store.close();
    }
  });
});

describe('mark hygiene', () => {
  test('a released mark of a batch that already left collecting does not survive the next pass', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: (config) => {
        config.telegram.bucket_window_seconds = 0;
      },
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      harness.scheduler.start();
      harness.ingestion.ingest(groupMessage(1, 10), new Date());
      harness.scheduler.wake();
      await until(() => invocationCount(harness.store) === 1, 'the queued Invocation');
      await until(() => decisionRows(harness.store).some((row) => row.state !== 'pending'), 'the verdict');
      harness.scheduler.wake();
      // A later message opens a new batch in the same Conversation and is decided once.
      harness.ingestion.ingest(groupMessage(2, 11), new Date());
      harness.scheduler.wake();
      await until(() => harness.decisions.calls.length === 2, 'the second request');
      await harness.scheduler.decisionsSettled();
      expect(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_decisions').get()?.count,
      ).toBe(2n);
    } finally {
      await harness.scheduler.stop(1_000);
      harness.store.close();
    }
  });
});
