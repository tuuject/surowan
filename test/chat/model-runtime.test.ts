import { afterAll, describe, expect, test } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import {
  CHAT_A,
  CHAT_B,
  cleanupDirectories,
  contextIds,
  contextMessagesByChat,
  DEFAULT_MODEL,
  fauxAgent,
  modelCalls,
  runOnce,
  setup,
  snapshotOf,
  textUpdate,
  VISION_MODEL,
  waitForInvocation,
  withChat,
} from './model-runtime-fixtures.ts';

afterAll(cleanupDirectories);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat model routing', () => {
  test('Chat A override picks vision model + high thinking; Chat B falls back to global defaults', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('reply A');
      },
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('reply B');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const invA = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'hello A');
      const invB = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'hello B');

      const [callA] = modelCalls(fixture.store, invA);
      const [callB] = modelCalls(fixture.store, invB);
      expect(callA?.provider).toBe('agent');
      expect(callA?.model).toBe(VISION_MODEL);
      expect(callA?.state).toBe('success');
      expect(callB?.provider).toBe('agent');
      expect(callB?.model).toBe(DEFAULT_MODEL);
      expect(callB?.state).toBe('success');
      expect(levels).toEqual(['high', 'low']);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('switching a Chat across providers routes to the new provider and preserves an unchanged Context', async () => {
    const fixture = await setup();
    const original = fauxAgent();
    const other = fauxProvider({
      provider: 'vision',
      models: [{ id: 'vision-model', input: ['text', 'image'], reasoning: false }],
    });
    const calls: string[] = [];
    original.setResponses([
      (_context, options) => {
        calls.push(`agent:${options?.reasoning}`);
        return fauxAssistantMessage('original answer');
      },
    ]);
    other.setResponses([
      () => {
        calls.push('vision');
        return fauxAssistantMessage('other answer');
      },
    ]);
    const models = createModels();
    models.setProvider(original.provider);
    models.setProvider(other.provider);
    const registry = { models, visionModel: other.getModel() };
    const { runtime } = fixture.runtimeWith(original);
    try {
      const first = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_A,
        1,
        10,
        'before switch',
      );
      const contexts = contextIds(fixture.store);
      const switched = withChat(fixture.config, CHAT_A, {
        provider: 'vision',
        model: 'vision-model',
        thinking_level: 'off',
      });
      const second = await runOnce(
        fixture,
        runtime,
        snapshotOf(switched, registry, 'second'),
        CHAT_A,
        2,
        11,
        'after switch',
      );
      expect(calls).toEqual(['agent:high', 'vision']);
      expect(modelCalls(fixture.store, first)).toEqual([{ provider: 'agent', model: VISION_MODEL, state: 'success' }]);
      expect(modelCalls(fixture.store, second)).toEqual([
        { provider: 'vision', model: 'vision-model', state: 'success' },
      ]);
      expect(contextIds(fixture.store)).toEqual(contexts);
      expect(contextMessagesByChat(fixture.store).some((row) => row.payload_json.includes('original answer'))).toBe(
        true,
      );
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('context messages are isolated per conversation (different chats do not cross-contaminate)', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('A'), () => fauxAssistantMessage('B')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'A msg');
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'B msg');

      const ctxIds = contextIds(fixture.store);
      expect(ctxIds.length).toBe(2);
      const rows = contextMessagesByChat(fixture.store);
      const aRows = rows.filter((r) => r.chat_id === BigInt(CHAT_A));
      const bRows = rows.filter((r) => r.chat_id === BigInt(CHAT_B));
      expect(aRows.length).toBeGreaterThan(0);
      expect(bRows.length).toBeGreaterThan(0);
      // No cross-contamination.
      expect(aRows.some((r) => r.payload_json.includes('B msg'))).toBe(false);
      expect(bRows.some((r) => r.payload_json.includes('A msg'))).toBe(false);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('thinking-level-only override re-binds the cached agent', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_ctx, opts) => {
        levels.push(opts?.reasoning);
        return fauxAssistantMessage('first');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      // Chat B inherits its model; only thinking is overridden.
      const highCfg = withChat(fixture.config, CHAT_B, { thinking_level: 'high' });
      await runOnce(fixture, runtime, snapshotOf(highCfg, registry), CHAT_B, 1, 10, 'first');

      faux.setResponses([
        (_ctx, opts) => {
          levels.push(opts?.reasoning);
          return fauxAssistantMessage('second');
        },
      ]);
      const lowCfg = withChat(fixture.config, CHAT_B, { thinking_level: 'low' });
      await runOnce(fixture, runtime, snapshotOf(lowCfg, registry, 'second'), CHAT_B, 2, 11, 'second');

      expect(levels).toEqual(['high', 'low']);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('a queued invocation uses the snapshot current at queued-to-running transition', async () => {
    const fixture = await setup();
    const usedConfigs: string[] = [];
    const scheduler = new BucketScheduler(fixture.store, fixture.configStore, async (_invocationId, snapshot) => {
      usedConfigs.push(snapshot.config.telegram.chats.find((c) => BigInt(c.id) === BigInt(CHAT_A))?.model ?? 'none');
      return { state: 'completed', reason: 'done' };
    });
    try {
      // Ingest under the initial config (VISION_MODEL for Chat A).
      fixture.ingestion.ingest(textUpdate(CHAT_A, 1, 10, 'msg'), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      expect(invocationId).toBeDefined();
      expect(
        fixture.store.db
          .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
          .get(invocationId!)?.state,
      ).toBe('queued');

      // Publish a snapshot that changes Chat A to DEFAULT_MODEL.
      fixture.configStore.publish({
        config: withChat(fixture.config, CHAT_A, { model: DEFAULT_MODEL }),
        hash: 'second',
        ...fixture.registry,
      });

      scheduler.start();
      await waitForInvocation(() => usedConfigs.length > 0);
      // The invocation picked up the SECOND snapshot (current at launch).
      expect(usedConfigs[0]).toBe(DEFAULT_MODEL);
    } finally {
      await scheduler.stop();
      fixture.store.close();
    }
  }, 30_000);
});
