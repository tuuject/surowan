import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Card } from '@tuuject/koi-react/card';
import { ArrowRightIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ConfirmDialog,
  ListPageHeader,
  MonoValue,
  StateBadge,
  TableShell,
  ToneBadge,
} from '@/components/business';
import { AppLink } from '@/components/router-links';
import { TelegramStatusBadge, TelegramStatusReason, telegramBotLabel } from '@/components/telegram/telegram-status.tsx';
import { WarningCard } from '@/components/warnings/warning-card';
import { useForegroundRefresh } from '@/hooks/use-foreground-refresh';
import type { InvocationListItem } from '@/lib/api/invocations.ts';
import { listInvocations } from '@/lib/api/invocations.ts';
import { cancelOngoingSessions, wakeBot } from '@/lib/api/usage.ts';
import type { EventWarning } from '@/lib/api/warnings.ts';
import { markWarningRead } from '@/lib/api/warnings.ts';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { overviewQuery, telegramQuery, warningsSummaryQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

function SleepBadge({ sleeping }: { readonly sleeping: boolean }): ReactElement {
  const { t } = useTranslation();
  return sleeping ? (
    <ToneBadge tone="warning">{t('pages.overview.sleeping')}</ToneBadge>
  ) : (
    <ToneBadge tone="success">{t('pages.overview.awake')}</ToneBadge>
  );
}

const statValue = css({
  textStyle: 'heading-1',
  fontWeight: 'bold',
  color: 'text',
  fontVariantNumeric: 'tabular-nums',
});

/** One dashboard figure, as on the template: label, the number, a one-line hint, each sibling the same shape. */
function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly hint: string;
  readonly loading: boolean;
}): ReactElement {
  return (
    <Card>
      <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{label}</p>
      <div className={css({ marginBlockStart: '1' })}>
        {loading ? (
          <Skeleton>
            <span className={statValue}>00,000</span>
          </Skeleton>
        ) : (
          <span className={statValue}>{value === undefined ? '—' : formatNumber(value)}</span>
        )}
      </div>
      <p className={css({ margin: '0', marginBlockStart: '1', textStyle: 'small', color: 'text-muted' })}>{hint}</p>
    </Card>
  );
}

/** The card footer link to a full list, with Koi's arrow (as the template's 查看全部). */
function ViewAllLink({ to, label }: { readonly to: '/invocations' | '/warnings'; readonly label: string }) {
  return (
    <AppLink to={to}>
      {label}
      <ArrowRightIcon
        size={sizes['icon-sm']}
        className={css({ display: 'inline-block', verticalAlign: 'middle', marginInlineStart: '1' })}
      />
    </AppLink>
  );
}

/** Stands in for the status fields: a skeleton while loading, a plain line once the load has failed. */
function BotStatusPlaceholder({ pending }: { readonly pending: boolean }): ReactElement {
  const { t } = useTranslation();
  return pending ? (
    <Skeleton className={css({ height: '96px' })} />
  ) : (
    <p className={css({ margin: '0', color: 'text-muted' })}>{t('pages.overview.loadFailed')}</p>
  );
}

