import { expect, test } from 'vitest';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { codeOf, current, ids, list, matched, type Item, useInvocationSearchFixture } from './search-fixtures.ts';

/**
 * Precision windows, timezone/DST resolution and parameter-level errors for
 * `listInvocations` time filters, including same-message keyword+time semantics.
 */

useInvocationSearchFixture();

test('at is a precision window resolved in the chat timezone, not the host timezone', () => {
  // 2025-01-01T08:00 Asia/Shanghai == 00:00Z-00:01Z.
  const minute = list({ at: '2025-01-01T08:00', chat: '-100111' });
  expect(minute.map((item) => item.id)).toEqual(['401']);
  expect(matched(minute[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1005', '1001']);

  // A minute window starting one second earlier excludes the 00:00:10.000Z message.
  expect(ids({ at: '2025-01-01T08:00:09', chat: '-100111' })).toEqual([]);
  expect(matched(list({ at: '2025-01-01T08:00:10', chat: '-100111' })[0] as Item)).toHaveLength(2);
  // Fractional precision narrows the window to 100ms.
  expect(
    matched(list({ at: '2025-01-01T08:00:10.5', chat: '-100111' })[0] as Item).map(
      (message) => message.telegram_message_id,
    ),
  ).toEqual(['1005']);
  expect(
    matched(list({ at: '2025-01-01T08:00:10.500', chat: '-100111' })[0] as Item).map(
      (message) => message.telegram_message_id,
    ),
  ).toEqual(['1005']);

  // Without a chat the global timezone (UTC here) applies: 00:00Z-00:01Z.
  expect(ids({ at: '2025-01-01T00:00' })).toEqual(['401']);
  // An explicit offset in the value wins over both.
  expect(ids({ at: '2025-01-01T08:00+08:00' })).toEqual(['401']);
  expect(ids({ at: '2025-01-01T08:00:10+08:00' })).toEqual(['401']);
});

test('from is inclusive and to is exclusive, including fractional bounds', () => {
  const window = list({ from: '2025-01-01T08:00:10.500', to: '2025-01-01T08:05:20', chat: '-100111' });
  expect(window.map((item) => item.id)).toEqual(['401']);
  expect(matched(window[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1005']);

  const upperBoundary = list({ to: '2025-01-01T08:00:10.500', chat: '-100111' });
  expect(matched(upperBoundary[0] as Item).map((message) => message.telegram_message_id)).toEqual(['1001']);

  expect(codeOf(() => list({ from: '2025-01-01T10:00', to: '2025-01-01T09:00' }))).toBe('invalid_time_range');
});

test('keyword and time must hit the same message', () => {
  // Only the bot message carries 苹果 inside the 00:06Z minute.
  const items = list({ search: '苹果', at: '2025-01-01T08:06', chat: '-100111' });
  expect(items.map((item) => item.id)).toEqual(['401']);
  expect(matched(items[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      room_seq: null,
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
  ]);
  expect(ids({ search: '苹果', at: '2025-01-01T08:10', chat: '-100111' })).toEqual([]);
  // 402 has a public message at 01:00Z, but not one containing 100%.
  expect(ids({ search: '100%', at: '2025-01-01T09:00', chat: '-100111' })).toEqual([]);
});

test('bot time prefers the outgoing message telegram_date and falls back to the send time', () => {
  const preferred = list({ search: '机器人' });
  expect(matched(preferred[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '2001',
      room_seq: null,
      telegram_send_id: '801',
      at: '2025-01-01T00:06:30.000Z',
      text: '机器人回复 苹果',
    },
  ]);
  // The send finished at 00:07:00Z, one window later; the outgoing row wins.
  expect(ids({ search: '机器人', at: '2025-01-01T08:06:30', chat: '-100111' })).toEqual(['401']);
  expect(ids({ search: '机器人', at: '2025-01-01T08:07', chat: '-100111' })).toEqual([]);

  // A successful send whose outgoing message row is missing falls back to
  // `finished_at` and to the text Telegram accepted.
  const fallback = list({ search: '没有落盘的发送' });
  expect(fallback.map((item) => item.id)).toEqual(['402']);
  expect(matched(fallback[0] as Item)).toEqual([
    {
      source: 'bot',
      telegram_message_id: '3003',
      room_seq: null,
      telegram_send_id: '803',
      at: '2025-01-01T03:00:00.000Z',
      text: '没有落盘的发送',
    },
  ]);
  expect(ids({ at: '2025-01-01T11:00', chat: '-100111' })).toEqual(['402']);
});

test('the host timezone is never consulted and DST gaps/overlaps are rejected with guidance', () => {
  // 01:29 America/New_York is 06:29Z; a host-timezone reading of the same value
  // would look at a completely different window and find nothing.
  const items = list({ at: '2024-03-10T01:29', chat: '-100222' });
  expect(items.map((item) => item.id)).toEqual(['403']);
  expect(matched(items[0] as Item)[0]?.telegram_message_id).toBe('1008');

  expect(codeOf(() => list({ at: '2024-03-10T02:30', chat: '-100222' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_at');
  expect(codeOf(() => list({ from: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_from');
  expect(codeOf(() => list({ to: '2024-11-03T01:30', chat: '-100222' }))).toBe('invalid_to');
  // An explicit offset resolves the same wall clock without guessing: EST here.
  expect(ids({ at: '2024-03-10T01:29:30-05:00', chat: '-100222' })).toEqual(['403']);
  expect(ids({ at: '2024-03-10T02:30:00-04:00', chat: '-100222' })).toEqual([]);
});

test('invalid inputs fail fast with parameter-specific codes', () => {
  expect(codeOf(() => list({ at: '2025-02-30T10:00' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: 'not-a-date' }))).toBe('invalid_at');
  expect(codeOf(() => list({ at: '2025-01-01T10:00:00+15:00' }))).toBe('invalid_at');
  expect(codeOf(() => list({ from: '2025-13-01T00:00' }))).toBe('invalid_from');
  expect(codeOf(() => list({ to: '2025-01-01T25:00' }))).toBe('invalid_to');
  expect(codeOf(() => list({ at: '2025-01-01T10:00', from: '2025-01-01T09:00' }))).toBe('invalid_time_range');
  expect(codeOf(() => list({ search: 'x'.repeat(101) }))).toBe('invalid_search');
  // No configuration at all: a bare timestamp is rejected instead of being
  // read in the host timezone, while an explicit offset still resolves.
  expect(codeOf(() => listInvocations(current().store.orm, { at: '2025-01-01T00:00' }))).toBe('invalid_at');
  const withoutConfig = listInvocations(current().store.orm, { at: '2025-01-01T08:00:10+08:00' });
  expect(withoutConfig.items.map((item) => (item as unknown as Item).id)).toEqual(['401']);
});
