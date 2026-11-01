import { expect, test } from 'vitest';
import { chatLocalDay, localDayWindow, nextDay, parseDay } from '../../src/context/group-memory/day.ts';

test('chatLocalDay resolves the Chat timezone, not the host or UTC', () => {
  expect(chatLocalDay('2026-10-01T00:30:00.000Z', 'Asia/Shanghai')).toBe('2026-10-01');
  expect(chatLocalDay('2026-10-01T23:30:00.000Z', 'Asia/Shanghai')).toBe('2026-10-02');
  expect(chatLocalDay('2026-10-01T23:30:00.000Z', 'UTC')).toBe('2026-10-01');
});

test('localDayWindow is half-open and handles a DST spring-forward day', () => {
  const window = localDayWindow('2026-03-08', 'America/New_York');
  expect(window.start).toBe('2026-03-08T05:00:00.000Z');
  expect(window.end).toBe('2026-03-09T04:00:00.000Z');
  expect(Date.parse(window.end) - Date.parse(window.start)).toBe(23 * 3_600_000);
});

test('localDayWindow handles a DST fall-back day', () => {
  const window = localDayWindow('2026-11-01', 'America/New_York');
  expect(window.start).toBe('2026-11-01T04:00:00.000Z');
  expect(window.end).toBe('2026-11-02T05:00:00.000Z');
  expect(Date.parse(window.end) - Date.parse(window.start)).toBe(25 * 3_600_000);
});

test('day parsing rejects impossible dates and nextDay crosses month ends', () => {
  expect(nextDay('2026-02-28')).toBe('2026-03-01');
  expect(nextDay('2026-12-31')).toBe('2027-01-01');
  expect(() => parseDay('2026-02-30')).toThrow('Invalid day');
  expect(() => parseDay('2026-2-1')).toThrow('Invalid day');
});