export default function OverviewPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);

  const overview = useQuery(overviewQuery);
  const warnings = useQuery(warningsSummaryQuery);
  const telegram = useQuery(telegramQuery);
  const recent = useQuery({
    queryKey: ['invocations', 'recent', 5],
    queryFn: () => listInvocations({ limit: 5 }),
  });
  useForegroundRefresh(() => {
    void warnings.refetch();
    void recent.refetch();
  });

  const markWarningReadMutation = useMutation({
    mutationFn: (warning: EventWarning) => markWarningRead(warning.id),
    onSuccess: () => {
      toast.success(t('pages.warnings.markedRead'));
      void queryClient.invalidateQueries({ queryKey: ['warnings'] });
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });
  const cancel = useMutation({
    mutationFn: cancelOngoingSessions,
    onSuccess: (result) => {
      setCancelOpen(false);
      toast.success(
        t('pages.overview.canceledBuckets', {
          buckets: formatNumber(result.canceled_buckets),
          invocations: formatNumber(result.canceled_invocations),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['invocations'] });
    },
  });
  const wake = useMutation({
    mutationFn: wakeBot,
    onSuccess: (result) => {
      setWakeOpen(false);
      toast.success(result.was_sleeping ? t('pages.overview.botAwake') : t('pages.overview.botAlreadyAwake'));
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  const data = overview.data;
  const totalInvocations = data?.invocation_states.reduce((sum, entry) => sum + entry.count, 0);
  const ongoingInvocations = data?.invocation_states
    .filter((entry) => entry.label === 'running' || entry.label === 'queued')
    .reduce((sum, entry) => sum + entry.count, 0);

  const recentColumns: readonly ColumnSpec<InvocationListItem>[] = [
    {
      key: 'id',
      title: t('invocations.invocations.columns.id'),
      width: 96,
      skeleton: '4127',
      render: (row) => (
        <AppLink to="/invocations/$invocationId" params={{ invocationId: row.id }}>
          {row.id}
        </AppLink>
      ),
    },
    {
      key: 'state',
      title: t('invocations.invocations.columns.state'),
      width: 128,
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'chat',
      title: t('invocations.invocations.columns.chat'),
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>
            {row.chat.title ?? row.chat.telegram_chat_id ?? row.chat.room_id}
          </div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>{row.chat.type}</div>
        </div>
      ),
    },
    {
      key: 'tools',
      title: t('invocations.invocations.columns.tools'),
      align: 'right',
      width: 104,
      render: (row) => formatNumber(row.tool_call_count),
    },
    {
      key: 'tokens',
      title: t('invocations.invocations.columns.tokens'),
      align: 'right',
      width: 112,
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'created',
      title: t('invocations.invocations.columns.created'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.created_at),
    },
  ];

  // The first load is not retried and the page does not poll, so a failed one
  // leaves no data for good: "loading" is only true while it is pending.
  const overviewDescription = (): string => {
    if (data !== undefined) {
      return t('pages.overview.generatedAt', { time: formatTime(data.generated_at) });
    }
    return overview.isPending ? t('common.loading') : t('pages.overview.loadFailed');
  };

  return (
    <div>
      <ListPageHeader
        title={t('layout.nav.overview')}
        description={overviewDescription()}
        actions={
          <>
            {data?.runtime_status.sleeping === true ? (
              <Button variant="outline" color="secondary" disabled={wake.isPending} onClick={() => setWakeOpen(true)}>
                {t('pages.overview.wakeNow')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              color="error"
              disabled={cancel.isPending}
              onClick={() => {
                cancel.reset();
                setCancelOpen(true);
              }}
            >
              {t('pages.overview.cancelOngoing')}
            </Button>
          </>
        }
      />

      {overview.isError ? (
        <Alert tone="error" title={t('pages.overview.loadFailed')} className={css({ marginBlockEnd: '6' })}>
          {errorMessage(overview.error)}
        </Alert>
      ) : null}

      <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4' })}>
        <StatCard
          label={t('pages.overview.statInvocations')}
          value={totalInvocations}
          hint={t('pages.overview.statInvocationsHint')}
          loading={overview.isPending}
        />
        <StatCard
          label={t('pages.overview.fieldOngoingInvocations')}
          value={ongoingInvocations}
          hint={t('pages.overview.ongoingHint')}
          loading={overview.isPending}
        />
        <StatCard
          label={t('pages.overview.statStoredMessages')}
          value={data?.message_count}
          hint={t('pages.overview.storedMessagesHint')}
          loading={overview.isPending}
        />
        <StatCard
          label={t('pages.overview.statCachedAnalyses')}
          value={data?.cached_analysis_count}
          hint={t('pages.overview.cachedAnalysesHint')}
          loading={overview.isPending}
        />
        <StatCard
          label={t('pages.overview.warnings')}
          value={warnings.data?.unread_count}
          hint={t('pages.overview.warningsUnread', { count: formatNumber(warnings.data?.unread_count ?? 0) })}
          loading={warnings.isPending}
        />
      </div>

      <Card
        title={t('pages.overview.recentInvocations')}
        className={css({ marginBlockStart: '6' })}
        footer={<ViewAllLink to="/invocations" label={t('pages.overview.viewAll')} />}
      >
        {recent.isError ? (
          <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(recent.error)}
          </p>
        ) : (
          <TableShell
            columns={recentColumns}
            data={recent.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={recent.isPending}
            skeletonRows={5}
            minWidth={680}
            emptyText={t('common.noRecords')}
          />
        )}
      </Card>

      <div
        className={css({
          display: 'grid',
          gap: '6',
          marginBlockStart: '6',
          '@media (min-width: 1280px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', alignItems: 'start' },
        })}
      >
        <Card
          title={t('pages.overview.warnings')}
          footer={<ViewAllLink to="/warnings" label={t('pages.overview.warningsViewAll')} />}
        >
          {warnings.isPending ? (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '3' })}>
              <Skeleton className={css({ height: '64px' })} />
              <Skeleton className={css({ height: '64px' })} />
            </div>
          ) : warnings.data === undefined ? (
            <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
              {t('pages.overview.warningsLoadFailed')}：{errorMessage(warnings.error)}
            </p>
          ) : (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
              {warnings.isError ? (
                <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
                  {t('pages.overview.warningsLoadFailed')}：{errorMessage(warnings.error)}
                </p>
              ) : null}
              {warnings.data.standing.length + warnings.data.items.length > 0 ? (
                <div className={css({ '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' } })}>
                  {warnings.data.standing.map((warning) => (
                    <WarningCard key={warning.code} warning={warning} />
                  ))}
                  {warnings.data.items.map((warning) => (
                    <WarningCard
                      key={warning.id}
                      warning={warning}
                      pending={markWarningReadMutation.isPending}
                      onMarkRead={(item) => markWarningReadMutation.mutate(item)}
                    />
                  ))}
                </div>
              ) : (
                <p className={css({ margin: '0', color: 'text-muted' })}>{t('pages.overview.warningsNone')}</p>
              )}
            </div>
          )}
        </Card>

        <Card title={t('pages.overview.botStatus')}>
          {data === undefined ? (
            <BotStatusPlaceholder pending={overview.isPending} />
          ) : (
            <dl
              className={css({
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                rowGap: '3',
                columnGap: '6',
                margin: '0',
              })}
            >
              <dt className={css({ color: 'text-muted', whiteSpace: 'nowrap' })}>{t('pages.overview.fieldState')}</dt>
              <dd className={css({ margin: '0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                <SleepBadge sleeping={data.runtime_status.sleeping} />
                {data.runtime_status.sleep_until === null ? null : (
                  <span className={css({ color: 'text-muted' })}>
                    {t('pages.overview.sleepUntil', { time: formatTime(data.runtime_status.sleep_until) })}
                  </span>
                )}
              </dd>
              <dt className={css({ color: 'text-muted', whiteSpace: 'nowrap' })}>
                {t('pages.overview.fieldTelegram')}
              </dt>
              <dd className={css({ margin: '0', minWidth: '0' })}>
                {telegram.isPending ? (
                  <span className={css({ color: 'text-muted' })}>{t('common.loading')}</span>
                ) : telegram.isError ? (
                  <span className={css({ color: 'error-text', overflowWrap: 'anywhere' })}>
                    {errorMessage(telegram.error)}
                  </span>
                ) : (
                  <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
                    <TelegramStatusBadge state={telegram.data.status} />
                    <TelegramStatusReason state={telegram.data.status} />
                    {telegram.data.status.bot === undefined ? null : (
                      <MonoValue value={telegramBotLabel(telegram.data.status.bot)} />
                    )}
                  </div>
                )}
              </dd>
              <dt className={css({ color: 'text-muted', whiteSpace: 'nowrap' })}>{t('pages.overview.adminPauses')}</dt>
              <dd className={css({ margin: '0', minWidth: '0' })}>
                {data.runtime_status.paused_chats.length === 0 ? (
                  <span className={css({ color: 'text-muted' })}>{t('pages.overview.none')}</span>
                ) : (
                  <ul className={css({ display: 'flex', flexDirection: 'column', gap: '2' })}>
                    {data.runtime_status.paused_chats.map((chat) => (
                      <li key={chat.telegram_chat_id}>
                        <div>
                          {chat.title ?? (chat.username === null ? chat.telegram_chat_id : `@${chat.username}`)}
                        </div>
                        <div className={css({ textStyle: 'small', color: 'text-muted' })}>
                          {t('pages.overview.pausedSince', { time: formatTime(chat.paused_at) })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelOpen(false);
          }
        }}
        title={t('pages.overview.cancelDialogTitle')}
        description={t('pages.overview.cancelDialogDescription')}
        confirmText={t('pages.overview.cancelDialogConfirm')}
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={wakeOpen}
        onOpenChange={(open) => {
          if (!open && !wake.isPending) {
            setWakeOpen(false);
          }
        }}
        title={t('pages.overview.wakeDialogTitle')}
        description={t('pages.overview.wakeDialogDescription')}
        confirmText={t('pages.overview.wakeDialogConfirm')}
        pending={wake.isPending}
        error={wake.isError ? errorMessage(wake.error) : null}
        onConfirm={() => wake.mutate()}
      />
    </div>
  );
}
