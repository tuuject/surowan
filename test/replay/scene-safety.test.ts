import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { expect, test } from 'vitest';
import { invocationGateKey } from '../../src/platform/invocation-policy.ts';
import { media } from '../../src/store/schema/index.ts';
import { HISTORY_MEDIA, definition, fixture, messageText, sceneRegistry } from './fixtures.ts';

test('scene image reads and reply targets are isolated, with text-only and retention degradation', async () => {
  const loaded: bigint[] = [];
  const registry = () => ({
    ...sceneRegistry(),
    capabilities: [
      ...sceneRegistry().capabilities,
      definition('read_image', Type.Object({ image_ref: Type.String() }, { additionalProperties: false })),
    ],
  });
  const f = await fixture({
    images: true,
    definitions: registry,
    imageLoader: async (id, signal) => {
      signal.throwIfAborted();
      loaded.push(id);
      return { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    },
  });
  let ref = '';
  f.faux.setResponses([
    (context) => {
      ref = messageText(context).match(/img_[a-f0-9]+/)![0];
      expect(messageText(context)).not.toContain('file_history_seed');
      return fauxAssistantMessage(
        [
          fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: ref } }),
          fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: 'img_foreign' } }),
          fauxToolCall('send', { text: 'valid reply', reply_to_message_id: '880' }),
          fauxToolCall('send', { text: 'invisible reply', reply_to_message_id: '999' }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('aW1hZ2U=');
      return fauxAssistantMessage('done');
    },
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result).toMatchObject({ error: null, send_count: 1, fidelity: { omitted_images: 0 } });
  expect(loaded).toEqual([HISTORY_MEDIA]);
  expect(result.tool_calls.map((call) => call.is_error)).toEqual([false, true, false, true]);
  expect(f.rows()).toEqual(before);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'read_image', input: { image_ref: ref } }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('done'),
  ]);
  const next = await f.run();
  expect(next.tool_calls[0]?.is_error).toBe(true); // previous scene reference expired
  expect(loaded).toEqual([HISTORY_MEDIA]);
  const textOnly = await fixture({
    definitions: registry,
    imageLoader: async () => {
      throw new Error('must not load');
    },
  });
  textOnly.faux.setResponses([
    (context) => {
      expect(messageText(context)).not.toMatch(/img_[a-f0-9]+/);
      return fauxAssistantMessage('done');
    },
  ]);
  expect(await textOnly.run()).toMatchObject({ error: null, fidelity: { omitted_images: 1 } });
  f.store.orm.delete(media).where(eq(media.id, HISTORY_MEDIA)).run();
  f.faux.setResponses([
    (context) => {
      expect(messageText(context)).not.toMatch(/img_[a-f0-9]+/);
      return fauxAssistantMessage('done');
    },
  ]);
  expect(await f.run()).toMatchObject({ error: null });
});

test('failed scene image loading degrades to a redacted tool error without production writes', async () => {
  const f = await fixture({
    images: true,
    definitions: () => ({
      ...sceneRegistry(),
      capabilities: [definition('read_image', Type.Object({ image_ref: Type.String() }))],
    }),
    imageLoader: async () => {
      throw new Error('download failed with replay-secret-fixture');
    },
  });
  f.secrets.remember('replay-secret-fixture');
  f.faux.setResponses([
    (context) =>
      fauxAssistantMessage(
        fauxToolCall('execute', {
          action: 'call',
          tool: 'read_image',
          input: { image_ref: messageText(context).match(/img_[a-f0-9]+/)![0] },
        }),
        { stopReason: 'toolUse' },
      ),
    fauxAssistantMessage('cannot see the image'),
  ]);
  const before = f.rows();
  const result = await f.run();
  expect(result.error).toBeNull();
  expect(result.tool_calls[0]?.is_error).toBe(true);
  expect(JSON.stringify(result.tool_calls)).toContain('download failed');
  expect(JSON.stringify(result)).not.toContain('replay-secret-fixture');
  expect(f.rows()).toEqual(before);
});

test('scene replay shares the live model gate, rejects concurrent runs and releases its lock on cancellation', async () => {
  const f = await fixture();
  const release = await f.gate.acquire(invocationGateKey('telegram', 123456789n), new AbortController().signal);
  const request = new AbortController();
  const pending = f.run({}, request.signal);
  await expect(f.run()).rejects.toMatchObject({ code: 'replay_busy', status: 429 });
  request.abort();
  expect(await pending).toMatchObject({ error: { code: 'aborted' }, usage: { model_calls: 0 } });
  release();
  f.faux.setResponses([fauxAssistantMessage('after abort')]);
  expect(await f.run()).toMatchObject({ error: null, usage: { model_calls: 1 } });
  const controller = new AbortController();
  controller.abort();
  expect(await f.run({}, controller.signal)).toMatchObject({ error: { code: 'aborted' } });
});

