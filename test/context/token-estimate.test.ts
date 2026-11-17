import { afterAll, describe, expect, test, vi } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { validateToolRegistry } from '../../src/orchestration/agent-runtime/support.ts';
import { estimateTextTokens } from '../../src/platform/token-estimate.ts';
import { cleanupFixtureDirectories, fixture, update, withoutIdleWait } from './hot-inject-fixtures.ts';

/*
 * Ways the shared estimate can fail, written down before the code:
 *
 * 1. CJK text is still weighed like ASCII (a quarter token per character), so a
 *    Chinese chat is estimated at about a quarter of what the provider counts.
 * 2. A character outside the BMP (most emoji) is two UTF-16 units and gets
 *    counted twice.
 * 3. A lone surrogate throws, or vanishes from the count.
 * 4. The ASCII remainder is truncated instead of rounded up, or an empty string
 *    costs a token.
 * 5. The estimator changes but the canonical history does not: a CJK batch still
 *    lands in `context_messages.est_tokens` at the old figure.
 * 6. A CJK history over the hard token ratio slips past GC, because the pressure
 *    check still reads an ASCII-weighted estimate.
 * 7. The tool-registry cap keeps dividing characters by four, so a registry of
 *    CJK descriptions far over 10% of the window is accepted.
 */

afterAll(cleanupFixtureDirectories);

describe('text token estimate', () => {
  test('ASCII costs a token per four characters, rounded up', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a')).toBe(1);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('a'.repeat(4_000))).toBe(1_000);
  });

  test('every non-ASCII character costs a whole token', () => {
    expect(estimateTextTokens('塑料碗')).toBe(3);
    expect(estimateTextTokens('こんにちは')).toBe(5);
    expect(estimateTextTokens('中'.repeat(4_000))).toBe(4_000);
    // Mixed text adds the two shares: 8 ASCII characters and 2 CJK ones.
    expect(estimateTextTokens('{"t":"你好"}')).toBe(4);
  });

  test('a surrogate pair is one character, and a lone surrogate still counts', () => {
    expect(estimateTextTokens('😭')).toBe(1);
    expect(estimateTextTokens('😭😭😭')).toBe(3);
    expect(estimateTextTokens('\ud83d')).toBe(1);
    expect(estimateTextTokens('\ude2d')).toBe(1);
  });
});

describe('tool registry cap', () => {
  const tool = (name: string, description: string): AgentTool => ({
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: null }),
  });

  test('a CJK registry over 10% of the window is refused', () => {
    // 3,000 CJK characters are about 3,000 tokens: far over the 1,000-token cap
    // of a 10,000-token window, though only 750 by the four-characters rule.
    const cjk = [tool('lookup', '查'.repeat(3_000))];
    expect(() => validateToolRegistry(cjk, 10_000)).toThrow(/10% of the model context window/);
    // The same number of ASCII characters stays inside the cap.
    const ascii = [tool('lookup', 'a'.repeat(3_000))];
    expect(() => validateToolRegistry(ascii, 10_000)).not.toThrow();
  });
});

describe('CJK history in the canonical context', () => {
  const HEAVY = 7_000;

  const setup = async () => {
    const fixtureSetup = await fixture((config) => {
      withoutIdleWait(config);
      config.agent!.context_stop_ratio = 0.8;
      config.agent!.context!.hard_token_ratio = 0.5;
    });
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 40_000, maxTokens: 1_000 }],
    });
    const runtime = await fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const runNext = async (updateId: number, messageId: number, text: string) => {
      fixtureSetup.ingestion.ingest(update(updateId, messageId, text), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error(`Expected an invocation for update ${updateId}`);
      }
      const outcome = await runtime.run(
        invocationId,
        fixtureSetup.configStore.beginInvocation(),
        new AbortController().signal,
      );
      fixtureSetup.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      return outcome;
    };
    return { fixtureSetup, faux, scheduler, runNext };
  };

  test('a CJK batch is persisted at about a token per character', async () => {
    const { fixtureSetup, faux, scheduler, runNext } = await setup();
    faux.setResponses([() => fauxAssistantMessage('好的')]);
    try {
      await runNext(1, 10, '碗'.repeat(HEAVY));
      const row = fixtureSetup.store.db
        .prepare<[], { est_tokens: bigint; payload_json: string }>(
          "SELECT est_tokens, payload_json FROM context_messages WHERE role = 'user' ORDER BY seq LIMIT 1",
        )
        .get();
      expect(row?.payload_json).toContain('碗'.repeat(HEAVY));
      // The four-characters rule put this row near 1,800.
      expect(Number(row?.est_tokens)).toBeGreaterThanOrEqual(HEAVY);
      expect(Number(row?.est_tokens)).toBeLessThan(HEAVY + 1_000);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a CJK history over the hard token ratio is collected', async () => {
    // Reproduces the fault: three 7,000-character Chinese batches are about
    // 21,000 tokens in a 40,000-token window whose hard ratio is 0.5. Weighed
    // like ASCII they came to about 5,500, so GC never saw any pressure and the
    // history kept growing until the provider itself rejected the request.
    const { fixtureSetup, faux, scheduler, runNext } = await setup();
    faux.setResponses([
      () => fauxAssistantMessage('一'),
      () => fauxAssistantMessage('二'),
      () => fauxAssistantMessage('三'),
      () => fauxAssistantMessage(fauxToolCall('read', { path: 'system:///missing.md' }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('四'),
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runNext(1, 10, '甲'.repeat(HEAVY));
      await runNext(2, 11, '乙'.repeat(HEAVY));
      await runNext(3, 12, '丙'.repeat(HEAVY));
      const before = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; last_gc_at: string | null }>(
          'SELECT head_seq, last_gc_at FROM conversation_contexts',
        )
        .get();
      expect(before?.last_gc_at).toBeNull();

      const outcome = await runNext(4, 13, '丁');

      // The turn boundary after the tool call collected up to the newest batch.
      const checkpoint = fixtureSetup.store.db
        .prepare<[], { seq: bigint }>(
          "SELECT seq FROM context_messages WHERE role = 'user' AND is_checkpoint = 1 ORDER BY seq DESC LIMIT 1",
        )
        .get();
      const after = fixtureSetup.store.db
        .prepare<[], { head_seq: bigint; last_gc_at: string | null }>(
          'SELECT head_seq, last_gc_at FROM conversation_contexts',
        )
        .get();
      expect(after?.last_gc_at).not.toBeNull();
      expect(after?.head_seq).toBe(checkpoint?.seq);
      expect(after?.head_seq).toBeGreaterThan(before?.head_seq ?? 0n);
      const gcEvents = log.mock.calls
        .map(([line]) => (typeof line === 'string' && line.includes('"event":"context_gc"') ? JSON.parse(line) : null))
        .filter((event) => event !== null) as { before_tokens: number; after_tokens: number }[];
      expect(gcEvents).toHaveLength(1);
      expect(gcEvents[0]?.before_tokens).toBeGreaterThanOrEqual(HEAVY * 3);
      expect(gcEvents[0]?.after_tokens).toBeLessThan(1_000);
      // The run was relieved, not closed.
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    } finally {
      log.mockRestore();
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});
