import { afterEach, describe, expect, test } from 'vitest';
import { ConversationContextStore } from '../../src/context/store.ts';
import { ContextRefStore } from '../../src/context/refs.ts';
import { ContextBuilder } from '../../src/context/builder/index.ts';
import { resolveInvocationPolicy } from '../../src/platform/invocation-policy.ts';
import { renderInvocationContext } from '../helpers.ts';
import {
  BOT_ID,
  BOT_USERNAME,
  DAY_WINDOW,
  GROUP_CHAT_ID,
  INSIDE_PERIOD,
  type LooseFields,
  OUTSIDE_PERIOD,
  PRIVATE_CHAT_ID,
  attention,
  bucketCount,
  bucketMessages,
  cleanupDirectories,
  editedGroupMessage,
  groupMessage,
  mentionText,
  privateMessage,
  replyFields,
  setup,
} from './fixtures.ts';

afterEach(async () => {
  await cleanupDirectories();
});

describe('participation gate', () => {
  test('keeps the unrestricted behavior when no participation is configured', async () => {
    const { store, ingestion } = await setup();
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'hello' }), OUTSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    store.close();
  });

  test('stores a quiet message without opening a bucket or a window', async () => {
    const { store, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = ingestion.ingest(groupMessage(1, 10, { text: 'quiet' }), OUTSIDE_PERIOD);
    expect(result.messageId).toBeDefined();
    expect(result.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(0n);
    expect(attention(store)).toBeNull();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('ignores copy payloads and caption-credit joins without opening attention', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [], trigger_keywords: ['wake-bot', 'hello world'] },
    });
    try {
      const blocks = [
        { type: 'buttons', buttons: [{ text: 'Copy', copy_text: { text: 'wake-bot' } }] },
        {
          type: 'photo',
          photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10 }],
          caption: { text: 'hello', credit: 'world' },
        },
      ];
      for (const [index, block] of blocks.entries()) {
        const result = ingestion.ingest(
          groupMessage(index + 1, index + 10, { rich_message: { blocks: [block] } }),
          OUTSIDE_PERIOD,
        );
        expect(result.messageId).toBeDefined();
        expect(result.bucketId).toBeUndefined();
        expect(result.mention).toBeUndefined();
      }
      expect(bucketCount(store)).toBe(0n);
      expect(attention(store)).toBeNull();
      const visible = ingestion.ingest(
        groupMessage(3, 12, {
          rich_message: {
            blocks: [{ type: 'buttons', buttons: [{ text: 'wake-bot', copy_text: { text: 'unrelated' } }] }],
          },
        }),
        OUTSIDE_PERIOD,
      );
      expect(visible.bucketId).toBeDefined();
      expect(attention(store)?.triggerKind).toBe('keyword');
    } finally {
      store.close();
    }
  });

  test('opens a bucket and a window for each trigger kind', async () => {
    const cases: readonly { readonly name: string; readonly fields: LooseFields; readonly kind: string }[] = [
      { name: 'mention', fields: mentionText(), kind: 'mention' },
      { name: 'reply to the bot', fields: replyFields(BOT_ID, true), kind: 'reply_to_bot' },
      { name: 'keyword in text', fields: { text: 'hey 塑料碗' }, kind: 'keyword' },
      {
        name: 'keyword in a caption',
        fields: {
          caption: '塑料碗 look',
          photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10, file_size: 100 }],
        },
        kind: 'keyword',
      },
      {
        name: 'mention in a rich message',
        fields: {
          rich_message: {
            blocks: [
              { type: 'paragraph', text: { type: 'mention', text: `@${BOT_USERNAME}`, username: BOT_USERNAME } },
            ],
          },
        },
        kind: 'mention',
      },
      {
        name: 'keyword in a rich message',
        fields: {
          rich_message: { blocks: [{ type: 'heading', size: 2, text: ['问', { type: 'bold', text: '塑料碗' }] }] },
        },
        kind: 'keyword',
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const { store, ingestion } = await setup({
        global: { active_windows: [DAY_WINDOW], trigger_keywords: ['塑料碗'] },
      });
      const result = ingestion.ingest(groupMessage(index + 1, 10, entry.fields), OUTSIDE_PERIOD);
      expect(`${entry.name}:${String(result.bucketId !== undefined)}`).toBe(`${entry.name}:true`);
      expect(bucketCount(store)).toBe(1n);
      expect(attention(store)).toEqual({
        expiresAt: '2026-08-15T13:05:00.000Z',
        triggerKind: entry.kind,
      });
      store.close();
    }
  });

  test('keeps triggering inside the window and resets it on a new trigger', async () => {
    const { store, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], trigger_keywords: ['塑料碗'], attention_window_seconds: 300 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:05:00.000Z');
    // Let the scheduler claim the first bucket so the next message can open one.
    scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    expect(bucketCount(store)).toBe(1n);
    const inside = ingestion.ingest(groupMessage(2, 11, { text: 'still here' }), new Date('2026-08-15T13:01:00.000Z'));
    expect(inside.bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(2n);
    // A trigger inside the window pushes the expiry out.
    ingestion.ingest(groupMessage(3, 12, { text: 'hey 塑料碗' }), new Date('2026-08-15T13:02:00.000Z'));
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:07:00.000Z');
    store.close();
  });

  test('goes quiet once the window lapses and reopens on the next trigger', async () => {
    const { store, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    const late = ingestion.ingest(groupMessage(2, 11, { text: 'quiet again' }), new Date('2026-08-15T13:02:00.000Z'));
    expect(late.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(1n);
    ingestion.ingest(groupMessage(3, 12, mentionText()), new Date('2026-08-15T13:02:00.000Z'));
    expect(bucketCount(store)).toBe(2n);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:03:00.000Z');
    store.close();
  });

  test('treats every message as triggering inside an active period', async () => {
    const { store, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'good morning' }), INSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    // The schedule alone is enough, so no window is recorded for later.
    expect(attention(store)).toBeNull();
    store.close();
  });

  test('lets a suppressed message join a collecting bucket', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 1 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    // The window has lapsed, but the first bucket is still collecting.
    ingestion.ingest(groupMessage(2, 11, { text: 'quiet companion' }), new Date('2026-08-15T13:00:05.000Z'));
    expect(bucketCount(store)).toBe(1n);
    expect(bucketMessages(store)).toBe(2n);
    store.close();
  });

  test('re-renders a message that was suppressed while the transcript already exists', async () => {
    const { store, config, ingestion, scheduler } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    // First run: a mention opens a bucket and the invocation seeds the context.
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    const [first] = scheduler.processDue(new Date('2026-08-15T13:00:20.000Z'));
    if (first === undefined) {
      throw new Error('Expected the first invocation');
    }
    const conversationId = store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(first)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const contexts = new ConversationContextStore(store);
    const stable = new ContextBuilder(
      store,
      new ContextRefStore(store, { ttlHours: () => config.agent!.context!.ref_ttl_hours }),
    ).buildSystemPrompt(
      config,
      {
        invocationId: first,
        conversationId,
        internalChatId: 0n,
        chatId: BigInt(GROUP_CHAT_ID),
        hostKind: 'telegram',
        threadId: 0n,
        chatType: 'supergroup',
        bucketKind: 'realtime',
        completion: null,
        timezone: config.timezone,
        policy: resolveInvocationPolicy(config, store.orm, {
          hostKind: 'telegram',
          chatId: BigInt(GROUP_CHAT_ID),
          chatType: 'supergroup',
        }),
      },
      false,
      { provider: config.agent!.provider!, model: config.agent!.model! },
    );
    contexts.open(conversationId, stable.systemPromptHash);
    store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(first);

    // The window lapses, so this message never opens a bucket on its own.
    const suppressed = ingestion.ingest(
      groupMessage(2, 11, { text: 'quiet words' }),
      new Date('2026-08-15T13:05:00.000Z'),
    );
    expect(suppressed.bucketId).toBeUndefined();

    // A later trigger opens a bucket whose history section carries it. Because
    // the transcript does not hold it, the next injection still has to render
    // it — otherwise the model would never learn that it was said.
    ingestion.ingest(groupMessage(3, 12, mentionText()), new Date('2026-08-15T13:06:00.000Z'));
    const [second] = scheduler.processDue(new Date('2026-08-15T13:06:20.000Z'));
    if (second === undefined) {
      throw new Error('Expected the second invocation');
    }
    const context = renderInvocationContext(store, config, second, { contextWindow: 200_000, maxOutputTokens: 32_768 });
    expect(context.userPrompt).toContain('quiet words');
    expect(context.userPrompt).toContain('<untrusted_telegram_history>');
    store.close();
  });

  test('never records attention for an edited message', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW], attention_window_seconds: 60 },
    });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    const result = ingestion.ingest(
      editedGroupMessage(2, 10, 1_700_000_030, mentionText()),
      new Date('2026-08-15T13:05:00.000Z'),
    );
    expect(result.bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(1n);
    // The window is neither refreshed nor replaced by the edit.
    expect(attention(store)?.expiresAt).toBe('2026-08-15T13:01:00.000Z');
    expect(
      store.db
        .prepare<[], { count: bigint }>(
          'SELECT COUNT(*) AS count FROM message_revisions WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 10)',
        )
        .get()?.count,
    ).toBe(2n);
    store.close();
  });

  test('never gates a private chat', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW] },
      chatId: PRIVATE_CHAT_ID,
    });
    expect(ingestion.ingest(privateMessage(1, 10, 'hi there'), OUTSIDE_PERIOD).bucketId).toBeDefined();
    expect(bucketCount(store)).toBe(1n);
    expect(attention(store)).toBeNull();
    store.close();
  });

  test('honours a per-chat schedule that overrides the global one', async () => {
    const { store, ingestion } = await setup({
      global: { active_windows: [DAY_WINDOW] },
      chat: { active_windows: [] },
      timezone: 'UTC',
    });
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'quiet' }), INSIDE_PERIOD).bucketId).toBeUndefined();
    expect(bucketCount(store)).toBe(0n);
    store.close();
  });
});