test('shutdown cancels an in-flight model request without writes and model errors are redacted', async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_context, options) => {
      started.resolve();
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return fauxAssistantMessage('cancelled', { stopReason: 'aborted' });
    },
  ]);
  const before = f.rows();
  const pending = f.run();
  await started.promise;
  f.shutdown.abort();
  expect(await pending).toMatchObject({ error: { code: 'aborted' } });
  expect(f.rows()).toEqual(before);

  const g = await fixture();
  g.secrets.remember('fixture-private-secret');
  g.faux.setResponses([
    () => {
      throw new Error('fixture-private-secret');
    },
  ]);
  const failed = await g.run();
  expect(failed.error).not.toBeNull();
  expect(JSON.stringify(failed)).not.toContain('fixture-private-secret');
});

test('configured wall-clock limit covers waiting for a model slot', async () => {
  const f = await fixture({ change: (config) => (config.agent!.context!.max_wall_clock_seconds = 1) });
  const release = await f.gate.acquire(invocationGateKey('telegram', 123456789n), new AbortController().signal);
  try {
    expect(await f.run()).toMatchObject({ error: { code: 'timeout' }, usage: { model_calls: 0 } });
  } finally {
    release();
  }
});

test('context, turn and tool budgets stop the loop, including malformed unknown tool calls', async () => {
  const tiny = await fixture({ contextWindow: 256 });
  expect(await tiny.run()).toMatchObject({ error: { code: 'context_limit' }, usage: { model_calls: 0 } });

  const f = await fixture({ change: (config) => (config.agent!.rate_limits!.turns_per_injection = 1) });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('send', { text: 'once' }), { stopReason: 'toolUse' })]);
  expect(await f.run()).toMatchObject({ error: { code: 'turn_budget' }, send_count: 1, usage: { model_calls: 1 } });

  const g = await fixture();
  g.faux.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 150 }, () => fauxToolCall('not_registered', {})),
      { stopReason: 'toolUse' },
    ),
  ]);
  const bounded = await g.run();
  expect(bounded.error?.code).toBe('tool_budget');
  expect(bounded.tool_calls.length).toBeLessThanOrEqual(128);
  expect(bounded.usage.model_calls).toBe(1);
});

test('trace bounds stop before oversized arguments can be retained or synthetic sends executed', async () => {
  const f = await fixture();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('send', { text: 'x'.repeat(1_100_000) }), { stopReason: 'toolUse' }),
  ]);
  const result = await f.run();
  expect(result.error?.code).toBe('trace_limit');
  expect(result.send_count).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_100_000);
});

test('redaction covers arbitrary argument property names and dispatch metadata, not just text', async () => {
  const f = await fixture();
  const key = 'fixture-private-secret';
  f.secrets.remember(key);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('not_registered', { [key]: key }),
        fauxToolCall('execute', { action: 'call', tool: key, input: {} }),
        fauxToolCall('send', { text: `quoted ${key}` }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('done'),
  ]);
  const result = await f.run();
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.send_count).toBe(1);
});

test('successful sleep terminates the replay without producing a real sleep record', async () => {
  const f = await fixture();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' })]);
  const before = f.rows();
  expect(await f.run()).toMatchObject({
    error: null,
    completion_reason: 'sleep',
    usage: { model_calls: 1 },
    send_count: 0,
  });
  expect(f.rows()).toEqual(before);
});

test('an unchanged failing call repeated for three turns ends the replay like production', async () => {
  const f = await fixture();
  f.faux.setResponses(
    Array.from({ length: 5 }, () =>
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'again', resend: true }), {
        stopReason: 'toolUse',
      }),
    ),
  );
  expect(await f.run()).toMatchObject({
    error: null,
    completion_reason: 'repeated_tool_failure',
    usage: { model_calls: 3 },
    send_count: 0,
  });
});

test('more than three duplicate sends end the replay like production', async () => {
  const f = await fixture();
  f.faux.setResponses(
    ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'].map((text) =>
      fauxAssistantMessage(fauxToolCall('send', { text }), { stopReason: 'toolUse' }),
    ),
  );
  expect(await f.run()).toMatchObject({
    error: null,
    completion_reason: 'duplicate_send',
    usage: { model_calls: 6 },
    send_count: 2,
  });
});
