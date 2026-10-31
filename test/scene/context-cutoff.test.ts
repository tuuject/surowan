import { afterAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildSceneContext } from '../../src/context/scene/index.ts';
import {
  appState,
  conversationContextCutoffs,
  invocationMessages,
  messageRevisions,
  messages,
} from '../../src/store/schema/index.ts';
import {
  DEFAULT_OPTIONS,
  FORUM_CHAT,
  GROUP_CHAT,
  START,
  TOPIC_A,
  TOPIC_B,
  at,
  chatConfigOf,
  chatRowId,
  cleanupDirectories,
  conversationIdOf,
  editUpdate,
  flush,
  forumUpdate,
  groupUpdate,
  insertRawMessage,
  invocationMessagesJson,
  latestInvocation,
  sceneConfig,
  setup,
} from './context-fixtures.ts';

afterAll(cleanupDirectories);

describe('scene context', () => {
  test('respects the conversation cutoff', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'cut old', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    store.orm
      .insert(conversationContextCutoffs)
      .values({
        conversationId,
        telegramMessageId: 10n,
        createdAt: at(25).toISOString(),
        updatedAt: at(25).toISOString(),
      })
      .run();
    ingestion.ingest(groupUpdate(2, 11, 'after cut', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(0);
    expect(scene.messageCount).toBe(1);
    expect(scene.text).not.toContain('<untrusted_telegram_history>');
    expect(scene.text).not.toContain('cut old');
    expect(scene.text).toContain('  after cut');
    store.close();
  });

  test('fails fast when the chat or topic is no longer allowed, or the invocation is gone', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(forumUpdate(1, 10, 'topic A', TOPIC_A, 0), at(0));
    flush(fixture, 30);
    const invocationId = latestInvocation(store, conversationIdOf(store, FORUM_CHAT, TOPIC_A));

    const withoutChat = sceneConfig(fixture, (config) => {
      config.telegram.chats = config.telegram.chats.filter((chat) => BigInt(chat.id) !== FORUM_CHAT);
    });
    expect(() => buildSceneContext(store, withoutChat, invocationId, DEFAULT_OPTIONS)).toThrow(
      /chat .* is no longer configured/,
    );

    const withoutTopic = sceneConfig(fixture, (config) => {
      chatConfigOf(config, FORUM_CHAT).topic_ids = [Number(TOPIC_B)];
    });
    expect(() => buildSceneContext(store, withoutTopic, invocationId, DEFAULT_OPTIONS)).toThrow(
      /topic .* is not allowed/,
    );

    expect(() => buildSceneContext(store, fixture.loaded.config, 999_999n, DEFAULT_OPTIONS)).toThrow(
      /invocation 999999 does not exist/,
    );
    store.close();
  });

  test('frozen history wins even when receipt or revision clocks are later than invocation creation', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'frozen history', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
    const frozen = store.orm
      .select()
      .from(invocationMessages)
      .where(and(eq(invocationMessages.invocationId, invocationId), eq(invocationMessages.section, 'history')))
      .get()!;
    store.orm
      .update(messages)
      .set({ receivedAt: at(51).toISOString() })
      .where(eq(messages.id, frozen.messageId))
      .run();
    store.orm
      .update(messageRevisions)
      .set({ createdAt: at(51).toISOString(), text: 'mutable revision changed' })
      .where(eq(messageRevisions.id, frozen.revisionId))
      .run();
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.text).toContain('  frozen history');
    expect(scene.text).not.toContain('mutable revision changed');
    store.close();
  });

  test('catch-up without frozen history proves fallback arrivals, edits and trigger ordering', async () => {
    const fixture = await setup();
    const { store, ingestion, scheduler } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'before restart', 0), at(0));
    flush(fixture, 20);
    store.orm
      .insert(appState)
      .values({ key: 'telegram_startup_catch_up', value: at(30).toISOString(), updatedAt: at(30).toISOString() })
      .run();
    ingestion.ingestCatchUp(groupUpdate(2, 20, 'catch-up trigger', 35), at(40));
    const [invocationId] = scheduler.finishStartupCatchUp(at(30), at(50));
    expect(invocationId).toBeDefined();
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    expect(invocationMessagesJson(store, invocationId!)).toHaveLength(1);
    const future = insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 19n,
      seconds: 35,
      text: 'late arrival',
    });
    store.orm
      .update(messages)
      .set({ receivedAt: at(51).toISOString() })
      .where(eq(messages.id, future))
      .run();
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 21n,
      seconds: 35,
      text: 'after trigger ordering',
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 18n,
      seconds: 34,
      revisionSeconds: 51,
      text: 'future revision',
    });
    ingestion.ingest(editUpdate(3, 10, 'later edit', 60), at(60));
    const scene = buildSceneContext(store, fixture.loaded.config, invocationId!, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.omittedMessages).toBe(1);
    expect(scene.text).toContain('  before restart');
    expect(scene.text).toContain('  catch-up trigger');
    expect(scene.text).not.toMatch(/late arrival|after trigger ordering|future revision|later edit/);
    store.close();
  });

  test('writes nothing and is deterministic', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'old one', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const tables = [
      'messages',
      'message_revisions',
      'media',
      'invocations',
      'invocation_messages',
      'invocation_buckets',
      'buckets',
      'bucket_messages',
      'senders',
      'conversation_context_cutoffs',
      'conversation_contexts',
      'context_messages',
      'context_refs',
      'memo_pad_entries',
    ];
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        tables.map((table) => {
          const row = store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
          return [table, Number(row?.count ?? -1n)] as const;
        }),
      );

    const before = counts();
    const first = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    const second = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    const after = counts();

    expect(after).toEqual(before);
    expect(after.context_refs).toBe(0);
    expect(after.context_messages).toBe(0);
    expect(after.conversation_contexts).toBe(0);
    expect(first.text).toBe(second.text);
    store.close();
  });

  test('treats the cutoff as inclusive and lets options.now drive the rendering clock', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 8n,
      seconds: 25,
      revisionSeconds: 50,
      text: 'boundary in',
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 9n,
      seconds: 25,
      revisionSeconds: 50,
      text: 'boundary out',
    });
    store.orm
      .update(messages)
      .set({ receivedAt: new Date(at(50).getTime() + 1).toISOString() })
      .where(eq(messages.telegramMessageId, 9n))
      .run();

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(scene.text).toContain('  boundary in');
    expect(scene.text).not.toContain('boundary out');

    const nextDay = new Date(START.getTime() + 86_400_000);
    const rendered = buildSceneContext(store, fixture.loaded.config, invocationId, {
      ...DEFAULT_OPTIONS,
      now: nextDay,
    });
    expect(rendered.cutoffAt).toBe(at(50).toISOString());
    expect(rendered.text).toContain('August 16, 2026');
    expect(rendered.text).toContain('[10 2026-08-15T00:00:30 uid:42 @alice] Alice');
    store.close();
  });
});
