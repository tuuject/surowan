import type { ReactElement } from 'react';
import { formatTime, formatTimeInZone } from '@/lib/format';
import { TechText } from './bidi-text';

/**
 * A formatted time as one isolated LTR run.
 *
 * `2026-11-14 02:07:05` is a sequence of numeric runs and neutrals: inside an
 * RTL paragraph the bidi algorithm keeps each number in order but swaps the date
 * and the time around the space between them. Isolating the formatted string
 * (markup, not control characters) keeps it in reading order, while the cell
 * still takes its alignment from the table.
 *
 * `timeZone` renders the timestamp as that zone's wall clock, with the weekday,
 * for schedules (`Thu 2026-11-19 08:00`).
 */
export function TimeText({
  value,
  timeZone,
  className,
}: {
  readonly value: string | null;
  readonly timeZone?: string;
  readonly className?: string;
}): ReactElement {
  const text = timeZone === undefined ? formatTime(value) : formatTimeInZone(value, timeZone);
  return className === undefined ? <TechText>{text}</TechText> : <TechText className={className}>{text}</TechText>;
}
