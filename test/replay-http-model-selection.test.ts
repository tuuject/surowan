import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, expect, test } from 'vitest';
import { asObject, cleanupFixtures, fixture, productionTables, setupAdminSession } from './replay-http-fixtures.ts';

/**
 * Temporary model override over HTTP: strict query/body validation and the
 * disclosure of the override in the replay document.
 */

afterEach(cleanupFixtures);

test('replay model selection over HTTP validates strictly and discloses the temporary override', async () => {
  const f = await fixture();
  const admin = await setupAdminSession(f.baseUrl);
  const headers = { authorization: `Bearer ${admin.key}` };
  const before = productionTables(f.rows());

  // The free preflight query accepts the model fields; a same-model pair
  // resolves to the weakest supported level ('off' for the non-reasoning faux).
  const preflight = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?provider=agent&model=agent-model`, {
    headers,
  });
  expect(preflight.status).toBe(200);
  expect(await asObject(preflight)).toMatchObject({
    available: true,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    fidelity: { model_selection: 'temporary_override' },
  });
  const withLevel = await fetch(
    `${f.baseUrl}/api/invocations/4001/replay-preflight?provider=agent&model=agent-model&thinking_level=off`,
    { headers },
  );
  expect(await asObject(withLevel)).toMatchObject({
    available: true,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
  });

  f.faux.setResponses([
    (_context, options) => {
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(fauxToolCall('send', { text: 'selected model send' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('done'),
  ]);
  const run = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
  });
  expect(run.status).toBe(200);
  expect(await asObject(run)).toMatchObject({
    error: null,
    send_count: 1,
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'off' },
    overrides: { global_prompt: false, group_prompt: false, provider: true, model: true, thinking_level: false },
    fidelity: { model_selection: 'temporary_override' },
  });
  expect(f.faux.state.callCount).toBe(2);

  // Strict preflight query: unknown or repeated keys, a lone field and an
  // unknown thinking level are all refused before the engine.
  for (const query of [
    'provider=agent',
    'model=agent-model',
    'provider=agent&provider=alt',
    'provider=agent&model=agent-model&thinking_level=banana',
    'provider=agent&model=agent-model&bogus=1',
    'provider=&model=agent-model',
    'provider=agent&model=%20',
    'provider=agent&model=bad%0Amodel',
    `provider=agent&model=${'x'.repeat(257)}`,
  ]) {
    const invalid = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?${query}`, { headers });
    expect(invalid.status, query).toBe(400);
    expect(await asObject(invalid)).toMatchObject({ error: 'invalid_query' });
  }
  // Model reference problems are engine rejections: preflight documents them.
  const unknownTarget = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?provider=agent&model=nope`, {
    headers,
  });
  expect(await asObject(unknownTarget)).toMatchObject({ available: false, reason: 'unknown_model' });
  const unsupportedLevel = await fetch(`${f.baseUrl}/api/invocations/4001/replay-preflight?thinking_level=low`, {
    headers,
  });
  expect(await asObject(unsupportedLevel)).toMatchObject({
    available: false,
    reason: 'replay_thinking_level_unsupported',
  });

  // The POST body shares the same rules: pair required, no unknown fields, no
  // unsupported levels, no unknown targets — all refused before any model call.
  const bodyCases: readonly [Record<string, unknown>, string][] = [
    [{ provider: 'agent' }, 'invalid_body'],
    [{ model: 'agent-model' }, 'invalid_body'],
    [{ provider: '', model: 'agent-model' }, 'invalid_body'],
    [{ provider: 'agent', model: ' ' }, 'invalid_body'],
    [{ provider: 'agent', model: 'bad\nmodel' }, 'invalid_body'],
    [{ provider: 'agent', model: 'x'.repeat(257) }, 'invalid_body'],
    [{ provider: 'agent', model: 'nope' }, 'unknown_model'],
    [{ provider: 'agent', model: 'agent-model', thinking_level: 'banana' }, 'invalid_body'],
    [{ thinking_level: 'low' }, 'replay_thinking_level_unsupported'],
    [{ provider: 'agent', model: 'agent-model', extra: true }, 'invalid_body'],
  ];
  for (const [body, code] of bodyCases) {
    const rejected = await fetch(`${f.baseUrl}/api/invocations/4001/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    expect(rejected.status, JSON.stringify(body)).toBe(400);
    expect(await asObject(rejected)).toMatchObject({ error: code });
  }
  expect(f.faux.state.callCount).toBe(2);
  // Only the API key's own last_used_at moved: no production table was touched.
  expect(productionTables(f.rows())).toEqual(before);
}, 120_000);
