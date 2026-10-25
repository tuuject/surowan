import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import {
  cleanupFixtureDirectories,
  fixture,
  fauxAgent,
  update,
  SEND_MESSAGE_ID,
  withoutIdleWait,
} from './hot-inject-fixtures.ts';

afterAll(cleanupFixtureDirectories);

describe('conversation continuity', () => {
  test('every batch of a cache-reusing run anchors its references at its own row', async () => {
    // Regression: one Context had two header objects. The writers used the header
    // stored on the cached agent, while the injection path and the capability
    // resolver used the handle from `open()`, which never advanced. From the second
    // invocation of a Conversation on, every batch after the first recorded the
    // run's opening `next_seq` as the `source_seq` of its media and reply
    // references, so a later GC revoked them one collection too early even though
    // their message was still retained. Observed in production as a frozen `seq` in
    // `context_injected`: seven batches of one run all reported the same number.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    faux.setResponses([
      () => fauxAssistantMessage('first answer'),
      () => fauxAssistantMessage('second answer'),
      () => fauxAssistantMessage('third answer'),
    ]);
    const runtime = await fixtureSetup.runtimeWith(faux);
    // The real runtime is the attachment target, so the queued batch reaches the
    // run through the same path production uses.
    const service = new InvocationQueueService(
      fixtureSetup.store,
      fixtureSetup.configStore,
      fixtureSetup.conversationRuntime,
    );
    try {
      // Run one builds the cached agent.
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = service.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(first);
      await runtime.run(first, fixtureSetup.configStore.beginInvocation(), new AbortController().signal);
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);

      // Run two reuses it, and takes two batches: its opening bucket and one attach.
      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = service.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(second);
      fixtureSetup.ingestion.ingest(update(3, 12, 'third'), new Date());
      expect(service.processDue(new Date())).toHaveLength(0);
      const conversationId = fixtureSetup.store.db
        .prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      expect(fixtureSetup.conversationRuntime.hasPendingInjections(conversationId)).toBe(true);

      const outcome = await runtime.run(
        second,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });

      // Each batch's reply reference points at the row that batch occupies, so the
      // two batches of run two do not share one anchor.
      const refs = new Map(
        fixtureSetup.store.db
          .prepare<[], { ref: string; source_seq: bigint }>(
            "SELECT ref, source_seq FROM context_refs WHERE kind = 'reply'",
          )
          .all()
          .map((row) => [row.ref, row.source_seq] as const),
      );
      const openingSeq = refs.get('reply:11');
      const attachedSeq = refs.get('reply:12');
      expect(openingSeq).toBeDefined();
      expect(attachedSeq).toBeDefined();
      expect(attachedSeq! > openingSeq!).toBe(true);
      // Stronger than "it moved": the anchor is the sequence number of the user row
      // that actually carries the batch.
      const userRows = fixtureSetup.store.db
        .prepare<[], { seq: bigint; payload_json: string }>(
          "SELECT seq, payload_json FROM context_messages WHERE role = 'user' ORDER BY seq",
        )
        .all();
      const rowCarrying = (messageId: string): bigint | undefined =>
        userRows.find((row) => row.payload_json.includes(`\\n[${messageId} `))?.seq;
      expect(openingSeq).toBe(rowCarrying('11'));
      expect(attachedSeq).toBe(rowCarrying('12'));
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a later invocation replays the earlier transcript instead of re-rendering history', async () => {
    const fixtureSetup = await fixture((config) => {
      withoutIdleWait(config);
      config.developer = { record_model_payloads: true };
    });
    const faux = fauxAgent();
    // Each invocation in this test needs its own call the way the loop drives
    // them: the opening answer, its closing turn, then one turn per later run.
    faux.setResponses([
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('second answer');
      },
      (context, options) => {
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
      for (const [index, text] of ['first', 'second', 'third'].entries()) {
        fixtureSetup.ingestion.ingest(update(index + 1, 10 + index, text), new Date());
        const [invocationId] = scheduler.processDue(new Date());
        if (invocationId === undefined) {
          throw new Error(`Expected invocation ${index + 1}`);
        }
        const outcome = await runtime.run(
          invocationId,
          fixtureSetup.configStore.beginInvocation(),
          new AbortController().signal,
        );
        expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
        fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
        fixtureSetup.store.db
          .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
          .run(invocationId);
      }

      const requests = fixtureSetup.store.db
        .prepare<[], { request_json: string | null }>(
          "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id",
        )
        .all();
      // Four calls: the opening answer plus its closing turn, then one turn for
      // each of the two later invocations.
      expect(requests).toHaveLength(4);
      const latest = JSON.parse(requests[3]?.request_json ?? '{}') as {
        messages: { role: string; content: unknown }[];
      };
      const latestUser = [...latest.messages].reverse().find((message) => message.role === 'user');
      const latestText =
        (latestUser?.content as { type: string; text?: string }[] | undefined)
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n') ?? '';
      // The newest batch carries only the new message: everything the transcript
      // already holds is not re-rendered as history.
      expect(latestText).toContain('\n[12 ');
      expect(latestText).not.toContain('\n[10 ');
      expect(latestText).not.toContain('\n[900 ');
      // The earlier turns — the first answer and its send result included —
      // travel as transcript entries instead of a re-rendered history block.
      const transcript = JSON.stringify(latest.messages);
      expect(transcript).toContain('first answer');
      expect(transcript).toContain(`Sent Telegram message ${SEND_MESSAGE_ID}`);
      expect(transcript).toContain('second answer');
      const head = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; next_seq: bigint }>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      // Nothing was collected, so the whole history stays inside the window.
      expect(head?.head_seq).toBe(1n);
      expect(
        fixtureSetup.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()
          ?.count,
      ).toBe((head?.next_seq ?? 0n) - 1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
