import { runStartupCatchUp } from '../../src/startup-catch-up.ts';
import { ProactiveReplyGate } from '../../src/orchestration/proactive-reply.ts';
import { afterEach, expect, test } from 'vitest';
import { parseBotCommand, BOT_COMMANDS } from '../../src/orchestration/bot-commands/index.ts';
import { matchTriggerKind } from '../../src/platform/participation.ts';
import {
  BOT_IDENTITY,
  BOT_ID,
  BOT_USERNAME,
  cleanupDirectories,
  PRIVATE_CHAT_ID,
  privateMessage,
  editedGroupMessage,
  setup,
  groupMessage,
  mentionText,
  replyFields,
  OUTSIDE_PERIOD,
  attention,
  bucketMessages,
} from './fixtures.ts';

// Failure contracts: command interception, foreign/bot identity, ignored users,
// attention leakage, companion adoption, bucket joins, inheritance and catch-up.
afterEach(cleanupDirectories);
const ask = (token = '/ask') => ({
  text: `${token} question`,
  entities: [{ type: 'bot_command', offset: 0, length: token.length }],
});
test('ask recognition shares command scoping without becoming a control command', () => {
  for (const token of ['/ask', '/ASK', `/ask@${BOT_USERNAME}`]) {
    const message = groupMessage(1, 1, ask(token)).message!;
    expect(matchTriggerKind(message, BOT_IDENTITY, [])).toBe('ask');
    expect(parseBotCommand(message, BOT_USERNAME)).toBeNull();
  }
  expect(matchTriggerKind(groupMessage(1, 1, ask('/ask@OtherBot')).message!, BOT_IDENTITY, [])).toBeNull();
  expect(
    matchTriggerKind(
      groupMessage(1, 1, { ...ask(), from: { id: 88, is_bot: true, first_name: 'Bot' } }).message!,
      BOT_IDENTITY,
      [],
    ),
  ).toBeNull();
  expect(
    matchTriggerKind(
      groupMessage(1, 1, {
        ...ask(),
        sender_chat: { id: -123, type: 'supergroup', title: 'Group' },
        from: { id: 88, is_bot: true, first_name: 'GroupAnonymousBot' },
      }).message!,
      BOT_IDENTITY,
      [],
    ),
  ).toBe('ask');
  expect(BOT_COMMANDS.some((entry) => entry.command === 'ask')).toBe(true);
});
test('normal ask stores text, opens configured bucket, records ask attention and typing', async () => {
  const { store, ingestion, config } = await setup({ global: { active_windows: [] } });
  try {
    const result = ingestion.ingest(groupMessage(1, 10, ask()), OUTSIDE_PERIOD);
    expect(result.command).toBeUndefined();
    expect(result.mention).toBeDefined();
    expect(result.messageId).toBeDefined();
    expect(attention(store)?.triggerKind).toBe('ask');
    expect(store.db.prepare('SELECT window_seconds FROM buckets').get()).toMatchObject({
      window_seconds: BigInt(config.telegram.bucket_window_seconds),
    });
    expect(store.db.prepare('SELECT text FROM message_revisions').get()).toMatchObject({ text: '/ask question' });
  } finally {
    store.close();
  }
});
test('ask-only stores history but only asks join zero timing buckets without attention', async () => {
  const { store, ingestion } = await setup({ global: { ask_only: true, trigger_keywords: ['wake'] } });
  try {
    for (const [i, fields] of [
      { text: 'plain' },
      mentionText(),
      replyFields(BOT_ID, true),
      { text: 'wake' },
      { text: 'other bot', from: { id: 88, is_bot: true, first_name: 'Bot' } },
    ].entries()) {
      expect(ingestion.ingest(groupMessage(i + 1, i + 10, fields), OUTSIDE_PERIOD).bucketId).toBeUndefined();
    }
    const result = ingestion.ingest(groupMessage(10, 20, ask()), OUTSIDE_PERIOD);
    expect(result.bucketId).toBeDefined();
    expect(bucketMessages(store)).toBe(1n);
    expect(store.db.prepare('SELECT window_seconds, max_seconds, bump_seconds FROM buckets').get()).toEqual({
      window_seconds: 0n,
      max_seconds: 0n,
      bump_seconds: 0n,
    });
    expect(ingestion.ingest(groupMessage(11, 21, { text: 'after' }), OUTSIDE_PERIOD).bucketId).toBeUndefined();
    expect(bucketMessages(store)).toBe(1n);
    expect(attention(store)).toBeNull();
  } finally {
    store.close();
  }
});
test('chat false overrides global ask-only', async () => {
  const { store, ingestion } = await setup({
    global: { ask_only: true, active_windows: [{ start: '00:00', end: '24:00' }] },
    chat: { ask_only: false },
  });
  try {
    expect(ingestion.ingest(groupMessage(1, 10, { text: 'normal' }), OUTSIDE_PERIOD).bucketId).toBeDefined();
  } finally {
    store.close();
  }
});

