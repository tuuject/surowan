import { expect, test } from 'vitest';
import {
  chatLocalDay,
  localDayWindow,
  nextDay,
  parseDay,
  searchDayWindow,
} from '../../src/context/group-memory/day.ts';

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

// Ways a search window can fail: finding 06:00 by adding six hours to midnight,
// which lands at 07:00 or 05:00 on a DST day; resolving 06:00 in UTC instead of
// the Chat timezone; starting an overlapping day at 06:00 instead of midnight;
// and changing the calendar window when the 30-hour day is off.
test('searchDayWindow ends a 30-hour day at Chat-local 06:00 of the next date, across DST', () => {
  expect(searchDayWindow('2026-03-08', 'off', 'America/New_York')).toEqual(
    localDayWindow('2026-03-08', 'America/New_York'),
  );
  // Spring forward at 02:00: midnight is EST (-5), 06:00 is already EDT (-4).
  expect(searchDayWindow('2026-03-08', 'non_overlapping', 'America/New_York')).toEqual({
    start: '2026-03-08T10:00:00.000Z',
    end: '2026-03-09T10:00:00.000Z',
  });
  expect(searchDayWindow('2026-03-08', 'overlapping', 'America/New_York')).toEqual({
    start: '2026-03-08T05:00:00.000Z',
    end: '2026-03-09T10:00:00.000Z',
  });
  // The day that contains the jump is 23 hours long, 06:00 to 06:00.
  expect(searchDayWindow('2026-03-07', 'non_overlapping', 'America/New_York')).toEqual({
    start: '2026-03-07T11:00:00.000Z',
    end: '2026-03-08T10:00:00.000Z',
  });
  // Fall back at 02:00: 06:00 on 2026-11-01 is EST again, 25 hours after 06:00 EDT.
  expect(searchDayWindow('2026-10-31', 'non_overlapping', 'America/New_York')).toEqual({
    start: '2026-10-31T10:00:00.000Z',
    end: '2026-11-01T11:00:00.000Z',
  });
  expect(searchDayWindow('2026-11-18', 'non_overlapping', 'Asia/Tokyo')).toEqual({
    start: '2026-11-17T21:00:00.000Z',
    end: '2026-11-18T21:00:00.000Z',
  });
});

test('day parsing rejects impossible dates and nextDay crosses month ends', () => {
  expect(nextDay('2026-02-28')).toBe('2026-03-01');
  expect(nextDay('2026-12-31')).toBe('2027-01-01');
  expect(() => parseDay('2026-02-30')).toThrow('Invalid day');
  expect(() => parseDay('2026-2-1')).toThrow('Invalid day');
});
