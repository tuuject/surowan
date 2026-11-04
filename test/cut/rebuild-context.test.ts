import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { BotCommandService } from '../../src/orchestration/bot-commands/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import { StaleContextError } from '../../src/context/store/types.ts';
import { sleep } from '../helpers.ts';
import {
  ALICE,
  BUCKET_WINDOW_MS,
  FIRST_CHAT,
  SECOND_CHAT,
  cleanupCutTopicDirectories,
  commandUpdate,
  forumUpdate,
  groupUpdate,
  invocationHistory,
  setup,
} from './topic-fixtures.ts';

afterAll(cleanupCutTopicDirectories);

const REBUILD_COMMAND_LENGTH = '/rebuild_context'.length;

function rebuildCommandUpdate(updateId: number, messageId: number, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/rebuild_context',
      entities: [{ offset: 0, length: REBUILD_COMMAND_LENGTH, type: 'bot_command' }],
    },
  };
}

function conversationIdOf(store: SqliteStore, telegramChatId: bigint, threadId = 0n): bigint | undefined {
  return store.db
    .prepare<[bigint, bigint], { id: bigint }>(
      'SELECT v.id FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE c.telegram_chat_id = ? AND v.message_thread_id = ?',
    )
    .get(telegramChatId, threadId)?.id;
}

function seedContext(store: SqliteStore, conversationId: bigint, content: string): ConversationContextStore {
  const contexts = new ConversationContextStore(store);
  const { header } = contexts.open(conversationId, 'hash-a');
  contexts.append(header, {
    invocationId: null,
    isCheckpoint: true,
    estTokens: 10,
    json: JSON.stringify({ role: 'user', content, timestamp: 1 }),
    role: 'user',
  });
  return contexts;
}

