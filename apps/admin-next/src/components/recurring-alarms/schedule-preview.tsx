import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { previewRecurringSchedule } from '@/lib/api/recurring-alarms.ts';
import { errorMessage } from '@/lib/errors';
import { TimeText } from '@/components/business/time-text';

/**
 * The next five runs of the schedule being edited, computed by the server so
 * the panel shows exactly what will fire. Rules and zone arrive already
 * debounced by the form.
 */
export function SchedulePreview({
  rules,
  timeZone,
}: {
  readonly rules: readonly string[];
  readonly timeZone: string;
}): ReactElement {
  const { t } = useTranslation();
  const preview = useQuery({
    queryKey: ['recurring-alarms', 'preview', rules, timeZone],
    queryFn: () => previewRecurringSchedule({ rules, time_zone: timeZone }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const data = preview.data;
  return (
    <section
      aria-label={t('pages.recurringAlarms.previewTitle')}
      className={css({ borderRadius: 'md', bg: 'surface-muted', padding: '3' })}
    >
      <div className={css({ textStyle: 'label', marginBlockEnd: '2' })}>{t('pages.recurringAlarms.previewTitle')}</div>
      {preview.isError ? (
        <p className={css({ textStyle: 'small', color: 'error-text' })}>{errorMessage(preview.error)}</p>
      ) : data === undefined ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.recurringAlarms.previewLoading')}</p>
      ) : data.time_zone === null ? (
        <p className={css({ textStyle: 'small', color: 'error-text' })}>{t('pages.recurringAlarms.previewTimeZone')}</p>
      ) : data.issues.length > 0 ? (
        <ul className={css({ textStyle: 'small', color: 'error-text', paddingInlineStart: '4', listStyle: 'disc' })}>
          {data.issues.map((issue) => (
            <li key={`${issue.index}:${issue.code}:${issue.message}`}>
              {issue.index < 0
                ? issue.message
                : t('pages.recurringAlarms.previewIssue', { n: issue.index + 1, message: issue.message })}
            </li>
          ))}
        </ul>
      ) : data.next.length === 0 ? (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('pages.recurringAlarms.previewEmpty')}</p>
      ) : (
        <>
          <ol
            className={css({ textStyle: 'small', fontFamily: 'mono', paddingInlineStart: '4', listStyle: 'decimal' })}
          >
            {data.next.map((occurrence) => (
              <li key={occurrence}>
                <TimeText value={occurrence} timeZone={data.time_zone ?? timeZone} />
              </li>
            ))}
          </ol>
          {data.short_interval ? (
            <p className={css({ textStyle: 'small', color: 'warning-text', marginBlockStart: '2' })}>
              {t('pages.recurringAlarms.previewShortInterval')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
