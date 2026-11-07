import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParticipationWindow } from '@/lib/api/chats.ts';
import { daySegments, formatZonedTime, summarizeWindows, zonedClock } from '@/lib/participation';

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
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      <div className={css({ display: 'flex' })} aria-hidden="true">
        <div className={css({ width: '40px', flexShrink: '0' })} />
        <div className={css({ position: 'relative', height: 'icon', flex: '1 1 0%' })}>
          {HOUR_TICKS.map((hour) => (
            <span
              key={hour}
              className={css({
                textStyle: 'small',
                color: 'text-muted',
                position: 'absolute',
                fontVariantNumeric: 'tabular-nums',
              })}
              style={{
                left: `${(hour / 24) * 100}%`,
                transform: hour === 0 ? 'none' : hour === 24 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {hour}
            </span>
          ))}
          <span
            className={css({
              position: 'absolute',
              top: '4',
              width: '8px',
              height: '8px',
              transform: 'rotate(45deg)',
              borderWidth: '1px',
              borderColor: 'surface',
              bg: 'text-muted',
            })}
            style={{ left: nowPct }}
          />
        </div>
      </div>
      <div className={css({ position: 'relative' })}>
        <div
          className={css({ pointerEvents: 'none', position: 'absolute', inset: '0', display: 'flex' })}
          aria-hidden="true"
        >
          <div className={css({ width: '40px', flexShrink: '0' })} />
          <div className={css({ position: 'relative', flex: '1 1 0%' })}>
            {HOUR_TICKS.map((hour) => (
              <div
                key={hour}
                className={css({ bg: 'divider', position: 'absolute', insetBlock: '0', width: '1px' })}
                style={{ left: `${(hour / 24) * 100}%` }}
              />
            ))}
          </div>
        </div>
        {WEEKDAYS.map((day) => {
          const isToday = day === nowClock.weekday;
          return (
            <div key={day} className={css({ position: 'relative', display: 'flex', alignItems: 'center' })}>
              <div
                className={cx(
                  css({ textStyle: 'small', width: '40px', flexShrink: '0' }),
                  isToday ? css({ textStyle: 'label', color: 'text-brand' }) : css({ color: 'text-muted' }),
                )}
              >
                {dayLabels[day - 1]}
              </div>
              <div className={css({ position: 'relative', height: '20px', flex: '1 1 0%' })}>
                <div
                  className={css({
                    bg: 'surface-muted',
                    position: 'absolute',
                    insetBlock: '2',
                    insetInline: '0',
                    borderRadius: 'full',
                  })}
                  aria-hidden="true"
                />
                {isToday ? (
                  <div
                    className={css({ bg: 'text-muted', position: 'absolute', insetBlock: '0', width: '1px' })}
                    style={{ left: nowPct }}
                    aria-hidden="true"
                  />
                ) : null}
                {daySegments(windows, day).map((segment) => (
                  <div
                    key={`${segment.start}-${segment.end}`}
                    className={css({ bg: 'action', position: 'absolute', insetBlock: '2', borderRadius: 'full' })}
                    style={{
                      left: `${((segment.start / 1440) * 100).toFixed(3)}%`,
                      width: `${(((segment.end - segment.start) / 1440) * 100).toFixed(3)}%`,
                    }}
                    title={summarizeWindows([segment.window], {
                      dayLabels,
                      dailyLabel: t('pages.chats.daily'),
                      separator: t('common.separator'),
                    })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        {t('pages.chats.activeHoursTimezoneNote', {
          timezone,
          time: formatZonedTime(timezone, now, i18n.language),
        })}
      </p>
    </div>
  );
}
