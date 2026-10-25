import { expect, test } from 'vitest';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { current, ids, list, matched, type Item, useInvocationSearchFixture } from './search-fixtures.ts';

/**
 * Synthetic coverage for `listInvocations` keyword/time search: public-message
 * matching (frozen `section = 'new'` snapshots plus successful sends only),
 * precision windows, timezone/DST resolution, same-message keyword+time
 * semantics, pagination/isolation and the read-only guarantee.
 */

useInvocationSearchFixture();

test('keyword search matches only public messages; private text and failures stay invisible', () => {
  const items = list({ search: '苹果' });
  expect(items.map((item) => item.id)).toEqual(['403', '401']);

  const invocationA = items.find((item) => item.id === '401');
  expect(invocationA).toBeDefined();
  // Newest first: the bot's send at 00:06:30Z, then the incoming message at 00:00:10Z.
  expect(matched(invocationA as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      room_seq: null,
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
    {
      source: 'incoming',
      telegram_message_id: '1001',
      room_seq: null,
      telegram_send_id: null,
      at: '2025-01-01T00:00:10.000Z',
      text: '苹果 100% 好吃',
    },
  ]);

  const invocationC = items.find((item) => item.id === '403');
  expect(matched(invocationC as Item)).toEqual([
    {
      source: 'incoming',
      telegram_message_id: '1008',
      room_seq: null,
      telegram_send_id: null,
      at: '2024-03-10T06:29:30.000Z',
      text: '苹果在纽约',
    },
  ]);

  // Private assistant reasoning, tool results, failed sends and history-section
  // snapshots never make an invocation searchable.
  expect(ids({ search: '私密思考' })).toEqual([]);
  expect(ids({ search: '工具结果' })).toEqual([]);
  expect(ids({ search: '失败的发送' })).toEqual([]);
  expect(ids({ search: '也许失败' })).toEqual([]);
  expect(ids({ search: '历史里的秘密' })).toEqual([]);
});

test('cross-conversation successful sends remain searchable under their owning invocation', () => {
  const { store } = current();
  store.db.prepare('UPDATE host_sends SET conversation_id = 202 WHERE id = 801').run();
  const items = list({ search: '机器人回复', chat: '-100111' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)[0]).toMatchObject({
    source: 'bot',
    room_seq: null,
    telegram_send_id: '801',
    text: '机器人回复 苹果',
  });
  expect(ids({ search: '机器人回复', chat: '-100222' })).toEqual([]);
});

test('a photo caption is matched and previewed when text is empty', () => {
  const items = list({ search: '夜晚' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)).toEqual([
    {
      source: 'incoming',
      telegram_message_id: '1002',
      room_seq: null,
      telegram_send_id: null,
      at: '2025-01-01T00:05:20.000Z',
      text: '夜晚的猫',
    },
  ]);
});

test('literal wildcard characters never widen the search', () => {
  expect(ids({ search: '100%' })).toEqual(['401']);
  expect(ids({ search: '%' })).toEqual(['401']);
  expect(ids({ search: 'a_b' })).toEqual(['402']);
  expect(ids({ search: 'axb' })).toEqual(['403']);
});

test('without search or time filters the response keeps its original shape', () => {
  const items = list({});
  expect(items.map((item) => item.id)).toEqual(['405', '404', '403', '402', '401']);
  for (const item of items) {
    expect('matched_messages' in item).toBe(false);
  }
});

test('snapshots stay frozen when the live message is edited afterwards', () => {
  const frozen = list({ search: '旧版本' });
  expect(frozen.map((item) => item.id)).toEqual(['402']);
  expect(matched(frozen[0] as Item)[0]?.text).toBe('旧版本文本');
  // The live revision now says 新版本文本, but no snapshot ever carried it.
  expect(ids({ search: '新版本' })).toEqual([]);
});

