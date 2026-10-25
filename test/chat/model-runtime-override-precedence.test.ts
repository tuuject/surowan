import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { RawConfig } from '../../src/platform/config/index.ts';
import {
  CHAT_A,
  CHAT_B,
  CHAT_MIGRATED_TO,
  cleanupDirectories,
  contextIds,
  contextMessagesByChat,
  DEFAULT_MODEL,
  fauxAgent,
  FORUM_TOPIC_ID,
  modelCalls,
  runOnce,
  setup,
  snapshotOf,
  VISION_MODEL,
  withChat,
} from './model-runtime-fixtures.ts';

afterAll(cleanupDirectories);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat model routing', () => {
  test('old snapshot persists across sequential invocations; next gets new values', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first'), () => fauxAssistantMessage('second')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      // First invocation: Chat A with vision model (override).
      const invA = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'first');

      // Second invocation: same chat, switched config (DEFAULT_MODEL + low).
      const switched = withChat(fixture.config, CHAT_A, { model: DEFAULT_MODEL, thinking_level: 'low' });
      const invB = await runOnce(fixture, runtime, snapshotOf(switched, registry, 'second'), CHAT_A, 2, 11, 'second');

      const [callA] = modelCalls(fixture.store, invA);
      const [callB] = modelCalls(fixture.store, invB);
      expect(callA?.model).toBe(VISION_MODEL);
      expect(callB?.model).toBe(DEFAULT_MODEL);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('forum topics in the same chat share the chat-level model override', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('topic 1'), () => fauxAssistantMessage('topic 2')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const invMain = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'main');
      const invTopic = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_A,
        2,
        20,
        'topic msg',
        FORUM_TOPIC_ID,
      );

      const [callMain] = modelCalls(fixture.store, invMain);
      const [callTopic] = modelCalls(fixture.store, invTopic);
      expect(callMain?.model).toBe(VISION_MODEL);
      expect(callTopic?.model).toBe(VISION_MODEL);
      expect(callMain?.provider).toBe('agent');
      expect(callTopic?.provider).toBe('agent');
      expect(
        fixture.store.db
          .prepare<[], { message_thread_id: bigint }>(
            'SELECT message_thread_id FROM conversations ORDER BY message_thread_id',
          )
          .all()
          .map((row) => row.message_thread_id),
      ).toEqual([0n, FORUM_TOPIC_ID]);
      expect(contextIds(fixture.store)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('chat migration resolves old chat config for the new chat id', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('migrated')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const inv = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_MIGRATED_TO,
        1,
        10,
        'hello',
      );

      const [call] = modelCalls(fixture.store, inv);
      expect(call?.provider).toBe('agent');
      expect(call?.model).toBe(VISION_MODEL);
      expect(call?.state).toBe('success');
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('a directly configured migrated Chat takes precedence over the old Chat override', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('direct configuration');
      },
    ]);
    const direct: RawConfig = {
      ...fixture.config,
      telegram: {
        ...fixture.config.telegram,
        chats: [...fixture.config.telegram.chats, { id: CHAT_MIGRATED_TO, instructions: '' }],
      },
    };
    fixture.configStore.publish({ config: direct, hash: 'direct', ...fixture.registry });
    const { runtime, registry } = fixture.runtimeWith(faux, direct);
    try {
      const invocation = await runOnce(
        fixture,
        runtime,
        snapshotOf(direct, registry),
        CHAT_MIGRATED_TO,
        1,
        10,
        'hello direct',
      );
      expect(modelCalls(fixture.store, invocation)).toEqual([
        { provider: 'agent', model: DEFAULT_MODEL, state: 'success' },
      ]);
      expect(levels).toEqual(['low']);
      expect(contextMessagesByChat(fixture.store).every((row) => row.chat_id === BigInt(CHAT_MIGRATED_TO))).toBe(true);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('vision model enables image capability prompt; text-only model does not', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage('vision');
      },
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage('text');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'hello V');
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'hello T');

      expect(prompts[0]).toContain('attached directly to the multimodal Agent input');
      expect(prompts[1]).not.toContain('attached directly to the multimodal Agent input');
      expect(prompts[1]).toContain('available through the read_image capability');
    } finally {
      fixture.store.close();
    }
  }, 30_000);
});