describe('rebuild_context', () => {
  test('discards the continuous Context but keeps the recent chat history', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);
    ingestion.ingest(groupUpdate(1, 10, 'old', FIRST_CHAT), at(0));
    ingestion.ingest(groupUpdate(2, 11, 'recent', FIRST_CHAT), at(1));
    const conversationId = conversationIdOf(store, FIRST_CHAT);
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const contexts = seedContext(store, conversationId, 'accumulated transcript');
    const chatId = store.db
      .prepare<[bigint], { chat_id: bigint }>('SELECT chat_id FROM conversations WHERE id = ?')
      .get(conversationId)?.chat_id;
    if (chatId === undefined) {
      throw new Error('Expected a chat');
    }
    store.db
      .prepare(
        "INSERT INTO memo_pad_entries(id, chat_id, summary, detail, created_at, updated_at) VALUES ('mem_keep', ?, 'keep me', 'persistent detail', '2026-01-01', '2026-01-01')",
      )
      .run(chatId);
    const command = ingestion.ingest(rebuildCommandUpdate(3, 12, FIRST_CHAT), at(2)).command;
    expect(command).toEqual({ name: 'rebuild_context', messageId: 12n });
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('丢弃');

    const rebuilt = contexts.header(conversationId);
    if (rebuilt === undefined) {
      throw new Error('Expected a context header');
    }
    expect(rebuilt.headSeq).toBe(1n);
    expect(rebuilt.nextSeq).toBe(1n);
    expect(contexts.retained(rebuilt)).toEqual([]);
    // Rebuilding is not a cut: the history boundary is untouched, so the next
    // invocation still sees both earlier messages.
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM memo_pad_entries').get()?.count).toBe(
      1n,
    );
    expect(
      invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 4, 13, 'trigger', at(BUCKET_WINDOW_MS / 1_000 + 2)),
    ).toEqual(['old', 'recent']);
    store.close();
  });

  test('keeps the cut_topic boundary, so cut history never comes back', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), at(0));
    const cut = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), at(1)).command;
    await commands.run(cut!, FIRST_CHAT, ALICE);
    ingestion.ingest(groupUpdate(3, 12, 'after cut', FIRST_CHAT), at(2));
    const conversationId = conversationIdOf(store, FIRST_CHAT);
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    seedContext(store, conversationId, 'stale transcript');

    const rebuild = ingestion.ingest(rebuildCommandUpdate(4, 13, FIRST_CHAT), at(3)).command;
    expect(await commands.run(rebuild!, FIRST_CHAT, ALICE)).toContain('丢弃');
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(11n);
    expect(
      invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 5, 14, 'trigger', at(BUCKET_WINDOW_MS / 1_000 + 4)),
    ).toEqual(['after cut']);
    store.close();
  });

  test('aborts the running Invocation and fences its late Context writes', async () => {
    const { store, ingestion, configStore } = await setup();
    let abortReason: string | undefined;
    const gate = Promise.withResolvers<void>();
    const scheduler = new BucketScheduler(store, configStore, async (_invocationId, _snapshot, signal) => {
      signal.addEventListener('abort', () => {
        abortReason = (signal.reason as Error | undefined)?.message;
      });
      await gate.promise;
      return { state: 'completed', reason: 'done' };
    });
    const commands = new BotCommandService(store, configStore, scheduler);
    try {
      scheduler.start();
      // Backdated so the bucket is already past its window and launches at once.
      ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), new Date(Date.now() - BUCKET_WINDOW_MS - 1_000));
      scheduler.wake();
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get() ===
          undefined
      ) {
        await sleep(10);
      }
      expect(
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get(),
      ).not.toBeUndefined();
      const conversationId = conversationIdOf(store, FIRST_CHAT);
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // The header an in-flight run holds, taken before the rebuild.
      const contexts = seedContext(store, conversationId, 'pre-rebuild transcript');
      const stale = contexts.header(conversationId);
      if (stale === undefined) {
        throw new Error('Expected a context header');
      }
      contexts.append(stale, {
        invocationId: null,
        isCheckpoint: false,
        estTokens: 10,
        json: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'reply' }], timestamp: 2 }),
        role: 'assistant',
      });

      const command = ingestion.ingest(rebuildCommandUpdate(2, 11, FIRST_CHAT), new Date()).command;
      expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('丢弃');
      expect(abortReason).toBe('context_rebuild');
      expect(contexts.retained(contexts.header(conversationId)!)).toEqual([]);
      // A late message_end or GC from the aborted run cannot append into or move
      // the head of the rebuilt history.
      expect(() =>
        contexts.append(stale, {
          invocationId: null,
          isCheckpoint: true,
          estTokens: 10,
          json: JSON.stringify({ role: 'user', content: 'late write', timestamp: 9 }),
          role: 'user',
        }),
      ).toThrow(StaleContextError);
      expect(() => contexts.advanceHead(stale, 2n)).toThrow(StaleContextError);
    } finally {
      gate.resolve();
      await scheduler.stop();
      store.close();
    }
  }, 30_000);

  test('only rebuilds its own Forum Topic', async () => {
    const { store, ingestion, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);
    ingestion.ingest(forumUpdate(1, 10, 'topic A', 100), at(0));
    ingestion.ingest(forumUpdate(2, 11, 'topic B', 200), at(1));
    const topicA = conversationIdOf(store, FIRST_CHAT, 100n);
    const topicB = conversationIdOf(store, FIRST_CHAT, 200n);
    if (topicA === undefined || topicB === undefined) {
      throw new Error('Expected both forum conversations');
    }
    const contextsA = seedContext(store, topicA, 'topic A transcript');
    const contextsB = seedContext(store, topicB, 'topic B transcript');

    const update = forumUpdate(3, 12, '/rebuild_context', 100);
    update.message!.entities = [{ offset: 0, length: REBUILD_COMMAND_LENGTH, type: 'bot_command' }];
    const command = ingestion.ingest(update, at(2)).command;
    expect(command).toEqual({ name: 'rebuild_context', messageId: 12n, threadId: 100n });
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('丢弃');

    expect(contextsA.retained(contextsA.header(topicA)!)).toEqual([]);
    expect(contextsB.retained(contextsB.header(topicB)!)).toHaveLength(1);
    store.close();
  });

  test('is admin-only, safe to repeat, and a no-op before a Context exists', async () => {
    const { store, ingestion, commands } = await setup();
    const denied = ingestion.ingest(rebuildCommandUpdate(1, 10, FIRST_CHAT), new Date()).command;
    expect(await commands.run(denied!, FIRST_CHAT, { id: 99n, name: 'Mallory', username: 'mallory' })).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_contexts').get()?.count,
    ).toBe(0n);

    // No stored Chat at all: the command still answers instead of failing.
    expect(await commands.run({ name: 'rebuild_context' }, SECOND_CHAT, ALICE)).toContain('尚未入库');

    ingestion.ingest(groupUpdate(2, 11, 'hello', FIRST_CHAT), new Date('2026-08-15T00:00:00.000Z'));
    const conversationId = conversationIdOf(store, FIRST_CHAT);
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const command = ingestion.ingest(rebuildCommandUpdate(3, 12, FIRST_CHAT), new Date()).command;
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('还没有连续 Context');
    const contexts = seedContext(store, conversationId, 'accumulated');
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('丢弃');
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('丢弃');
    expect(contexts.retained(contexts.header(conversationId)!)).toEqual([]);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    store.close();
  });
});
