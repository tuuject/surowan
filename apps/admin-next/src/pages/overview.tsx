import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Panel } from '@/components/layout/panel';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
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
import { TelegramStatusBadge, TelegramStatusReason, telegramBotLabel } from '@/components/telegram/telegram-status.tsx';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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

function SleepBadge({ sleeping }: { readonly sleeping: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return sleeping ? (
    <ToneBadge tone="warning">{t('pages.overview.sleeping')}</ToneBadge>
  ) : (
    <ToneBadge tone="success">{t('pages.overview.awake')}</ToneBadge>
  );
}

function StatMetric({
  label,
  value,
  hint,
  loading,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly hint: string;
  readonly loading: boolean;
}): React.ReactElement {
  return (
    <div className="border-t pt-3">
      <p className="text-muted-foreground m-0 text-sm">{label}</p>
      <div className="mt-1">
        {loading ? (
          <Skeleton className="block h-9 w-24" />
        ) : (
          <span className="text-3xl font-bold tabular-nums">{value === undefined ? '—' : formatNumber(value)}</span>
        )}
      </div>
      <p className="text-muted-foreground m-0 mt-1 text-sm">{hint}</p>
    </div>
  );
}

export default function OverviewPage(): React.ReactElement {
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
      render: (row) => (
        <Link
          to="/invocations/$invocationId"
          params={{ invocationId: row.id }}
          className="font-medium tabular-nums underline underline-offset-4"
        >
          {row.id}
        </Link>
      ),
    },
    {
      key: 'state',
      title: t('invocations.invocations.columns.state'),
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'chat',
      title: t('invocations.invocations.columns.chat'),
      render: (row) => (
        <div className="min-w-40">
          <div className="font-medium break-words">
            {row.chat.title ?? row.chat.telegram_chat_id ?? row.chat.room_id}
          </div>
          <div className="text-muted-foreground text-xs">{row.chat.type}</div>
        </div>
      ),
    },
    {
      key: 'tools',
      title: t('invocations.invocations.columns.tools'),
      align: 'right',
      render: (row) => formatNumber(row.tool_call_count),
    },
    {
      key: 'tokens',
      title: t('invocations.invocations.columns.tokens'),
      align: 'right',
      render: (row) => formatNumber(row.total_tokens),
    },
    {
      key: 'created',
      title: t('invocations.invocations.columns.created'),
      render: (row) => formatTime(row.created_at),
    },
  ];

  return (
    <div className="space-y-6">
      <ListPageHeader
        title={t('layout.nav.overview')}
        description={
          data === undefined
            ? t('common.loading')
            : t('pages.overview.generatedAt', { time: formatTime(data.generated_at) })
        }
        actions={
          <>
            {data?.runtime_status.sleeping === true ? (
              <Button type="button" variant="outline" disabled={wake.isPending} onClick={() => setWakeOpen(true)}>
                {t('pages.overview.wakeNow')}
              </Button>
            ) : null}
            <Button type="button" variant="destructive" disabled={cancel.isPending} onClick={() => setCancelOpen(true)}>
              {t('pages.overview.cancelOngoing')}
            </Button>
          </>
        }
      />

      {overview.isError ? (
        <div className="text-center">
          <p className="text-destructive font-medium">{t('pages.overview.loadFailed')}</p>
          <p className="text-muted-foreground text-sm break-words">{errorMessage(overview.error)}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <StatMetric
          label={t('pages.overview.statInvocations')}
          value={totalInvocations}
          hint={t('pages.overview.invocationStates')}
          loading={overview.isPending}
        />
        <StatMetric
          label={t('pages.overview.fieldOngoingInvocations')}
          value={ongoingInvocations}
          hint={t('pages.overview.cancelOngoingDesc')}
          loading={overview.isPending}
        />
        <StatMetric
          label={t('pages.overview.statStoredMessages')}
          value={data?.message_count}
          hint={t('layout.nav.messages')}
          loading={overview.isPending}
        />
        <StatMetric
          label={t('pages.overview.statCachedAnalyses')}
          value={data?.cached_analysis_count}
          hint={t('layout.nav.botStickerSets')}
          loading={overview.isPending}
        />
        <StatMetric
          label={t('pages.overview.warnings')}
          value={warnings.data?.unread_count}
          hint={t('pages.overview.warningsUnread', { count: formatNumber(warnings.data?.unread_count ?? 0) })}
          loading={warnings.isPending}
        />
      </div>

      <Panel
        title={t('pages.overview.recentInvocations')}
        action={
          <Link to="/invocations" className="inline-flex items-center gap-1">
            {t('pages.overview.viewAll')}
            <ArrowRight className="inline-block size-4 align-middle" />
          </Link>
        }
      >
        {recent.isPending || recent.data !== undefined ? (
          <TableShell
            columns={recentColumns}
            data={recent.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={recent.isPending}
            skeletonRows={5}
            frame={false}
            emptyText={t('common.noRecords')}
          />
        ) : null}
        {recent.isError ? (
          <p role="alert" className="text-destructive text-sm break-words">
            {errorMessage(recent.error)}
          </p>
        ) : null}
      </Panel>

      <Panel
        title={t('pages.overview.warnings')}
        action={
          <Link to="/warnings" className="inline-flex items-center gap-1">
            {t('pages.overview.warningsViewAll')}
            <ArrowRight className="inline-block size-4 align-middle" />
          </Link>
        }
      >
        {warnings.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : warnings.data === undefined ? (
          <p role="alert" className="text-destructive text-sm break-words">
            {t('pages.overview.warningsLoadFailed')}: {errorMessage(warnings.error)}
          </p>
        ) : (
          <div className="space-y-4">
            {warnings.isError ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {t('pages.overview.warningsLoadFailed')}: {errorMessage(warnings.error)}
              </p>
            ) : null}
            {warnings.data.standing.length > 0 ? (
              <div className="divide-y">
                {warnings.data.standing.map((warning) => (
                  <WarningCard key={warning.code} warning={warning} />
                ))}
              </div>
            ) : null}
            {warnings.data.items.length > 0 ? (
              <div className="divide-y">
                {warnings.data.items.map((warning) => (
                  <WarningCard
                    key={warning.id}
                    warning={warning}
                    pending={markWarningReadMutation.isPending}
                    onMarkRead={(item) => markWarningReadMutation.mutate(item)}
                  />
                ))}
              </div>
            ) : null}
            {warnings.data.standing.length === 0 && warnings.data.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('pages.overview.warningsNone')}</p>
            ) : null}
          </div>
        )}
      </Panel>

      {data === undefined ? null : (
        <Panel title={t('pages.overview.botStatus')}>
          <dl className="grid gap-5 md:grid-cols-3">
            <div className="space-y-2">
              <dt className="text-muted-foreground text-sm">{t('pages.overview.fieldState')}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <SleepBadge sleeping={data.runtime_status.sleeping} />
                {data.runtime_status.sleep_until === null ? null : (
                  <span className="text-muted-foreground text-sm">
                    {t('pages.overview.sleepUntil', { time: formatTime(data.runtime_status.sleep_until) })}
                  </span>
                )}
              </dd>
            </div>
            <div className="space-y-2">
              <dt className="text-muted-foreground text-sm">{t('pages.overview.fieldTelegram')}</dt>
              <dd>
                {telegram.isPending ? (
                  <span className="text-muted-foreground text-sm">{t('common.loading')}</span>
                ) : telegram.isError ? (
                  <span className="text-destructive text-sm break-words">{errorMessage(telegram.error)}</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <TelegramStatusBadge state={telegram.data.status} />
                    <TelegramStatusReason state={telegram.data.status} />
                    {telegram.data.status.bot === undefined ? null : (
                      <MonoValue value={telegramBotLabel(telegram.data.status.bot)} />
                    )}
                  </div>
                )}
              </dd>
            </div>
            <div className="space-y-2">
              <dt className="text-muted-foreground text-sm">{t('pages.overview.adminPauses')}</dt>
              <dd>
                {data.runtime_status.paused_chats.length === 0 ? (
                  <span className="text-muted-foreground text-sm">{t('pages.overview.none')}</span>
                ) : (
                  <ul className="space-y-2">
                    {data.runtime_status.paused_chats.map((chat) => (
                      <li key={chat.telegram_chat_id} className="text-sm">
                        <div className="font-medium">
                          {chat.title ?? (chat.username === null ? chat.telegram_chat_id : `@${chat.username}`)}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          {t('pages.overview.pausedSince', { time: formatTime(chat.paused_at) })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        </Panel>
      )}

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
        destructive
        pending={wake.isPending}
        error={wake.isError ? errorMessage(wake.error) : null}
        onConfirm={() => wake.mutate()}
      />
    </div>
  );
}