test('matched messages keep only the five newest, newest first', () => {
  const items = list({ search: '批量' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  const messages = matched(items[0] as Item);
  expect(messages).toHaveLength(5);
  // The oldest match (批量消息 1) falls outside the per-invocation cap.
  expect(messages.map((message) => message.text)).toEqual([
    '批量消息 6',
    '批量消息 5',
    '批量消息 4',
    '批量消息 3',
    '批量消息 2',
  ]);
  expect(messages.map((message) => message.telegram_message_id)).toEqual(['1026', '1025', '1024', '1023', '1022']);
});

test('more than five mixed incoming/bot matches keep the five newest across both sources', () => {
  const items = list({ search: '混流' });
  expect(items.map((item) => item.id)).toEqual(['404']);
  const messages = matched(items[0] as Item);
  // Seven matches; the newest five interleave bot sends and incoming messages,
  // and the two oldest incoming messages (混流 1/2) are dropped.
  expect(messages).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2102',
      room_seq: null,
      telegram_send_id: '812',
      at: '2025-01-01T06:06:00.000Z',
      text: '混流 回复 2',
    },
    {
      source: 'incoming',
      telegram_message_id: '1105',
      room_seq: null,
      telegram_send_id: null,
      at: '2025-01-01T06:05:00.000Z',
      text: '混流 5',
    },
    {
      source: 'bot',
      telegram_message_id: '2101',
      room_seq: null,
      telegram_send_id: '811',
      at: '2025-01-01T06:04:30.000Z',
      text: '混流 回复 1',
    },
    {
      source: 'incoming',
      telegram_message_id: '1104',
      room_seq: null,
      telegram_send_id: null,
      at: '2025-01-01T06:04:00.000Z',
      text: '混流 4',
    },
    {
      source: 'incoming',
      telegram_message_id: '1103',
      room_seq: null,
      telegram_send_id: null,
      at: '2025-01-01T06:03:00.000Z',
      text: '混流 3',
    },
  ]);
});

test('same-second matches order by the Telegram message ID numerically, not as text', () => {
  const items = list({ search: '同秒' });
  expect(items.map((item) => item.id)).toEqual(['405']);
  const messages = matched(items[0] as Item);
  // All four share one second. Text comparison would put '9999999999999999'
  // and the 2^53-scale ids before the longer '10000000000000000'; the integer
  // order puts it first, and keeps >2^53 ids exact instead of float-rounded.
  expect(messages.map((message) => message.telegram_message_id)).toEqual([
    '10000000000000000',
    '9999999999999999',
    '9007199254740993',
    '9007199254740992',
  ]);
  expect(messages.map((message) => message.source)).toEqual(['incoming', 'bot', 'incoming', 'incoming']);
  for (const message of messages) {
    expect(message.at).toBe('2025-01-01T07:00:00.000Z');
  }
  expect(messages[1]).toEqual({
    source: 'bot',
    telegram_message_id: '9999999999999999',
    room_seq: null,
    telegram_send_id: '813',
    at: '2025-01-01T07:00:00.000Z',
    text: '同秒 回复',
  });
});

test('previews are truncated to 2000 characters', () => {
  const items = list({ search: '超长' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  expect(matched(items[0] as Item)[0]?.text).toHaveLength(2000);
});

test('pagination, chat and state filters keep intersecting with the search', () => {
  const first = listInvocations(current().store.orm, { search: '苹果', limit: '1' }, current().config);
  expect(first.items.map((item) => (item as unknown as Item).id)).toEqual(['403']);
  expect(first.next_cursor).toBe('403');
  const second = listInvocations(current().store.orm, { search: '苹果', limit: '1', cursor: '403' }, current().config);
  expect(second.items.map((item) => (item as unknown as Item).id)).toEqual(['401']);
  expect(second.next_cursor).toBeNull();

  expect(ids({ search: '苹果', chat: '-100222' })).toEqual(['403']);
  expect(ids({ search: '苹果', chat: '-100111' })).toEqual(['401']);
  expect(ids({ search: '苹果', state: 'failed' })).toEqual([]);
  expect(ids({ search: '苹果在纽约' })).toEqual(['403']);
});

test('search and time filters never write', () => {
  const tables = [
    'messages',
    'message_revisions',
    'invocation_messages',
    'host_sends',
    'tool_calls',
    'agent_messages',
    'invocations',
  ];
  const snapshot = (): { changes: bigint; counts: bigint[] } => ({
    changes: (current().store.db.prepare('SELECT total_changes() AS value').get() as { value: bigint }).value,
    counts: tables.map(
      (table) =>
        (current().store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: bigint }).value,
    ),
  });
  const before = snapshot();
  list({ search: '苹果' });
  list({ search: '苹果', at: '2025-01-01T08:06', chat: '-100111' });
  list({ at: '2025-01-01T08:00', chat: '-100111' });
  list({ from: '2025-01-01T00:00', to: '2025-01-02T00:00' });
  list({ search: '批量' });
  list({ search: '混流' });
  list({ search: '同秒' });
  listInvocations(current().store.orm, {});
  expect(snapshot()).toEqual(before);
});
