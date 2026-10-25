import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { ConversationContextStore } from '../../src/context/store.ts';
import {
  ALICE,
  BUCKET_WINDOW_MS,
  FIRST_CHAT,
  cleanupCutTopicDirectories,
  commandUpdate,
  groupUpdate,
  setup,
} from './topic-fixtures.ts';

afterAll(cleanupCutTopicDirectories);

describe('cut_topic', () => {
  test('cut_topic also clears the retained Conversation Context', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    const invocationId = scheduler.processDue(new Date(start.getTime() + BUCKET_WINDOW_MS))[0];
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }
    const conversationId = store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(invocationId)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    // A retained transcript the model would otherwise keep seeing.
    const contexts = new ConversationContextStore(store);
    const { header } = contexts.open(conversationId, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'old note', timestamp: 1 }),
      role: 'user',
    });
    expect(contexts.retained(header)).toHaveLength(1);

    const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date(start.getTime() + 2_000)).command;
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');

    // The truncation has to reach the transcript too: otherwise the command
    // would only trim the rendered history while the model kept its memory.
    const reopened = contexts.header(conversationId);
    expect(reopened?.headSeq).toBe(reopened?.nextSeq);
    expect(contexts.retained(reopened!)).toEqual([]);
    store.close();
  });

  // Regression: Telegram sets `message_thread_id` on more than forum topics — a
  // private chat with thread mode enabled carries one, and so does a reply inside a
  // plain supergroup. Ingestion files both under thread 0, but `parseBotCommand` read
  // the raw field, so `/cut_topic` looked for a Conversation nobody ever wrote,
  // cleared nothing, and still wrote the per-Chat cutoff and replied that it had
  // cleared. That is exactly the failure the cut exists to prevent: rendered history
  // truncated, transcript intact. Observed in production in a private chat.
  const threadedShapes: readonly {
    readonly label: string;
    readonly shape: (update: Update) => Update;
  }[] = [
    {
      label: 'a private chat in thread mode',
      shape: (update) =>
        ({
          ...update,
          message: {
            ...update.message!,
            chat: { id: update.message!.chat.id, type: 'private', first_name: 'Alice' },
            message_thread_id: 7,
          },
        }) as Update,
    },
    {
      label: 'a reply thread of a plain supergroup',
      shape: (update) =>
        ({
          ...update,
          message: { ...update.message!, message_thread_id: 10, reply_to_message_id: 10 },
        }) as Update,
    },
  ];

  for (const { label, shape } of threadedShapes) {
    test(`cut_topic clears the Context when the command carries a thread id from ${label}`, async () => {
      const { store, ingestion, scheduler, commands } = await setup();
      const start = new Date('2026-08-15T00:00:00.000Z');
      ingestion.ingest(shape(groupUpdate(1, 10, 'polluted', FIRST_CHAT)), start);
      const invocationId = scheduler.processDue(new Date(start.getTime() + BUCKET_WINDOW_MS))[0];
      if (invocationId === undefined) {
        throw new Error('Expected an invocation');
      }
      const conversationId = store.db
        .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
        .get(invocationId)?.conversation_id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // Ingestion put this Conversation on thread 0, because the chat is not a forum.
      expect(
        store.db
          .prepare<[bigint], { message_thread_id: bigint }>('SELECT message_thread_id FROM conversations WHERE id = ?')
          .get(conversationId)?.message_thread_id,
      ).toBe(0n);
      const contexts = new ConversationContextStore(store);
      const { header } = contexts.open(conversationId, 'hash-a');
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'old note', timestamp: 1 }),
        role: 'user',
      });
      expect(contexts.retained(header)).toHaveLength(1);

      const command = ingestion.ingest(
        shape(commandUpdate(3, 12, FIRST_CHAT)),
        new Date(start.getTime() + 2_000),
      ).command;
      expect(command?.threadId).toBeUndefined();
      expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');

      const reopened = contexts.header(conversationId);
      expect(reopened?.headSeq).toBe(reopened?.nextSeq);
      expect(contexts.retained(reopened!)).toEqual([]);
      store.close();
    });
  }
});
