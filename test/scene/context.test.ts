import { afterAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { buildSceneContext } from '../../src/context/scene/index.ts';
import {
  ALICE,
  BOB,
  DEFAULT_OPTIONS,
  FORUM_CHAT,
  GROUP_CHAT,
  TOPIC_A,
  TOPIC_B,
  at,
  chatRowId,
  cleanupDirectories,
  conversationIdOf,
  editUpdate,
  flush,
  forumUpdate,
  groupUpdate,
  insertRawMessage,
  invocationBucket,
  latestInvocation,
  setup,
  telegramMessage,
} from './context-fixtures.ts';

afterAll(cleanupDirectories);

describe('scene context', () => {
  test('builds a text-only scene from the frozen opening batch and provable history', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'old one', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.cutoffAt).toBe(at(50).toISOString());
    expect(scene.chatId).toBe(GROUP_CHAT);
    expect(scene.threadId).toBe(0n);
    expect(scene.conversationId).toBe(conversationId);
    expect(scene.bucketId).toBe(invocationBucket(store, invocationId));
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.omittedMessages).toBe(0);
    expect(scene.omittedImages).toBe(0);
    expect(scene.mediaIds).toEqual([]);
    expect(scene.replyMessageIds).toEqual(['10', '11']);
    expect(scene.text.startsWith('<runtime_state>\ncurrent_time: ')).toBe(true);
    expect(scene.text).toContain(' (UTC)');
    expect(scene.text).toContain('<untrusted_telegram_history>');
    expect(scene.text).toContain('[10 00:00:00 uid:42 @alice] Alice\n  old one');
    expect(scene.text).toContain('<untrusted_new_messages>');
    expect(scene.text).toContain('[11 00:00:30 uid:42 @alice] Alice\n  trigger text');
    expect(scene.text).toContain('<memory_list>\n</memory_list>');
    store.close();
  });

  test("keeps only the same conversation's history (topic isolation)", async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(forumUpdate(1, 10, 'topic A old', TOPIC_A, 0), at(0));
    ingestion.ingest(forumUpdate(2, 11, 'topic B old', TOPIC_B, 5), at(5));
    flush(fixture, 30);
    ingestion.ingest(forumUpdate(3, 12, 'topic A trigger', TOPIC_A, 40), at(40));
    flush(fixture, 60);
    const invocationId = latestInvocation(store, conversationIdOf(store, FORUM_CHAT, TOPIC_A));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.threadId).toBe(TOPIC_A);
    expect(scene.historyCount).toBe(1);
    expect(scene.messageCount).toBe(2);
    expect(scene.text).toContain('  topic A old');
    expect(scene.text).toContain('  topic A trigger');
    expect(scene.text).not.toContain('topic B old');
    store.close();
  });

  test("keeps the bot's old message in history but never its later reply", async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'human words', 0), at(0));
    flush(fixture, 20);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const chatId = chatRowId(store, GROUP_CHAT);
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 20n,
      seconds: 25,
      text: 'bot old words',
      sentByBot: true,
    });
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationId);
    // The actual reply the run produced, ingested long after the batch was frozen.
    insertRawMessage(fixture, {
      conversationId,
      chatId,
      telegramMessageId: 21n,
      seconds: 60,
      text: 'bot answer words',
      sentByBot: true,
    });

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.historyCount).toBe(2);
    expect(scene.messageCount).toBe(3);
    expect(scene.text).toContain('[20 00:00:25 you uid:999 @surowan_test] Surowan\n  bot old words');
    expect(scene.text).not.toContain('bot answer words');
    store.close();
  });

  test('renders replies like production and lists only reply targets visible in the scene', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'first message', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(
      groupUpdate(2, 11, 'reply inside', 30, { replyTo: { messageId: 10, text: 'first message' } }),
      at(30),
    );
    ingestion.ingest(
      groupUpdate(3, 12, 'reply outside', 31, { replyTo: { messageId: 999, text: 'outside message' } }),
      at(31),
    );
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.messageCount).toBe(3);
    expect(scene.replyMessageIds).toEqual(['10', '11', '12']);
    // The target is itself in the scene, so the stored quote is not repeated.
    expect(scene.text).toContain('re:10');
    expect(scene.text).not.toContain('> Alice: first message');
    // An invisible target keeps its quoted copy but is not claimed as visible.
    expect(scene.text).toContain('re:999');
    expect(scene.text).toContain('> Alice: outside message');
    store.close();
  });

  test('renders spoiler markup like production in the opening batch, fallback history and reply quotes', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    const spoilerUpdate = (updateId: number, messageId: number, text: string, seconds: number, extra = {}): Update =>
      ({
        update_id: updateId,
        message: {
          ...telegramMessage(GROUP_CHAT, messageId, seconds, ALICE),
          text,
          entities: [{ type: 'spoiler', offset: 2, length: 2 }],
          ...extra,
        },
      }) as unknown as Update;
    ingestion.ingest(spoilerUpdate(1, 10, '历史剧透内容', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(
      spoilerUpdate(2, 11, '新的剧透消息', 30, {
        reply_to_message: {
          ...telegramMessage(GROUP_CHAT, 999, 5, BOB),
          text: '引用剧透原文',
          entities: [{ type: 'spoiler', offset: 2, length: 2 }],
        },
      }),
      at(30),
    );
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    // Without a frozen history snapshot the scene rebuilds history from the
    // revision row, which must recover the spans from its raw fragment too.
    store.db
      .prepare("DELETE FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
      .run(invocationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.text).toContain('[10 00:00:00 uid:42 @alice] Alice\n  历史<tg-spoiler>剧透</tg-spoiler>内容');
    expect(scene.text).toContain(
      '  > Bob: 引用<tg-spoiler>剧透</tg-spoiler>原文\n  新的<tg-spoiler>剧透</tg-spoiler>消息',
    );
    store.close();
  });

  test('renders Markdown and in-place rich media like production in the opening batch and fallback history', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...telegramMessage(GROUP_CHAT, 10, 0, ALICE),
          rich_message: {
            blocks: [
              { type: 'heading', size: 1, text: 'Menu' },
              {
                type: 'photo',
                photo: [{ file_id: 'menu-photo', file_unique_id: 'menu-photo-unique', width: 640, height: 480 }],
                caption: { text: 'Noodles' },
              },
              { type: 'paragraph', text: [{ type: 'bold', text: 'Price' }, ': 12'] },
            ],
          },
        },
      } as unknown as Update,
      at(0),
    );
    flush(fixture, 20);
    ingestion.ingest(
      {
        update_id: 2,
        message: {
          ...telegramMessage(GROUP_CHAT, 11, 30, ALICE),
          text: 'see docs',
          entities: [{ type: 'text_link', offset: 4, length: 4, url: 'https://example.com/' }],
        },
      } as unknown as Update,
      at(30),
    );
    flush(fixture, 50);
    const invocationId = latestInvocation(store, conversationIdOf(store, GROUP_CHAT, 0n));
    // The fallback rebuilds history from the revision row and must recover the
    // media slots from its raw fragment, as the live snapshot does.
    store.db
      .prepare("DELETE FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
      .run(invocationId);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.text).toContain(
      '[10 00:00:00 uid:42 @alice] Alice\n  # Menu\n  \n  [photo media_unavailable 640x480]\n  Noodles\n  \n  **Price**: 12',
    );
    expect(scene.text).toContain('[11 00:00:30 uid:42 @alice] Alice\n  see [docs](https://example.com/)');
    store.close();
  });

  test('renders the revision that existed at the cutoff, not later edits', async () => {
    const fixture = await setup();
    const { store, ingestion } = fixture;
    ingestion.ingest(groupUpdate(1, 10, 'original words', 0), at(0));
    flush(fixture, 20);
    ingestion.ingest(groupUpdate(2, 11, 'trigger text', 30), at(30));
    flush(fixture, 50);
    const conversationId = conversationIdOf(store, GROUP_CHAT, 0n);
    const invocationId = latestInvocation(store, conversationId);
    // Both the history message and the trigger are edited after the cutoff.
    ingestion.ingest(editUpdate(3, 10, 'edited words', 60), at(60));
    ingestion.ingest(editUpdate(4, 11, 'edited trigger', 61), at(61));

    const currentRevision = store.orm
      .all<{ revision_no: bigint }>(
        sql`SELECT r.revision_no FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id
            WHERE m.chat_id = ${chatRowId(store, GROUP_CHAT)} AND m.telegram_message_id = 10`,
      )
      .at(0);
    expect(currentRevision?.revision_no).toBe(2n);

    const scene = buildSceneContext(store, fixture.loaded.config, invocationId, DEFAULT_OPTIONS);

    expect(scene.text).toContain('  original words');
    expect(scene.text).not.toContain('edited words');
    expect(scene.text).toContain('  trigger text');
    expect(scene.text).not.toContain('edited trigger');
    store.close();
  });
});
