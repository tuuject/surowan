import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { Fragment, type ReactElement, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ParticipationWindow } from '@/lib/api/chats.ts';
import { daySegments, formatZonedTime, summarizeWindows, zonedClock } from '@/lib/participation';
import { TechText } from '@/components/business/bidi-text';

const HOUR_TICKS = [0, 6, 12, 18, 24];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * The label column follows its content instead of a fixed 40px: Arabic has no
 * standard short weekday names (CLDR's "short" form is the full name), so a fixed
 * box would run `الأربعاء` into the track. One grid, so the axis row and every day
 * row share the same first-column width in every language.
 */
const GRID = css({ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: '2' });

/** Hour lines at every quarter of the track, painted under the bars. */
const TRACK = css({
  position: 'relative',
  backgroundImage: 'linear-gradient(to right, var(--colors-divider) 0 1px, transparent 1px)',
  backgroundSize: '25% 100%',
});

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
}): ReactElement {
  const { t, i18n } = useTranslation();
  const dayLabels = t('pages.chats.weekdaysShort').split(',');
  const now = useMemo(() => new Date(), []);
  const nowClock = useMemo(() => zonedClock(timezone, now), [timezone, now]);
  const nowPct = `${((nowClock.minutes / 1440) * 100).toFixed(3)}%`;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
      <div className={GRID}>
        {/* Axis row: an empty label cell keeps the tick row aligned with the day labels. */}
        <span aria-hidden="true" />
        {/* A clock axis reads left-to-right in every language: only the tracks are an LTR island. */}
        <div dir="ltr" className={css({ position: 'relative', height: 'icon' })}>
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
            aria-hidden="true"
          />
        </div>
        {WEEKDAYS.map((day) => {
          const isToday = day === nowClock.weekday;
          return (
            <Fragment key={day}>
              <div
                className={css({
                  textStyle: isToday ? 'label' : 'small',
                  color: isToday ? 'text-brand' : 'text-muted',
                  whiteSpace: 'nowrap',
                })}
              >
                {dayLabels[day - 1]}
              </div>
              <div dir="ltr" className={cx(TRACK, css({ height: '20px' }))}>
                <div
                  className={css({
                    bg: 'surface-muted',
                    position: 'absolute',
                    insetBlock: '2',
                    insetInline: '0',
                    borderRadius: 'full',
                    zIndex: 0,
                  })}
                  aria-hidden="true"
                />
                {isToday ? (
                  <div
                    className={css({
                      bg: 'text-muted',
                      position: 'absolute',
                      insetBlock: '0',
                      width: '1px',
                      zIndex: 1,
                    })}
                    style={{ left: nowPct }}
                    aria-hidden="true"
                  />
                ) : null}
                {daySegments(windows, day).map((segment) => (
                  <div
                    key={`${segment.start}-${segment.end}`}
                    className={css({
                      bg: 'action',
                      position: 'absolute',
                      insetBlock: '2',
                      borderRadius: 'full',
                      zIndex: 1,
                    })}
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
            </Fragment>
          );
        })}
      </div>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        <Trans
          i18nKey="pages.chats.activeHoursTimezoneNote"
          values={{ timezone, time: formatZonedTime(timezone, now, i18n.language) }}
          components={{ time: <TechText /> }}
        />
      </p>
    </div>
  );
}
