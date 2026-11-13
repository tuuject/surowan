import { useQuery } from '@tanstack/react-query';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { TFunction } from 'i18next';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, KvList, MonoValue, TableShell, ToneBadge } from '@/components/business';
import { AppLink } from '@/components/router-links';
import { getRecurringAlarm, type RecurringFiring } from '@/lib/api/recurring-alarms.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime, formatTimeInZone } from '@/lib/format';

const SKIP_REASONS = [
  'missed',
  'previous_pending',
  'chat_removed',
  'chat_paused',
  'topic_removed',
  'agent_unconfigured',
] as const;

/** One firing as an admin reads it: delivered, still on its way, cancelled or skipped and why. */
export function firingResult(t: TFunction, firing: RecurringFiring): string {
  if (firing.outcome === 'skipped') {
    const reason = SKIP_REASONS.find((known) => known === firing.skip_reason);
    return `${t('pages.recurringAlarms.resultSkipped')} · ${
      reason === undefined ? (firing.skip_reason ?? '') : t(`pages.recurringAlarms.skipReason.${reason}`)
    }`;
  }
  switch (firing.receipt_state) {
    case 'claimed':
      return t('pages.recurringAlarms.resultRunning');
    case 'handled':
      return t('pages.recurringAlarms.resultDelivered');
    case 'suppressed':
      return t('pages.recurringAlarms.resultSuppressed');
    default:
      return t('pages.recurringAlarms.resultQueued');
  }
}

export function FiringSummary({ firing }: { readonly firing: RecurringFiring | null }): ReactElement {
  const { t } = useTranslation();
  if (firing === null) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <div className={css({ minWidth: '0' })}>
      <div className={css({ display: 'flex', gap: '2', alignItems: 'center' })}>
        <ToneBadge tone={firing.outcome === 'skipped' ? 'warning' : 'neutral'}>{firingResult(t, firing)}</ToneBadge>
      </div>
      <div className={css({ textStyle: 'small', color: 'text-muted' })}>
        {formatTime(firing.occurrence_at)}
        {firing.source === 'manual' ? ` · ${t('pages.recurringAlarms.sourceManual')}` : ''}
      </div>
    </div>
  );
}

function InvocationLink({ id }: { readonly id: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <AppLink to="/invocations/$invocationId" params={{ invocationId: id }}>
      {t('pages.recurringAlarms.invocationLink', { id })}
    </AppLink>
  );
}

/** The definition and its 50 most recent firings, each linked to the Invocation that delivered it. */
export function RecurringAlarmDetails({ id }: { readonly id: string }): ReactElement {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey: ['recurring-alarms', 'detail', id], queryFn: () => getRecurringAlarm(id) });
  if (detail.isError) {
    return (
      <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
        {errorMessage(detail.error)}
      </p>
    );
  }
  const alarm = detail.data;
  const columns: readonly ColumnSpec<RecurringFiring>[] = [
    {
      key: 'occurrence_at',
      title: t('pages.recurringAlarms.colWhen'),
      width: 200,
      render: (row) => formatTimeInZone(row.occurrence_at, alarm?.time_zone ?? 'UTC'),
    },
    {
      key: 'source',
      title: t('pages.recurringAlarms.colSource'),
      width: 96,
      render: (row) =>
        row.source === 'manual' ? t('pages.recurringAlarms.sourceManual') : t('pages.recurringAlarms.sourceSchedule'),
    },
    {
      key: 'result',
      title: t('pages.recurringAlarms.colResult'),
      render: (row) => (
        <div>
          <div>{firingResult(t, row)}</div>
          {row.coalesced > 0 ? (
            <div className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('pages.recurringAlarms.coalesced', { count: row.coalesced })}
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'by', title: t('pages.recurringAlarms.colBy'), width: 120, render: (row) => row.triggered_by ?? '—' },
    {
      key: 'invocation',
      title: t('pages.recurringAlarms.colInvocation'),
      width: 168,
      render: (row) => (row.invocation_id === null ? '—' : <InvocationLink id={row.invocation_id} />),
    },
  ];
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
      <KvList
        items={[
          { label: t('pages.recurringAlarms.labelId'), value: <MonoValue value={id} /> },
          { label: t('pages.recurringAlarms.labelRevision'), value: <MonoValue value={alarm?.revision ?? null} /> },
          {
            label: t('pages.recurringAlarms.labelRules'),
            value: (
              <span className={css({ fontFamily: 'mono', whiteSpace: 'pre-wrap' })}>
                {alarm?.rules.join('\n') ?? '—'}
              </span>
            ),
          },
          { label: t('pages.recurringAlarms.labelTimeZone'), value: alarm?.time_zone ?? '—' },
          {
            label: t('pages.recurringAlarms.fieldPrompt'),
            value: <span className={css({ whiteSpace: 'pre-wrap', textWrap: 'wrap' })}>{alarm?.prompt ?? '—'}</span>,
          },
          {
            label: t('pages.recurringAlarms.labelCreated'),
            value: alarm === undefined ? '—' : `${formatTime(alarm.created_at)} · ${alarm.created_by}`,
          },
          {
            label: t('pages.recurringAlarms.labelUpdated'),
            value: alarm === undefined ? '—' : `${formatTime(alarm.updated_at)} · ${alarm.updated_by}`,
          },
        ]}
      />
      <div>
        <div className={css({ textStyle: 'label', marginBlockEnd: '2' })}>
          {t('pages.recurringAlarms.firingsTitle')}
        </div>
        <TableShell
          columns={columns}
          data={alarm?.firings ?? []}
          rowKey={(row) => row.id}
          loading={detail.isPending}
          minWidth={720}
          emptyText={t('pages.recurringAlarms.firingsEmpty')}
        />
      </div>
    </div>
  );
}
