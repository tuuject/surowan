import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CronerScheduleEngine } from '../../src/adapters/local-monolith/recurring-schedule.ts';
import {
  canonicalTimeZone,
  checkRuleDialect,
  checkSchedule,
  countOccurrences,
  upcomingOccurrences,
} from '../../src/platform/recurring-schedule.ts';

const engine = new CronerScheduleEngine();
const now = new Date();

function iso(dates: readonly Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

describe('recurring schedule dialect (F1)', () => {
  test.each([['0 8 * * *'], ['*/15 9-18 * * MON-FRI'], ['0,30 8 1,15 jan-mar 0'], ['5-55/10 * * * *'], ['0 0 29 2 *']])(
    'accepts portable rule %s',
    (rule) => {
      expect(checkRuleDialect(rule)).toBeUndefined();
    },
  );

  test.each([
    ['0 0 8 * * *', 'syntax'],
    ['0 8 * *', 'syntax'],
    ['0 8 * * * 2027', 'syntax'],
    ['0 8 L * *', 'unsupported'],
    ['0 8 15W * *', 'unsupported'],
    ['0 8 * * 5#3', 'unsupported'],
    ['0 8 ? * *', 'unsupported'],
    ['0 8 * * 7', 'out_of_range'],
    ['60 8 * * *', 'out_of_range'],
    ['0 24 * * *', 'out_of_range'],
    ['0 8 0 * *', 'out_of_range'],
    ['0 8 * 13 *', 'out_of_range'],
    ['0 8 * * FOO', 'unsupported'],
    ['0 8 * JAN *x', 'unsupported'],
    ['5/10 * * * *', 'unsupported'],
    ['*/0 * * * *', 'out_of_range'],
    ['30-10 * * * *', 'out_of_range'],
    ['@daily', 'syntax'],
    ['   ', 'empty'],
  ])('rejects %s as %s', (rule, code) => {
    expect(checkRuleDialect(rule)?.code).toBe(code);
  });

  test('a rule list is validated as a whole and normalized', () => {
    expect(checkSchedule(engine, ['  0   8 * *  *  '], 'Asia/Shanghai', now)).toEqual({
      ok: true,
      rules: ['0 8 * * *'],
      timeZone: 'Asia/Shanghai',
    });
    expect(checkSchedule(engine, [], 'UTC', now)).toMatchObject({ ok: false, code: 'invalid_rules' });
    expect(
      checkSchedule(
        engine,
        Array.from({ length: 11 }, () => '0 8 * * *'),
        'UTC',
        now,
      ),
    ).toMatchObject({
      ok: false,
      code: 'invalid_rules',
      issues: [{ index: -1, code: 'too_many' }],
    });
    const mixed = checkSchedule(engine, ['0 8 * * *', '0 8 L * *', '0 0 31 2 *'], 'UTC', now);
    expect(mixed).toMatchObject({ ok: false, code: 'invalid_rules', issues: [{ index: 1, code: 'unsupported' }] });
    // The engine is only consulted once every rule is in the dialect.
    expect(checkSchedule(engine, ['0 8 * * *', '0 0 31 2 *'], 'UTC', now)).toMatchObject({
      ok: false,
      issues: [{ index: 1, code: 'never_fires' }],
    });
    expect(checkSchedule(engine, ['0 8 * * *'], 'Mars/Base', now)).toEqual({ ok: false, code: 'invalid_time_zone' });
  });

  test('time zones are canonical IANA names', () => {
    expect(canonicalTimeZone('asia/shanghai')).toBe('Asia/Shanghai');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('Mars/Base')).toBeUndefined();
    expect(canonicalTimeZone('')).toBeUndefined();
  });
});

describe('recurring schedule occurrences (F2)', () => {
  test('8 a.m. is local to the schedule time zone, not UTC', () => {
    const after = new Date('2026-11-13T00:30:00.000Z');
    expect(iso(upcomingOccurrences(engine, ['0 8 * * *'], 'Asia/Shanghai', after, 2))).toEqual([
      '2026-11-14T00:00:00.000Z',
      '2026-11-15T00:00:00.000Z',
    ]);
    expect(iso(upcomingOccurrences(engine, ['0 8 * * *'], 'UTC', after, 1))).toEqual(['2026-11-13T08:00:00.000Z']);
  });

  test('daylight saving transitions neither repeat nor skip a day', () => {
    // 02:30 does not exist on the spring-forward day; it fires once, an hour later.
    expect(
      iso(upcomingOccurrences(engine, ['30 2 * * *'], 'America/New_York', new Date('2026-03-07T12:00:00Z'), 3)),
    ).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
    // 01:30 happens twice on the fall-back day; it fires once.
    expect(
      iso(upcomingOccurrences(engine, ['30 1 * * *'], 'America/New_York', new Date('2026-10-31T12:00:00Z'), 3)),
    ).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
  });

  test('occurrences are strictly after the cursor, minute aligned, and the union of all rules', () => {
    expect(engine.nextAfter(['0 8 * * *'], 'UTC', new Date('2026-11-13T08:00:00.000Z'))?.toISOString()).toBe(
      '2026-11-14T08:00:00.000Z',
    );
    expect(engine.nextAfter(['*/15 * * * *'], 'UTC', new Date('2026-11-13T08:07:31.500Z'))?.toISOString()).toBe(
      '2026-11-13T08:15:00.000Z',
    );
    expect(
      iso(upcomingOccurrences(engine, ['0 18 * * *', '0 8 * * *'], 'UTC', new Date('2026-11-13T00:00:00Z'), 3)),
    ).toEqual(['2026-11-13T08:00:00.000Z', '2026-11-13T18:00:00.000Z', '2026-11-14T08:00:00.000Z']);
  });

  test('a restricted day of month and day of week are ORed', () => {
    expect(iso(upcomingOccurrences(engine, ['0 9 1 * MON'], 'UTC', new Date('2026-11-01T00:00:00Z'), 3))).toEqual([
      '2026-11-01T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
    ]);
  });

  test('a rule without future occurrences yields null, and missed occurrences are counted', () => {
    expect(engine.nextAfter(['0 0 31 2 *'], 'UTC', new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(
      countOccurrences(
        engine,
        ['*/10 * * * *'],
        'UTC',
        new Date('2026-11-13T08:00:00Z'),
        new Date('2026-11-13T09:00:00Z'),
      ),
    ).toBe(6);
    expect(
      countOccurrences(
        engine,
        ['* * * * *'],
        'UTC',
        new Date('2026-11-01T00:00:00Z'),
        new Date('2026-11-13T00:00:00Z'),
      ),
    ).toBe(1000);
  });
});

describe('recurring schedule layering (F12)', () => {
  test('croner is imported only by the local-monolith schedule engine', async () => {
    const root = join(import.meta.dirname, '../../src');
    const importers: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.name.endsWith('.ts')) {
          const text = await readFile(path, 'utf8');
          if (/from\s+['"]croner['"]|import\(\s*['"]croner['"]\s*\)/.test(text)) {
            importers.push(relative(root, path));
          }
        }
      }
    };
    await walk(root);
    expect(importers).toEqual(['adapters/local-monolith/recurring-schedule.ts']);
  });
});
