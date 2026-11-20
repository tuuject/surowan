import { afterEach, describe, expect, test, vi } from 'vitest';
import { keychainPath, updateKeychain } from '../../src/platform/keychain.ts';
import {
  API_KEY,
  answer,
  attempt,
  bucketRow,
  decisionRows,
  gate,
  gateEvents,
  groupMessage,
  invocationCount,
  json,
  GROUP_B,
  KEYCHAIN_ENTRY,
  resetHarness,
  settle,
  setup,
  START,
  until,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

/**
 * Every row of the plan's failure table that belongs to the gate: the verdict is
 * `enter`, the row carries a stable code, and the batch is released so the next
 * pass queues it. No retry.
 */
async function expectFailure(
  responder: (call: { readonly authorization: string | null }) => Response | Promise<Response>,
  expected: { readonly code: string; readonly detail?: RegExp },
  overrides: Parameters<typeof gate>[2] = {},
): Promise<void> {
  vi.restoreAllMocks();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const harness = await setup({ decisionGate: gate(true, 'enforce', overrides) });
  harness.decisions.responder = responder;
  try {
    const result = attempt(harness, groupMessage(1, 10), START);
    await settle(harness);
    const rows = decisionRows(harness.store, result.bucketId ?? 0n);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'error', outcome: 'enter', applied: 1n, error_code: expected.code });
    if (expected.detail !== undefined) {
      expect(rows[0]?.error_detail ?? '').toMatch(expected.detail);
    }
    // Admitted: the next pass takes the ordinary path.
    expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
    expect(invocationCount(harness.store)).toBe(1);
    expect(gateEvents(log)).toMatchObject([{ state: 'error', outcome: 'enter', error_code: expected.code }]);
  } finally {
    harness.store.close();
  }
}

describe('the Decisions API fails', () => {
  test('a timeout admits the batch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce', { timeout_ms: 500 }) });
    harness.decisions.hang = true;
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(decisionRows(harness.store, result.bucketId ?? 0n)).toMatchObject([
        { state: 'error', outcome: 'enter', applied: 1n, error_code: 'timeout' },
      ]);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(gateEvents(log)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test('a network error admits the batch', async () => {
    await expectFailure(() => Promise.reject(new TypeError('fetch failed')), { code: 'network_error' });
  });

  for (const status of [401, 402, 429, 500]) {
    test(`HTTP ${status} admits the batch and records the status`, async () => {
      await expectFailure(() => json({ error: { code: status, message: 'upstream refused' } }, status), {
        code: 'http_error',
        detail: new RegExp(`HTTP ${status}`),
      });
    });
  }

  test('a body that is not JSON admits the batch', async () => {
    await expectFailure(() => new Response('not json at all', { status: 200 }), { code: 'invalid_response' });
  });

  test('a body without answers.gate.noul admits the batch', async () => {
    await expectFailure(
      () => json({ answers: { other: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      { code: 'invalid_response' },
    );
    await expectFailure(
      () => json({ answers: { gate: { type: 'noul', noul: 1.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      { code: 'invalid_response' },
    );
  });

  test('a refusal admits the batch', async () => {
    await expectFailure(
      () => json({ answers: { gate: { type: 'refusal' } }, usage: { input_tokens: 1, output_tokens: 0 } }),
      { code: 'refusal' },
    );
  });
});

describe('the credential', () => {
  test('a dangling keychain entry admits the batch as secret_unresolved', async () => {
    await expectFailure(
      () => answer(0.9),
      { code: 'secret_unresolved', detail: /missing-entry/ },
      {
        api_key: { jar: 'missing-entry' },
      },
    );
    expect(process.env.SUROWAN_TEST_DECISION_MISSING).toBeUndefined();
    await expectFailure(
      () => answer(0.9),
      { code: 'secret_unresolved', detail: /SUROWAN_TEST_DECISION_MISSING/ },
      {
        api_key: { env: 'SUROWAN_TEST_DECISION_MISSING' },
      },
    );
  });

  test('a command slower than the budget admits the batch at the budget and does not spin', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce', {
        timeout_ms: 500,
        api_key: {
          command: [process.execPath, '-e', 'setTimeout(() => process.stdout.write("slow-secret"), 3000)'],
        },
      }),
    });
    try {
      const startedAt = Date.now();
      const result = attempt(harness, groupMessage(1, 10), START, new Date());
      // The pushed deadline is still ahead, so the loop sleeps through the budget
      // instead of waking on an already-passed deadline.
      expect(harness.scheduler.nextDelayMilliseconds()).toBeGreaterThan(0);
      await settle(harness);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(2_500);
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store, result.bucketId ?? 0n)).toMatchObject([
        { state: 'error', outcome: 'enter', applied: 1n, error_code: 'secret_unresolved' },
      ]);
      // The batch was released at the budget: the next pass queues it.
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(bucketRow(harness.store, result.bucketId ?? 0n).state).toBe('queued');
    } finally {
      harness.store.close();
    }
  });

  test('a rotated keychain entry applies to the next decision without a reload', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Two chats, so the first released batch (queued, never launched) cannot
    // hold the second chat's batch behind it at the chat level.
    const harness = await setup({ decisionGate: gate(true, 'enforce'), twoGroups: true });
    harness.decisions.responder = () => answer(0.9);
    try {
      attempt(harness, groupMessage(1, 10), START);
      await until(() => harness.decisions.calls.length === 1, 'the first request');
      await settle(harness);
      expect(harness.decisions.calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);

      const rotated = 'rotated-decision-gate-key';
      await updateKeychain(keychainPath(harness.configPath), { replace: { [KEYCHAIN_ENTRY]: rotated } });
      harness.ingestion.ingest(
        groupMessage(2, 11, { chat: { id: GROUP_B, type: 'supergroup', title: 'Group B' } }),
        START,
      );
      harness.scheduler.processDue(new Date());
      await until(() => harness.decisions.calls.length === 2, 'the second request');
      expect(harness.decisions.calls[1]?.authorization).toBe(`Bearer ${rotated}`);
    } finally {
      harness.store.close();
    }
  });

  test('an upstream echoing the key stores and logs it redacted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => json({ error: { message: `Incorrect API key provided: ${API_KEY}` } }, 401);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      const row = decisionRows(harness.store, result.bucketId ?? 0n)[0];
      expect(row?.error_code).toBe('http_error');
      expect(row?.error_detail).toContain('[redacted]');
      expect(row?.error_detail).not.toContain(API_KEY);
      expect(JSON.stringify(gateEvents(log))).not.toContain(API_KEY);
    } finally {
      harness.store.close();
    }
  });
});
