import { writeFile } from 'node:fs/promises';
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
  request,
  rewriteFile,
  write,
} from './providers-fixtures.ts';

installAdminProviderHooks();

test('health checks reject unauthorized, invalid and unapplied targets before calling a model', async () => {
  const fixture = await adminFixture();
  const probe = vi.spyOn(fixture.configStore.current().models, 'completeSimple');
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(HEALTH_TARGET),
    };
    expect((await fixture.server.handle(request(HEALTH_PATH, init))).status).toBe(401);
    expect(
      (await call(fixture, HEALTH_PATH, { ...init, headers: { ...init.headers, origin: 'https://evil.example' } }))
        .status,
    ).toBe(403);
    const key = await readJson(await write(fixture, '/api/api-keys', 'POST', { name: 'health-test' }));
    expect(
      (await call(fixture, HEALTH_PATH, { ...init, headers: { ...init.headers, authorization: `Bearer ${key.key}` } }))
        .status,
    ).toBe(403);
    for (const body of [
      {},
      { ...HEALTH_TARGET, prompt: 'different' },
      { ...HEALTH_TARGET, base_url: 'http://evil.example' },
    ]) {
      expect((await write(fixture, HEALTH_PATH, 'POST', body)).status).toBe(400);
    }
    expect((await call(fixture, HEALTH_PATH)).status).toBe(405);
    expect((await write(fixture, HEALTH_PATH, 'POST', { ...HEALTH_TARGET, model: 'missing' })).status).toBe(404);
    await rewriteFile(fixture, (config) => {
      config.providers.agent!.models[0]!.max_tokens -= 1;
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({
      error: 'model_not_applied',
    });
    await rewriteFile(fixture, (config) => {
      const provider = config.providers.agent!;
      if (provider.kind === 'custom') {
        provider.base_url = 'https://evil.example/v1';
      }
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({
      error: 'connection_not_applied',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    probe.mockRestore();
    fixture.store.close();
  }
});

test('rejects image-only health targets and broken saved configuration without an upstream request', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.vision!.models[0]!.input = ['image'];
    },
  });
  const probe = vi.spyOn(fixture.configStore.current().models, 'completeSimple');
  try {
    const response = await write(fixture, HEALTH_PATH, 'POST', { provider: 'vision', model: 'vision-model' });
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ error: 'not_text_capable' });
    await writeFile(fixture.configPath, 'not json');
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
    expect(fixture.store.orm.select().from(modelCalls).all()).toHaveLength(0);
  } finally {
    probe.mockRestore();
    fixture.store.close();
  }
});

test('health checks cancel on request abort, release their slot, and bound redacted output', async () => {
  const fixture = await adminFixture();
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  let adapterSignal: AbortSignal | undefined;
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementationOnce((_model, _context, options) => {
      adapterSignal = options?.signal;
      started.resolve();
      return new Promise(() => {});
    });
  try {
    const pending = call(fixture, HEALTH_PATH, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(HEALTH_TARGET),
    });
    await started.promise;
    controller.abort(new Error('Client left agent-secret'));
    expect(await readJson(await pending)).toMatchObject({ status: 'error', error: 'Client left [REDACTED]' });
    expect(adapterSignal?.aborted).toBe(true);
    probe.mockResolvedValueOnce(healthMessage(`header-secret-value${'a'.repeat(5000)}`));
    const long = await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    expect(long.response_text).toHaveLength(4096);
    expect(long.response_text).toMatch(/^\[REDACTED\]/);
    probe.mockResolvedValueOnce({
      ...healthMessage(),
      content: [{ type: 'toolCall', id: 'bad-call', name: 'send', arguments: {} }],
      stopReason: 'toolUse',
    });
    expect(await readJson(await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET))).toMatchObject({ status: 'error' });
    expect(
      fixture.store.orm
        .select()
        .from(modelCalls)
        .all()
        .every((row) => row.state === 'error' && row.finishedAt !== null),
    ).toBe(true);
  } finally {
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
  }
});

test('health checks time out and audit completion even if an adapter ignores cancellation', async () => {
  const fixture = await adminFixture();
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      expect(options).toMatchObject({ maxTokens: 128, maxRetries: 0, timeoutMs: 30_000 });
      started.resolve();
      return new Promise(() => {});
    });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET);
    await started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await readJson(await pending);
    expect(result).toMatchObject({ status: 'error', ttfb_ms: null, response_text: '' });
    expect(result.error).toContain('timed out');
    expect(signal?.aborted).toBe(true);
    expect(fixture.store.orm.select().from(modelCalls).get()).toMatchObject({
      state: 'error',
      errorCode: 'model_health_error',
    });
  } finally {
    vi.useRealTimers();
    probe.mockRestore();
    fixture.store.close();
  }
});

test('limits simultaneous health checks and cancels and drains them before Admin shutdown', async () => {
  const fixture = await adminFixture();
  const signals: AbortSignal[] = [];
  const started = Promise.withResolvers<void>();
  const probe = vi
    .spyOn(fixture.configStore.current().models, 'completeSimple')
    .mockImplementation((_model, _context, options) => {
      signals.push(options!.signal!);
      if (signals.length === 3) {
        started.resolve();
      }
      return new Promise(() => {});
    });
  try {
    const pending = Array.from({ length: 3 }, () => write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET));
    await started.promise;
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(429);
    await fixture.server.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await write(fixture, HEALTH_PATH, 'POST', HEALTH_TARGET)).status).toBe(503);
    expect(probe).toHaveBeenCalledTimes(3);
    for (const response of await Promise.all(pending)) {
      expect(await readJson(response)).toMatchObject({ status: 'error', error: 'Admin server is stopping' });
    }
    expect(
      fixture.store.orm
        .select()
        .from(modelCalls)
        .all()
        .map((row) => row.state),
    ).toEqual(['error', 'error', 'error']);
  } finally {
    await fixture.server.stop();
    probe.mockRestore();
    fixture.store.close();
  }
});
