/**
 * The Invocation detail's batch projection, from a real long-lived run: the
 * Overview groups messages by `source_bucket_id` and the model's work by
 * `buckets[].injected_at`, so both must come out of the runtime as recorded,
 * and the live fingerprint must move when a batch is read.
 */
import { afterAll, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { getInvocation } from '../../src/ingress/admin/audit/invocation-detail.ts';
import { invocationLiveFingerprint } from '../../src/ingress/admin/audit/invocation-live.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupFixtureDirectories, fauxAgent, fixture, update } from '../context/hot-inject-fixtures.ts';
import { sleep } from '../helpers.ts';

afterAll(cleanupFixtureDirectories);

interface DetailView {
  readonly bucket_id: string;
  readonly buckets: readonly { bucket_id: string; attached_at: string; injected_at: string | null }[];
  readonly context_messages: readonly { section: string; source_bucket_id: string | null; snapshot_json: string }[];
  readonly model_calls: readonly { created_at: string }[];
  readonly tool_calls: readonly { tool_name: string; created_at: string }[];
}

test('a batch attached mid-run is listed with its injection time and owns its messages', async () => {
  const setup = await fixture();
  const faux = fauxAgent();
  faux.setResponses([
    async (context, options) => {
      options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
      setup.ingestion.ingest(update(2, 11, 'second message'), new Date());
      scheduler.wake();
      await sleep(200);
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
      return fauxAssistantMessage('');
    },
  ]);
  const runtime = await setup.runtimeWith(faux);
  const started: bigint[] = [];
  let finished!: () => void;
  const finishedSignal = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const scheduler = new BucketScheduler(
    setup.store,
    setup.configStore,
    async (invocationId, snapshot, signal) => {
      started.push(invocationId);
      const outcome = await runtime.run(invocationId, snapshot, signal);
      finished();
      return outcome;
    },
    setup.conversationRuntime,
  );
  try {
    scheduler.start();
    setup.ingestion.ingest(update(1, 10, 'hello'), new Date());
    scheduler.wake();
    await finishedSignal;
    await sleep(50);

    const [invocationId] = started;
    expect(started).toHaveLength(1);
    const detail = getInvocation(setup.store.orm, invocationId as bigint) as unknown as DetailView;

    // Opening batch first, then the attached one; both read, in that order.
    expect(detail.buckets).toHaveLength(2);
    const [opening, attached] = detail.buckets;
    expect(opening?.bucket_id).toBe(detail.bucket_id);
    expect(attached?.bucket_id).not.toBe(detail.bucket_id);
    expect(typeof opening?.injected_at).toBe('string');
    expect(typeof attached?.injected_at).toBe('string');
    expect(Date.parse(attached?.injected_at ?? '')).toBeGreaterThan(Date.parse(opening?.injected_at ?? ''));

    // Each new message names the batch it arrived in; ids stay strings.
    const sources = detail.context_messages
      .filter((message) => message.section === 'new')
      .map((message) => [(JSON.parse(message.snapshot_json) as { text: string }).text, message.source_bucket_id]);
    expect(sources).toEqual([
      ['hello', opening?.bucket_id],
      ['second message', attached?.bucket_id],
    ]);

    // The reply to the first batch precedes the second injection and the model
    // call that read the second batch follows it: grouping by time is sound.
    const injectedSecond = Date.parse(attached?.injected_at ?? '');
    const send = detail.tool_calls.find((call) => call.tool_name === 'send');
    expect(Date.parse(send?.created_at ?? '')).toBeLessThanOrEqual(injectedSecond);
    expect(Date.parse(detail.model_calls.at(-1)?.created_at ?? '')).toBeGreaterThanOrEqual(injectedSecond);

    // Reading a batch alone changes what the detail page shows, so it must
    // change the live fingerprint too.
    const before = invocationLiveFingerprint(setup.store.orm, invocationId as bigint);
    setup.store.db
      .prepare('UPDATE invocation_buckets SET injected_at = NULL WHERE invocation_id = ? AND bucket_id = ?')
      .run(invocationId, BigInt(attached?.bucket_id ?? '0'));
    expect(invocationLiveFingerprint(setup.store.orm, invocationId as bigint)).not.toBe(before);
    expect(
      (getInvocation(setup.store.orm, invocationId as bigint) as unknown as DetailView).buckets[1]?.injected_at,
    ).toBeNull();
  } finally {
    await scheduler.stop();
    setup.store.close();
  }
}, 30_000);
