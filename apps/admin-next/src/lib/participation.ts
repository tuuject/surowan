import type { ParticipationView, ParticipationWindow } from '@/lib/api';

/**
 * Pure helpers around participation schedules. Weekdays are ISO numbers
 * (1 = Monday … 7 = Sunday), matching the config file, and clock times are
 * minute offsets with `24:00` meaning the end of the day (1440).
 */

export interface DaySegment {
  readonly start: number;
  readonly end: number;
  /** The window this segment renders, for labels and tooltips. */
  readonly window: ParticipationWindow;
}

const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/;

/** `HH:MM` to minutes; `24:00` is 1440. Invalid input is `NaN`, never an error. */
export function parseClock(value: string): number {
  const match = CLOCK_PATTERN.exec(value);
  if (match === null) {
    return Number.NaN;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
    return Number.NaN;
  }
  return hours * 60 + minutes;
}

function coversDay(days: readonly number[] | undefined, day: number): boolean {
  return days === undefined || days.includes(day);
}

/**
 * Segments of weekday `day` covered by the windows. A window crossing midnight
 * belongs to its start day, exactly like the runtime match: the part until
 * midnight renders on the start day, the part after midnight on the following
 * one, and both follow the start day's weekday selection.
 */
export function daySegments(windows: readonly ParticipationWindow[], day: number): readonly DaySegment[] {
  const segments: DaySegment[] = [];
  for (const window of windows) {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      continue;
    }
    if (end > start) {
      if (coversDay(window.days, day)) {
        segments.push({ start, end, window });
      }
    } else if (end < start) {
      if (coversDay(window.days, day)) {
        segments.push({ start, end: 1440, window });
      }
      const previous = day === 1 ? 7 : day - 1;
      if (coversDay(window.days, previous)) {
        segments.push({ start: 0, end, window });
      }
    }
  }
  return segments;
}

/**
 * The windows that actually gate a chat: chat-level `active_windows` replace
 * the global list wholesale; without them the global list applies.
 */
export function effectiveWindows(
  chat: ParticipationView | null,
  global: ParticipationView | null,
): readonly ParticipationWindow[] {
  return chat?.active_windows ?? global?.active_windows ?? [];
}

function dayListText(days: readonly number[], dayLabels: readonly string[], dailyLabel: string): string {
  const unique = [...new Set(days)].sort((left, right) => left - right);
  const first = unique[0];
  if (unique.length === 7 || first === undefined) {
    return dailyLabel;
  }
  const runs: string[] = [];
  let runStart = first;
  let previous = first;
  for (const day of unique.slice(1)) {
    if (day !== previous + 1) {
      runs.push(runText(runStart, previous, dayLabels));
      runStart = day;
    }
    previous = day;
  }
  runs.push(runText(runStart, previous, dayLabels));
  return runs.join(', ');
}

function runText(start: number | undefined, end: number | undefined, dayLabels: readonly string[]): string {
  const first = start === undefined ? '' : (dayLabels[start - 1] ?? '');
  const last = end === undefined ? '' : (dayLabels[end - 1] ?? '');
  return first === last ? first : `${first}–${last}`;
}

/** `Mon–Fri 09:00–18:00 · Sat 10:00–14:00`; every-day windows only show their time span with the daily label. */
export function summarizeWindows(
  windows: readonly ParticipationWindow[],
  options: { readonly dayLabels: readonly string[]; readonly dailyLabel: string },
): string {
  return windows
    .map((window) => {
      const time = `${window.start}–${window.end}`;
      const days =
        window.days === undefined || window.days.length === 0
          ? options.dailyLabel
          : dayListText(window.days, options.dayLabels, options.dailyLabel);
      return `${days} ${time}`;
    })
    .join(' · ');
}

const WEEKDAY_BY_SHORT_NAME: Readonly<Record<string, number>> = {
  Sun: 7,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock weekday (ISO 1–7) and minute-of-day for `now` in `timezone`. */
export function zonedClock(timezone: string, now: Date): { readonly weekday: number; readonly minutes: number } {
  const parts = zonedParts(timezone, now);
  return {
    weekday: WEEKDAY_BY_SHORT_NAME[parts.weekday ?? ''] ?? 7,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Human-readable current time in `timezone`, localized to `locale`. */
export function formatZonedTime(timezone: string, now: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
}

function zonedParts(timezone: string, now: Date): Readonly<Record<string, string>> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    parts[part.type] = part.value;
  }
  return parts;
}
