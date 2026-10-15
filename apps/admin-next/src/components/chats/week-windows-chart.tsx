import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParticipationWindow } from '@/lib/api';
import { daySegments, formatZonedTime, summarizeWindows, zonedClock } from '@/lib/participation';
import { cn } from '@/lib/utils';

const HOUR_TICKS = [0, 6, 12, 18, 24];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Weekly bar chart of participation windows: one track per weekday, bars for
 * the scheduled periods and a marker line for the current wall-clock time in
 * the chat's timezone. Purely visual; the window list carries the data.
 */
export function WeekWindowsChart({
  windows,
  timezone,
}: {
  readonly windows: readonly ParticipationWindow[];
  readonly timezone: string;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const dayLabels = t('pages.chats.weekdaysShort').split(',');
  const now = useMemo(() => new Date(), []);
  const nowClock = useMemo(() => zonedClock(timezone, now), [timezone, now]);
  const nowPct = `${((nowClock.minutes / 1440) * 100).toFixed(3)}%`;
  return (
    <div className="space-y-1.5">
      <div className="flex" aria-hidden="true">
        <div className="w-10 shrink-0" />
        <div className="relative h-4 flex-1">
          {HOUR_TICKS.map((hour) => (
            <span
              key={hour}
              className="text-muted-foreground absolute text-xs tabular-nums"
              style={{
                left: `${(hour / 24) * 100}%`,
                transform: hour === 0 ? 'none' : hour === 24 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {hour}
            </span>
          ))}
          <span
            className="absolute top-4 size-2 -translate-x-1/2 rotate-45 border border-background bg-foreground"
            style={{ left: nowPct }}
          />
        </div>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-0 flex" aria-hidden="true">
          <div className="w-10 shrink-0" />
          <div className="relative flex-1">
            {HOUR_TICKS.map((hour) => (
              <div
                key={hour}
                className="bg-border/40 absolute inset-y-0 w-px"
                style={{ left: `${(hour / 24) * 100}%` }}
              />
            ))}
          </div>
        </div>
        {WEEKDAYS.map((day) => {
          const isToday = day === nowClock.weekday;
          return (
            <div key={day} className="relative flex items-center">
              <div
                className={cn('w-10 shrink-0 text-xs', isToday ? 'text-primary font-medium' : 'text-muted-foreground')}
              >
                {dayLabels[day - 1]}
              </div>
              <div className="relative h-5 flex-1">
                <div className="bg-muted/50 absolute inset-y-1.5 inset-x-0 rounded-full" aria-hidden="true" />
                {isToday ? (
                  <div
                    className="bg-foreground/60 absolute inset-y-0 w-px"
                    style={{ left: nowPct }}
                    aria-hidden="true"
                  />
                ) : null}
                {daySegments(windows, day).map((segment) => (
                  <div
                    key={`${segment.start}-${segment.end}`}
                    className="bg-primary/60 absolute inset-y-1.5 rounded-full"
                    style={{
                      left: `${((segment.start / 1440) * 100).toFixed(3)}%`,
                      width: `${(((segment.end - segment.start) / 1440) * 100).toFixed(3)}%`,
                    }}
                    title={summarizeWindows([segment.window], {
                      dayLabels,
                      dailyLabel: t('pages.chats.daily'),
                    })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {t('pages.chats.activeHoursTimezoneNote', {
          timezone,
          time: formatZonedTime(timezone, now, i18n.language),
        })}
      </p>
    </div>
  );
}
