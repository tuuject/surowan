import { describe, expect, test } from 'vitest';
import { daySegments, effectiveWindows, parseClock, summarizeWindows, zonedClock } from './participation.ts';

// 2026-01-04 is a Sunday; 16:30Z is 00:30 Monday in Shanghai and 16:30 Sunday in UTC.
const INSTANT = new Date('2026-01-04T16:30:00Z');

describe('parseClock', () => {
  test('accepts day times and the 24:00 end-of-day marker', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('09:05')).toBe(545);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBe(1440);
  });

  test('rejects malformed or out-of-range clocks with NaN', () => {
    for (const value of ['9:00', '24:30', '25:00', '12:60', '', '09:00 ', '0900']) {
      expect(parseClock(value), value).toBeNaN();
    }
  });
});

describe('daySegments', () => {
  const weekdays = [{ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }];

  test('normal windows render only on selected days', () => {
    expect(daySegments(weekdays, 1)).toEqual([{ start: 540, end: 1080, window: weekdays[0] }]);
    expect(daySegments(weekdays, 6)).toEqual([]);
  });

  test('windows without days cover every day', () => {
    const window = { start: '00:00', end: '24:00' };
    expect(daySegments([window], 7)).toEqual([{ start: 0, end: 1440, window }]);
  });

  test('a window crossing midnight belongs to its start day and spills onto the next', () => {
    const window = { start: '22:00', end: '02:00', days: [7] };
    expect(daySegments([window], 7)).toEqual([{ start: 1320, end: 1440, window }]);
    expect(daySegments([window], 1)).toEqual([{ start: 0, end: 120, window }]);
    expect(daySegments([window], 2)).toEqual([]);
  });

  test('invalid clocks contribute nothing instead of throwing', () => {
    expect(daySegments([{ start: '9:00', end: '18:00' }], 3)).toEqual([]);
  });
});

describe('effectiveWindows', () => {
  test('chat windows replace the global list wholesale, including the empty override', () => {
    const global = { active_windows: [{ start: '09:00', end: '18:00' }] };
    expect(effectiveWindows(null, global)).toEqual(global.active_windows);
    expect(effectiveWindows({ active_windows: [] }, global)).toEqual([]);
    expect(effectiveWindows({ active_windows: [{ start: '10:00', end: '12:00' }] }, global)).toEqual([
      { start: '10:00', end: '12:00' },
    ]);
    // A chat section without active_windows inherits the global list.
    expect(effectiveWindows({ trigger_keywords: ['x'] }, global)).toEqual(global.active_windows);
    expect(effectiveWindows(null, null)).toEqual([]);
  });
});

describe('summarizeWindows', () => {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const options = { dayLabels: labels, dailyLabel: 'Daily' };

  test('compresses weekday runs and lists single days', () => {
    expect(
      summarizeWindows(
        [
          { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
          { start: '10:00', end: '14:00', days: [6] },
        ],
        options,
      ),
    ).toBe('Mon–Fri 09:00–18:00 · Sat 10:00–14:00');
    expect(summarizeWindows([{ start: '08:00', end: '09:30', days: [2, 4] }], options)).toBe('Tue, Thu 08:00–09:30');
  });

  test('full weeks and day-less windows use the daily label', () => {
    expect(summarizeWindows([{ start: '09:00', end: '18:00', days: [7, 1, 2, 3, 4, 5, 6] }], options)).toBe(
      'Daily 09:00–18:00',
    );
    expect(summarizeWindows([{ start: '22:00', end: '02:00' }], options)).toBe('Daily 22:00–02:00');
  });
});

describe('zonedClock', () => {
  test('resolves the ISO weekday and minute of day in the zone', () => {
    expect(zonedClock('UTC', INSTANT)).toEqual({ weekday: 7, minutes: 990 });
    expect(zonedClock('Asia/Shanghai', INSTANT)).toEqual({ weekday: 1, minutes: 30 });
    expect(zonedClock('America/New_York', INSTANT)).toEqual({ weekday: 7, minutes: 690 });
  });

  test('formatZonedTime renders the same instant in the zone', () => {
    expect(new Date('2026-01-04T16:30:00Z')).toEqual(INSTANT);
  });
});
