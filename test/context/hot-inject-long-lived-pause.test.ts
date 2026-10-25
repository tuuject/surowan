import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupFixtureDirectories, fixture, fauxAgent, update, until } from './hot-inject-fixtures.ts';
import { sleep } from '../helpers.ts';

afterAll(cleanupFixtureDirectories);

describe('long-lived invocation', () => {
  test('a pause interrupts a run that is waiting for the next bucket', async () => {
    const fixtureSetup = await fixture();
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('idle answer');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
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
      await until(() => requests.length === 1, 'the first model call');
      // The run now sits in its idle grace (2 s). Aborting must end it right
      // away; if it did not, this test would time out waiting for the grace.
      const chatId = fixtureSetup.store.db
        .prepare<[], { chat_id: bigint }>('SELECT chat_id FROM conversations LIMIT 1')
        .get()?.chat_id;
      if (chatId === undefined) {
        throw new Error('Expected a chat');
      }
      const abortedAt = Date.now();
      scheduler.pauseChat(chatId);
      await finishedSignal;
      expect(Date.now() - abortedAt).toBeLessThan(1_500);
      expect(started).toHaveLength(1);
      expect(requests).toHaveLength(1);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('idle_grace_seconds = 0 keeps one bucket per invocation but the context persists', async () => {
    const fixtureSetup = await fixture((config) => {
      config.agent!.context!.idle_grace_seconds = 0;
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
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let secondFinished!: () => void;
    const secondFinishedSignal = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.configStore,
      async (invocationId, snapshot, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, snapshot, signal);
        if (started.length === 2) {
          secondFinished();
        }
        return outcome;
      },
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await until(() => started.length === 1 && requests.length === 1, 'the first invocation');
      await sleep(50);
      fixtureSetup.ingestion.ingest(update(2, 11, 'next'), new Date());
      scheduler.wake();
      await secondFinishedSignal;

      // Turning long-lived invocations off changes the attach behaviour only:
      // each bucket still opens its own run, and each attaches exactly one.
      expect(started).toHaveLength(2);
      for (const invocationId of started) {
        const attached = fixtureSetup.store.db
          .prepare<[bigint], { count: bigint }>(
            'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ?',
          )
          .get(invocationId);
        expect(attached?.count).toBe(1n);
      }
      // ...but the transcript is still continuous across the two runs.
      expect(requests[1]).toContain('first answer');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('nudges the batch that was drafted as private text before injecting the next one', async () => {
    // Regression: with a live idle grace the reminder used to sit behind the
    // inject and wait paths, so a batch whose draft was never sent got swallowed
    // as soon as another bucket arrived inside the grace — the model kept its
    // reply private and the chat saw nothing.
    const fixtureSetup = await fixture((config) => {
      config.agent!.send_nudge_enabled = true;
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const content = lastUser?.content;
      if (!Array.isArray(content)) {
        return typeof content === 'string' ? content : '';
      }
      return content
        .filter((block: { type: string; text?: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text ?? '')
        .join('');
    };
    faux.setResponses([
      (context) => {
        requests.push(lastUserText(context));
        // The first batch is answered as private assistant text, never sent.
        return fauxAssistantMessage('draft for the first batch');
      },
      (context) => {
        requests.push(lastUserText(context));
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published first batch' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        requests.push(lastUserText(context));
        return fauxAssistantMessage('');
      },
      (context) => {
        requests.push(lastUserText(context));
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
      fixtureSetup.ingestion.ingest(update(1, 10, 'first message'), new Date());
      scheduler.wake();
      await until(() => requests.length >= 1, 'the first model call');
      // A second bucket lands inside the grace. It must not cost the first batch
      // its reply: the reminder has to be raised before this batch is injected.
      fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
      scheduler.wake();
      await until(() => requests.some((request) => request.includes('second message')), 'the second batch');
      await sleep(50);

      expect(requests[0]).toContain('first message');
      expect(requests[1]).toContain('call the send tool');
      expect(
        fixtureSetup.store.db
          .prepare<[], { text: string }>('SELECT text FROM agent_messages')
          .all()
          .map((row) => row.text),
      ).toContain('draft for the first batch');
      const published = fixtureSetup.store.db
        .prepare<[], { arguments_json: string }>("SELECT arguments_json FROM tool_calls WHERE tool_name = 'send'")
        .all();
      expect(published).toHaveLength(1);
      expect(published[0]?.arguments_json).toContain('published first batch');
      // The reminder precedes the newer batch, so the model is told about the
      // unpublished draft while its own batch is still the newest one.
      const seqs = fixtureSetup.store.db
        .prepare<[], { seq: bigint; payload_json: string }>(
          'SELECT seq, payload_json FROM context_messages ORDER BY seq',
        )
        .all();
      const nudgeSeq = seqs.find((row) => row.payload_json.includes('call the send tool'))?.seq;
      const secondBatchSeq = seqs.find((row) => row.payload_json.includes('second message'))?.seq;
      expect(nudgeSeq).toBeDefined();
      expect(secondBatchSeq).toBeDefined();
      expect(nudgeSeq! < secondBatchSeq!).toBe(true);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