test('ignored members can ask live and during catch-up, but their other inputs and edits stay dropped', async () => {
  const { store, ingestion } = await setup({ ignored: [42], global: { ask_only: true } });
  try {
    for (const [i, fields] of [{ text: 'plain' }, mentionText(), replyFields(BOT_ID, true)].entries()) {
      expect(ingestion.ingest(groupMessage(i + 1, i + 1, fields), OUTSIDE_PERIOD)).toEqual({});
    }
    expect(ingestion.ingest(groupMessage(10, 10, ask()), OUTSIDE_PERIOD).bucketId).toBeDefined();
    expect(ingestion.ingestCatchUp(groupMessage(11, 11, ask()), OUTSIDE_PERIOD).messageId).toBeDefined();
    expect(ingestion.ingest(editedGroupMessage(12, 10, 1700000010, ask()), OUTSIDE_PERIOD)).toEqual({});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2n });
  } finally {
    store.close();
  }
});
for (const askOnly of [true, false]) {
  test(`ask is direct with zero proactive probability (ask-only=${askOnly})`, async () => {
    const { store, ingestion, configStore } = await setup({
      global: { ask_only: askOnly, active_windows: [] },
    });
    try {
      const result = ingestion.ingest(groupMessage(1, 10, ask()), OUTSIDE_PERIOD);
      const row = store.db
        .prepare<[], { conversation_id: bigint; chat_id: bigint }>('SELECT conversation_id, chat_id FROM messages')
        .get()!;
      const gate = new ProactiveReplyGate(store.orm, configStore, { bot: BOT_IDENTITY, random: () => 1 });
      expect(
        gate.decide({
          bucketId: result.bucketId!,
          conversationId: row.conversation_id,
          chatId: row.chat_id,
          telegramChatId: -1001234567890n,
          chatType: 'supergroup',
          chat: { proactive_reply: { enabled: true, base_probability: 0, increment: 0, hard_pity: 100 } },
          keywords: [],
          now: OUTSIDE_PERIOD,
        }),
      ).toMatchObject({ allowed: true, reason: 'direct', triggerKind: 'ask' });
    } finally {
      store.close();
    }
  });
}
for (const hasAsk of [true, false]) {
  test(`ask-only catch-up filters backlog (ask=${hasAsk})`, async () => {
    const { store, ingestion, scheduler, commands } = await setup({ global: { ask_only: true }, ignored: [42] });
    try {
      const updates = [
        groupMessage(1, 10, { text: 'history', from: { id: 43, is_bot: false, first_name: 'Bob' } }),
        ...(hasAsk ? [groupMessage(2, 11, ask(`/ask@${BOT_USERNAME}`))] : []),
      ];
      const result = await runStartupCatchUp({
        api: {
          getUpdates: async (options) =>
            updates
              .filter((u) => options.offset === undefined || u.update_id >= options.offset)
              .slice(0, options.limit),
        },
        store,
        ingestion,
        scheduler,
        commands,
        allowedUpdates: ['message'],
        now: () => OUTSIDE_PERIOD,
      });
      expect(result.invocationIds).toHaveLength(hasAsk ? 1 : 0);
      expect(store.db.prepare('SELECT state, error_code FROM buckets').get()).toMatchObject(
        hasAsk ? { state: 'queued', error_code: null } : { error_code: 'participation_gated' },
      );
      expect(bucketMessages(store)).toBe(1n);
      expect(attention(store)).toBeNull();
    } finally {
      store.close();
    }
  });
}

test('global ask-only never gates private messages; edits store revisions without triggering', async () => {
  const privateHarness = await setup({ global: { ask_only: true }, chatId: PRIVATE_CHAT_ID });
  try {
    expect(privateHarness.ingestion.ingest(privateMessage(1, 1, 'hello'), OUTSIDE_PERIOD).bucketId).toBeDefined();
  } finally {
    privateHarness.store.close();
  }
  const { store, ingestion } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingest(groupMessage(1, 1, { text: 'plain' }), OUTSIDE_PERIOD);
    const result = ingestion.ingest(editedGroupMessage(2, 1, 1700000010, ask()), OUTSIDE_PERIOD);
    expect(result.bucketId).toBeUndefined();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM message_revisions').get()).toEqual({ n: 2n });
    expect(attention(store)).toBeNull();
  } finally {
    store.close();
  }
});

test('editing a catch-up plain message into ask cannot wake ask-only', async () => {
  const { store, ingestion, scheduler } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingestCatchUp(groupMessage(1, 1, { text: 'plain' }), OUTSIDE_PERIOD);
    ingestion.ingestCatchUp(editedGroupMessage(2, 1, 1700000010, ask()), OUTSIDE_PERIOD);
    expect(scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD)).toHaveLength(0);
    expect(store.db.prepare('SELECT error_code FROM buckets').get()).toEqual({ error_code: 'participation_gated' });
  } finally {
    store.close();
  }
});
