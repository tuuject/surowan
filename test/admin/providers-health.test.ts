import { expect, test, vi } from 'vitest';
import { modelCalls } from '../../src/store/schema/index.ts';
import {
  HEALTH_PATH,
  HEALTH_TARGET,
  adminFixture,
  call,
  healthMessage,
  installAdminProviderHooks,
  readJson,
  revisionOf,
  write,
} from './providers-fixtures.ts';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';

installAdminProviderHooks();

test('checks a real streaming provider with one fixed prompt and audits usage without changing configuration', async () => {
  let requests = 0;
  const finishBody = Promise.withResolvers<void>();
  const receivedRequest = Promise.withResolvers<{ request: Request; body: Record<string, unknown> }>();
  const upstream = await startFixtureServer(async (incoming) => {
    requests += 1;
    const body = (await incoming.json()) as Record<string, unknown>;
    receivedRequest.resolve({ request: incoming, body });
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'data: {"id":"health","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
            ),
          );
          await finishBody.promise;
          controller.enqueue(
            encoder.encode(
              'data: {"id":"health","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = `http://127.0.0.1:${upstream.port}/v1`;
        provider.api = 'openai-completions';
        provider.models[0]!.reasoning = false;
        provider.models[0]!.max_tokens = 64;
        config.agent!.thinking_level = 'off';
        config.developer = { record_model_payloads: true };
      }
    },
  });
  const registry = fixture.configStore.current().models;
  const original = registry.completeSimple.bind(registry);
  const receivedHeaders = Promise.withResolvers<void>();
  const probe = vi.spyOn(registry, 'completeSimple').mockImplementation((model, context, options) =>
    original(model, context, {
      ...options,
      onResponse: (response, selected) => {
        options?.onResponse?.(response, selected);
        receivedHeaders.resolve();
      },
    }),
  );
  try {
    const before = await fixture.read();
    const pending = write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET);
    await Promise.race([
      receivedHeaders.promise,
      pending.then(async (response) => {
        throw new Error(
          `Health check finished before response headers: ${JSON.stringify(await readJson(response.clone()))}`,
        );
      }),
    ]);
    // The header is observable before the stream finishes, never total latency.
    expect(fixture.store.orm.select().from(modelCalls).get()?.state).toBe('pending');
    finishBody.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    const result = await readJson(response);
    expect(result).toMatchObject({ ...HEALTH_TARGET, status: 'ok', response_text: 'ok', error: null });
    expect(result.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(result.ttfb_ms);
    expect(requests).toBe(1);
    const received = await receivedRequest.promise;
    expect(new URL(received.request.url).pathname).toBe('/v1/chat/completions');
    expect(received.request.headers.get('authorization')).toBe('Bearer agent-secret');
    expect(received.request.headers.get('x-route')).toBe('header-secret-value');
    expect(received.body.model).toBe('agent-model');
    expect(received.body.messages).toEqual([{ role: 'user', content: 'reply with extract content: ok' }]);
    expect(received.body.tools).toBeUndefined();
    expect(received.body.max_tokens ?? received.body.max_completion_tokens).toBe(64);
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current().generation).toBe(1);
    expect(fixture.store.orm.select().from(modelCalls).get()).toMatchObject({
      role: 'doctor',
      state: 'success',
      invocationId: null,
      toolsJson: '[]',
      totalTokens: 10n,
      requestJson: null,
      responseJson: null,
      errorCode: null,
    });
  } finally {
    finishBody.resolve();
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('reports mismatched, empty, truncated and redacted failures independently, and leaves absent TTFB null', async () => {
  let requests = 0;
  const upstream = await startFixtureServer(() => {
    requests += 1;
    return Response.json({ error: { message: 'bad credentials agent-secret header-secret-value' } }, { status: 503 });
  });
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = `http://127.0.0.1:${upstream.port}/v1`;
        provider.api = 'openai-completions';
      }
    },
  });
  const registry = fixture.configStore.current().models;
  try {
    const failed = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('[REDACTED]');
    expect(JSON.stringify(failed)).not.toMatch(/agent-secret|header-secret-value/);
    expect(requests).toBe(1);
    const probe = vi.spyOn(registry, 'completeSimple');
    try {
      for (const [text, stopReason, status] of [
        [' OK ', 'stop', 'unexpected_response'],
        ['  ', 'stop', 'error'],
        ['ok', 'length', 'error'],
        ['agent-secret', 'stop', 'unexpected_response'],
        [' ok\n', 'stop', 'ok'],
      ] as const) {
        probe.mockResolvedValueOnce(healthMessage(text, stopReason));
        const result = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
        expect(result.status).toBe(status);
        expect(result.ttfb_ms).toBeNull();
        expect(result.response_text).not.toContain('agent-secret');
      }
    } finally {
      probe.mockRestore();
    }
    const audit = fixture.store.orm.select().from(modelCalls).all();
    expect(audit.map((row) => row.state)).toEqual(['error', 'error', 'error', 'error', 'error', 'success']);
    expect(audit.every((row) => row.finishedAt !== null)).toBe(true);
    expect(JSON.stringify(audit, (_key, value) => (typeof value === 'bigint' ? String(value) : value))).not.toMatch(
      /agent-secret|header-secret-value/,
    );
  } finally {
    fixture.store.close();
    await stopFixtureServer(upstream.server);
  }
});

test('the health-check route does not shadow edits to a provider with that alias', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers['health-check'] = structuredClone(config.providers.vision!);
    },
  });
  try {
    const updated = await write(
      fixture,
      HEALTH_PATH,
      'PUT',
      { api_key: 'replacement-fixture-key' },
      await revisionOf(fixture),
    );
    expect(updated.status).toBe(200);
    expect(fixture.secret(fixture.file().providers['health-check']?.api_key)).toBe('replacement-fixture-key');
    const deleted = await call(fixture, HEALTH_PATH, {
      method: 'DELETE',
      headers: { 'if-match': await revisionOf(fixture) },
    });
    expect(deleted.status).toBe(200);
    expect(fixture.file().providers['health-check']).toBeUndefined();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    fixture.store.close();
  }
});
