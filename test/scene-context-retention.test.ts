import { afterAll, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { buildSceneContext } from '../src/context/scene-context.ts';
import { attachBucketToInvocation } from '../src/orchestration/invocation-queue.ts';
import { messages } from '../src/store/schema.ts';
import {
  BOB,
  DEFAULT_OPTIONS,
  GROUP_CHAT,
  at,
  chatConfigOf,
  chatRowId,
  cleanupDirectories,
  conversationIdOf,
  flush,
  groupUpdate,
  insertRawMessage,
  invocationMessagesJson,
  latestInvocation,
  sceneConfig,
  setup,
} from './scene-context-fixtures.ts';

afterAll(cleanupDirectories);

describe('scene context', () => {
  test('never leaks a later attached bucket, even when its clock sits before the cutoff', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'opening text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const attached = ingestion.ingest(groupUpdate(2, 11, 'attached text', 51), at(51)).bucketId;
    if (attached === undefined) {
      throw new Error('fixture: attached message opened no bucket');
    }
    attachBucketToInvocation(
      store,
      fixture.loaded.config.agent!.history_messages,
      invocationId,
      attached,
      conversationId,
      at(52),
    );
    // Rewrite the clock so only the opening-batch filter can keep it out.
    const attachedMessage = store.orm
      .all<{ id: bigint }>(
        sql`SELECT id FROM messages WHERE chat_id = ${chatRowId(store, GROUP_CHAT)} AND telegram_message_id = 11`,
      )
      .at(0);
    if (attachedMessage === undefined) {
      throw new Error('fixture: attached message is missing');
    }
    store.orm
      .update(messages)
      .set({ receivedAt: at(40).toISOString() })
      .where(eq(messages.id, attachedMessage.id))
      .run();

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.messageCount).toBe(1);
    expect(scene.text).toContain('  opening text');
    expect(scene.text).not.toContain('attached text');
    expect(invocationMessagesJson(store, invocationId)).toHaveLength(2);
    store.close();
  });

  test('accepts a legacy untagged opening batch only while no other bucket is attached', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'legacy trigger', 0), at(0));
    flush(fixture, 30);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    store.db
      .prepare("UPDATE invocation_messages SET source_bucket_id = NULL WHERE invocation_id = ? AND section = 'new'")
      .run(invocationId);

    const beforeAttach = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);
    expect(beforeAttach.messageCount).toBe(1);
    expect(beforeAttach.text).toContain('  legacy trigger');

    const attached = ingestion.ingest(groupUpdate(2, 11, 'attached later', 31), at(31)).bucketId;
    if (attached === undefined) {
      throw new Error('fixture: attached message opened no bucket');
    }
    attachBucketToInvocation(
      store,
      fixture.loaded.config.agent!.history_messages,
      invocationId,
      attached,
      conversationId,
      at(32),
    );

    expect(() => buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS)).toThrow(
      'opening messages unavailable',
    );
    store.close();
  });

  test('does not retroactively apply current ignored users to retained public messages', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'bob words', 0, { from: BOB }), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'alice trigger', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    const ignoring = sceneConfig(fixture, (config) => {
      chatConfigOf(config, GROUP_CHAT).ignored_user_ids = [BOB.id];
    });

    const scene = buildSceneContext(store, ignoring, invocationId, DEFAULT_OPTIONS);
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.text).toContain('  alice trigger');
    expect(scene.text).toContain('  bob words');

    ingestion.ingest(groupUpdate(3, 12, 'bob trigger', 55, { from: BOB }), at(55));
    flush(fixture, 75);
    const bobInvocationId = latestInvocation(store, conversationId);
    const bobScene = buildSceneContext(store, ignoring, bobInvocationId, DEFAULT_OPTIONS);
    expect(bobScene.text).toContain('  bob trigger');
    expect(bobScene.text).toContain('  bob words');

    // ignored_user_ids is an ingress decision, not a retroactive history filter.
    const stored = store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM message_revisions WHERE text LIKE 'bob%'")
      .get();
    expect(stored?.count).toBe(2n);
    store.close();
  });

  test('counts history without a provable revision and renders the rest', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'has revision', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 50n,
      seconds: 25,
      text: 'no revision at all',
      revisionSeconds: null,
    });
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 51n,
      seconds: 28,
      text: 'revision only after the cutoff',
      revisionSeconds: 55,
    });
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);
    // Catch-up/attach can have no history snapshot; force that case so the
    // fallback must prove revisions at the cutoff rather than trust a snapshot.
    store.db
      .prepare("DELETE FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
      .run(invocationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.omittedMessages).toBe(2);
    expect(scene.text).toContain('  has revision');
    expect(scene.text).not.toContain('no revision at all');
    expect(scene.text).not.toContain('revision only after the cutoff');
    store.close();
  });

  test('trims history to the character budget and keeps the newest messages', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    for (let index = 0; index < 20; index += 1) {
      ingestion.ingest(groupUpdate(1 + index, 10 + index, `history ${index} ${'x'.repeat(80)}`, 0), at(0));
    }
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(30, 40, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, {
      contextWindow: 320,
      maxOutputTokens: 0,
      toolDefinitionCharacters: 0,
    });

    expect(scene.messageCount).toBe(scene.historyCount + 1);
    expect(scene.historyCount).toBeGreaterThanOrEqual(1);
    expect(scene.historyCount).toBeLessThan(20);
    expect(scene.text).toContain(`  history 19 ${'x'.repeat(80)}`);
    expect(scene.text).not.toContain(`  history 0 ${'x'.repeat(80)}`);
    expect(scene.omittedMessages).toBe(20 - scene.historyCount);
    store.close();
  });
});
