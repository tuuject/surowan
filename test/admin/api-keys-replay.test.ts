import { expect, test, vi } from 'vitest';
import { AdminQueryError } from '../../src/ingress/admin/audit/shared.ts';
import {
  type ReplayCall,
  bearer,
  createKey,
  fixture,
  installAdminApiKeyHooks,
  post,
  readJson,
  request,
  setupAdmin,
} from './api-keys-fixtures.ts';

installAdminApiKeyHooks();

test('replay accepts only editable templates, caps the body, and forwards the abort signal', async () => {
  const calls: ReplayCall[] = [];
  const { store, server } = await fixture(async (id, input, signal) => {
    calls.push({ id, input, signal });
    return { status: 'replayed' };
  });
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const auth = bearer(created.key);

    const sessionOnly = await server.handle(post('/api/invocations/42/replay', {}, { cookie }));
    expect(sessionOnly.status).toBe(405);
    expect(await readJson(sessionOnly)).toMatchObject({ error: 'method_not_allowed' });
    expect(calls).toHaveLength(0);

    const replayRequest = post(
      '/api/invocations/42/replay',
      { global_prompt: 'Use the rubric.', group_prompt: 'Group tone.' },
      auth,
    );
    const response = await server.handle(replayRequest);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: 'replayed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(42n);
    expect(calls[0]?.input).toEqual({ global_prompt: 'Use the rubric.', group_prompt: 'Group tone.' });
    expect(calls[0]?.signal).toBe(replayRequest.signal);

    const empty = await server.handle(post('/api/invocations/7/replay', { group_prompt: '' }, auth));
    expect(empty.status).toBe(200);
    expect(calls[1]?.input).toEqual({ group_prompt: '' });

    const omitted = await server.handle(post('/api/invocations/7/replay', {}, auth));
    expect(omitted.status).toBe(200);
    expect(calls[2]?.input).toEqual({});

    const maxLength = await server.handle(
      post('/api/invocations/7/replay', { global_prompt: 'a'.repeat(65_536), group_prompt: 'b'.repeat(65_536) }, auth),
    );
    expect(maxLength.status).toBe(200);
    expect(calls[3]?.input.global_prompt).toHaveLength(65_536);
    expect(calls[3]?.input.group_prompt).toHaveLength(65_536);

    const invalid: readonly [unknown, number][] = [
      [{ system_prompt: 'not writable' }, 400],
      [{ global_prompt: 'a'.repeat(65_537) }, 400],
      [{ group_prompt: 'a'.repeat(65_537) }, 400],
      [{ global_prompt: '' }, 400],
      [{ global_prompt: 42 }, 400],
      [{ prompt: 'wrong field' }, 400],
      [{ global_prompt: 'ok', extra: true }, 400],
      [[], 400],
      ['just a string', 400],
      ['{', 400],
    ];
    for (const [body, status] of invalid) {
      const rejected = await server.handle(post('/api/invocations/7/replay', body, auth));
      expect(rejected.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      expect(await readJson(rejected)).toMatchObject({ error: 'invalid_body' });
    }
    expect(calls).toHaveLength(4);

    // Body cap: declared Content-Length is refused before reading...
    const declared = await server.handle(
      post('/api/invocations/7/replay', { global_prompt: 'a'.repeat(1_048_576) }, auth),
    );
    expect(declared.status).toBe(413);
    expect(await readJson(declared)).toMatchObject({ error: 'body_too_large' });
    // ...and a chunked body without Content-Length is counted while it streams.
    const streamed = request('/api/invocations/7/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"global_prompt":"'));
          controller.enqueue(new TextEncoder().encode('a'.repeat(1_048_576)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const streamedResponse = await server.handle(streamed);
    expect(streamedResponse.status).toBe(413);

    // The request signal is the same object, and an aborted caller is visible
    // as aborted inside the engine.
    const controller = new AbortController();
    controller.abort();
    const abortedRequest = request('/api/invocations/9/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{}',
      signal: controller.signal,
    });
    const aborted = await server.handle(abortedRequest);
    expect(aborted.status).toBe(200);
    expect(calls.at(-1)?.signal.aborted).toBe(true);
    expect(calls.at(-1)?.id).toBe(9n);
  } finally {
    store.close();
  }
});

test('replay renders engine errors as AdminQueryError and redacts known failures', async () => {
  let failure = new AdminQueryError('invocation_not_found', 'Invocation does not exist', 404);
  const { store, server, secrets } = await fixture(async () => {
    throw failure;
  });
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    const response = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'invocation_not_found', message: 'Invocation does not exist' });
    // Simulate a key no longer in the process redaction cache, e.g. after restart.
    for (let index = 0; index < 64; index += 1) {
      secrets.remember(`unrelated-secret-${index}`);
    }
    expect(secrets.redact(created.key)).toBe(created.key);
    failure = new AdminQueryError(`failed_${created.key}`, `Engine echoed ${created.key}`, 409);
    const redacted = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(redacted.status).toBe(409);
    expect(await readJson(redacted)).toEqual({ error: 'failed_[REDACTED]', message: 'Engine echoed [REDACTED]' });
  } finally {
    store.close();
  }
});

test('engine failures are logged without the key and answered with a fixed error', async () => {
  let leaked = '';
  const { store, server } = await fixture(async () => {
    throw new Error(`engine exploded with ${leaked}`);
  });
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const cookie = await setupAdmin(server);
    const created = await createKey(server, cookie);
    leaked = created.key;
    const response = await server.handle(post('/api/invocations/1/replay', {}, bearer(created.key)));
    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: 'internal_error', message: 'Admin request failed' });
    const logged = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('admin_request_failed');
    expect(logged).not.toContain(created.key);
    expect(logged).toContain('[REDACTED]');
  } finally {
    spy.mockRestore();
    store.close();
  }
});
