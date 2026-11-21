import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import type { DecisionGateSettings } from '../../src/platform/decision-gate.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { resolveVerdict } from '../../src/orchestration/decision-gate/run.ts';

/**
 * The credential and the request share one `timeout_ms`. The timeout is a race
 * arm, not a listener that outlives the call: a decision usually answers well
 * inside the budget, and every call adds to the same long-lived shutdown
 * signal. A listener left behind per decision trips Node's listener warning at
 * the eleventh request.
 */

const ENV_NAME = 'SUROWAN_TEST_DECISION_BUDGET';
const API = 'https://decisions.test/api';

afterEach(() => {
  delete process.env[ENV_NAME];
});

function settings(overrides: Partial<DecisionGateSettings> = {}): DecisionGateSettings {
  return {
    enabled: true,
    mode: 'enforce',
    threshold: 0.57,
    history_messages: 10,
    pending_messages: 10,
    instructions: 'Would the bot reply?',
    model: 'typesafe/jev-1.14',
    base_url: API,
    api_key: { env: ENV_NAME },
    timeout_ms: 10_000,
    ...overrides,
  };
}

function answer(probability: number): Response {
  return new Response(
    JSON.stringify({
      answers: { gate: { type: 'noul', noul: probability } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const STATE = {
  bot: { name: '塑料碗', username: 'SurowanBot' },
  history: [],
  pending: [{ from: 'Alice', text: 'hello' }],
};

describe('the shared decision budget', () => {
  test('fast decisions leave no abort listener on the shutdown signal', async () => {
    process.env[ENV_NAME] = 'budget-test-key';
    const controller = new AbortController();
    const secrets = new SecretStore();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const record = await resolveVerdict({
        settings: settings(),
        instructions: 'Would the bot reply?',
        state: STATE,
        secrets,
        signal: controller.signal,
        stopped: () => false,
        redact: String,
        fetchImpl: (async () => answer(0.9)) as unknown as typeof fetch,
      });
      expect(record).toMatchObject({ state: 'success', outcome: 'enter' });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  test('the timeout still fires when the request never answers', async () => {
    process.env[ENV_NAME] = 'budget-test-key';
    const controller = new AbortController();
    const hang = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })) as unknown as typeof fetch;
    const startedAt = Date.now();
    const record = await resolveVerdict({
      settings: settings({ timeout_ms: 500 }),
      instructions: 'Would the bot reply?',
      state: STATE,
      secrets: new SecretStore(),
      signal: controller.signal,
      stopped: () => false,
      redact: String,
      fetchImpl: hang,
    });
    expect(record).toMatchObject({ state: 'error', outcome: 'enter', errorCode: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('the credential resolution and the request share one budget', async () => {
    // No credential: the failure is stable and no HTTP call is attempted.
    const controller = new AbortController();
    const fetchImpl = (async () => answer(0.9)) as unknown as typeof fetch;
    const record = await resolveVerdict({
      settings: settings(),
      instructions: 'Would the bot reply?',
      state: STATE,
      secrets: new SecretStore(),
      signal: controller.signal,
      stopped: () => false,
      redact: String,
      fetchImpl,
    });
    expect(record).toMatchObject({ state: 'error', outcome: 'enter', errorCode: 'secret_unresolved' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
