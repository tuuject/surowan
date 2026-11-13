import { useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, RowActions, SnapshotList, TableShell, ToneBadge } from '@/components/business';
import { ActivityIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import type {
  GroupMemoryChat,
  GroupMemoryLaneProgress,
  GroupMemoryProgressItem,
  GroupMemoryRun,
} from '@/lib/api/group-memories.ts';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { groupMemoryProgressQuery, groupMemoryRunsQuery } from '@/lib/queries';

const NUMERIC = css({ fontVariantNumeric: 'tabular-nums' });
// Secondary lines may wrap: a cut-off timestamp is worse than a taller row.
const SECONDARY = css({ textStyle: 'small', color: 'text-muted', whiteSpace: 'normal' });

type FailureLabel =
  | 'invalidOutput'
  | 'modelError'
  | 'aborted'
  | 'truncated'
  | 'toolModelUnavailable'
  | 'disabled'
  | 'claimLost'
  | 'shutdown'
  | 'interrupted'
  | 'staleClaim'
  | 'other';

/** Failure codes the worker records, shown as plain words; anything else falls back to "other". */
const FAILURE_LABELS: Readonly<Record<string, FailureLabel>> = {
  group_memory_invalid_output: 'invalidOutput',
  group_memory_error: 'modelError',
  group_memory_aborted: 'aborted',
  group_memory_length: 'truncated',
  tool_model_unavailable: 'toolModelUnavailable',
  group_memory_unavailable: 'toolModelUnavailable',
  group_memory_disabled: 'disabled',
  group_memory_claim_lost: 'claimLost',
  shutdown: 'shutdown',
  interrupted: 'interrupted',
  stale_claim: 'staleClaim',
};

function useFailureLabel(): (code: string) => string {
  const { t } = useTranslation();
  return (code) => t(`pages.groupMemories.failure.${FAILURE_LABELS[code] ?? 'other'}`);
}

function lane(
  item: GroupMemoryProgressItem,
  kind: GroupMemoryLaneProgress['lane'],
): GroupMemoryLaneProgress | undefined {
  return item.lanes.find((entry) => entry.lane === kind);
}

function latest(values: readonly (string | null)[]): string | null {
  return values.reduce<string | null>(
    (best, value) => (value !== null && (best === null || value > best) ? value : best),
    null,
  );
}

function ChatCell({ chat }: { readonly chat: GroupMemoryChat }): ReactElement {
  return (
    <div className={css({ minWidth: '0' })}>
      <div className={css({ overflowWrap: 'anywhere' })}>{chat.title ?? chat.telegram_chat_id}</div>
      <div className={SECONDARY}>{chat.telegram_chat_id}</div>
    </div>
  );
}

/** Running beats failing beats healthy; a failing lane also says when it retries. */
function StatusCell({ item }: { readonly item: GroupMemoryProgressItem }): ReactElement {
  const { t } = useTranslation();
  if (item.lanes.some((entry) => entry.state === 'running')) {
    return <ToneBadge tone="info">{t('pages.groupMemories.statusRunning')}</ToneBadge>;
  }
  const failing = item.lanes.filter((entry) => entry.error_code !== null);
  if (failing.length === 0) {
    return <ToneBadge tone="success">{t('pages.groupMemories.statusHealthy')}</ToneBadge>;
  }
  const failures = Math.max(...failing.map((entry) => entry.consecutive_failures));
  const retry = failing
    .map((entry) => entry.next_attempt_at)
    .filter((value): value is string => value !== null)
    .sort()[0];
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1' })}>
      <ToneBadge tone="warning">{t('pages.groupMemories.statusFailing', { count: failures })}</ToneBadge>
      {retry === undefined ? null : (
        <span className={SECONDARY}>{t('pages.groupMemories.retryAt', { time: formatTime(retry) })}</span>
      )}
    </div>
  );
}

/**
 * Per-Chat consolidation progress: how far the live lane has read, what is still
 * pending, the backfill lane while an old backlog is worked through, and whether
 * the latest batches failed. A row opens the Chat's batch history.
 */
export function GroupMemoryProgressPanel(): ReactElement {
  const { t } = useTranslation();
  const progress = useQuery(groupMemoryProgressQuery);
  const [runsChat, setRunsChat] = useState<GroupMemoryChat | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);

  const columns: readonly ColumnSpec<GroupMemoryProgressItem>[] = [
    {
      key: 'chat',
      title: t('pages.groupMemories.colChat'),
      width: 176,
      render: (row) => <ChatCell chat={row.chat} />,
    },
    {
      key: 'status',
      title: t('pages.groupMemories.colStatus'),
      width: 168,
      render: (row) => <StatusCell item={row} />,
    },
    {
      key: 'through',
      title: t('pages.groupMemories.colThrough'),
      width: 176,
      render: (row) => {
        const live = lane(row, 'live');
        return live?.through_at === null || live?.through_at === undefined ? (
          <span className={css({ color: 'text-muted' })}>{t('pages.groupMemories.notStarted')}</span>
        ) : (
          <div>
            <div>{formatTime(live.through_at)}</div>
            <div className={SECONDARY}>{t('pages.groupMemories.messageId', { id: live.through_message_id })}</div>
          </div>
        );
      },
    },
    {
      key: 'pending',
      title: t('pages.groupMemories.colPending'),
      align: 'right',
      width: 88,
      render: (row) => <span className={NUMERIC}>{formatNumber(lane(row, 'live')?.pending ?? 0)}</span>,
    },
    {
      key: 'backfill',
      title: t('pages.groupMemories.colBackfill'),
      width: 176,
      render: (row) => {
        const backfill = lane(row, 'backfill');
        if (backfill === undefined) {
          return <span className={css({ color: 'text-muted' })}>—</span>;
        }
        return (
          <div>
            <div className={NUMERIC}>{t('pages.groupMemories.backfillPending', { count: backfill.pending })}</div>
            <div className={SECONDARY}>
              {t('pages.groupMemories.backfillUntil', { time: formatTime(backfill.until_at) })}
            </div>
          </div>
        );
      },
    },
    {
      key: 'recent',
      title: t('pages.groupMemories.colRecent'),
      width: 176,
      render: (row) => (
        <div>
          <div className={NUMERIC}>
            {t('pages.groupMemories.recentRuns', { success: row.runs_24h.success, error: row.runs_24h.error })}
          </div>
          <div className={SECONDARY}>
            {t('pages.groupMemories.lastSuccess', {
              time: formatTime(latest(row.lanes.map((entry) => entry.last_success_at))),
            })}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      title: t('pages.groupMemories.colActions'),
      align: 'right',
      width: 96,
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.groupMemories.viewRuns')}
            icon={<ActivityIcon />}
            onClick={() => {
              setRunsChat(row.chat);
              setRunsOpen(true);
            }}
          />
        </RowActions>
      ),
    },
  ];

  return (
    <Panel title={t('pages.groupMemories.progressTitle')}>
      {progress.isError ? (
        <Alert tone="error" title={t('pages.groupMemories.progressFailed')}>
          {errorMessage(progress.error)}
        </Alert>
      ) : (
        <TableShell
          columns={columns}
          data={progress.data?.items ?? []}
          rowKey={(row) => row.chat.telegram_chat_id}
          loading={progress.isPending}
          skeletonRows={2}
          minWidth={1056}
          emptyText={t('pages.groupMemories.progressEmpty')}
        />
      )}
      <Dialog
        open={runsOpen}
        onOpenChange={setRunsOpen}
        title={t('pages.groupMemories.runsTitle')}
        description={t('pages.groupMemories.runsDescription', {
          chat: runsChat?.title ?? runsChat?.telegram_chat_id ?? '',
        })}
        size="lg"
        hideClose
        footer={
          <Button variant="ghost" color="secondary" onClick={() => setRunsOpen(false)}>
            {t('pages.groupMemories.close')}
          </Button>
        }
      >
        {runsChat === null ? null : <RunsList chat={runsChat.telegram_chat_id} />}
      </Dialog>
    </Panel>
  );
}

function RunsList({ chat }: { readonly chat: string }): ReactElement {
  const { t } = useTranslation();
  const failureLabel = useFailureLabel();
  const filters = useMemo(() => ({ chat }), [chat]);
  const columns: readonly ColumnSpec<GroupMemoryRun>[] = [
    {
      key: 'started',
      title: t('pages.groupMemories.colStarted'),
      width: 192,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.started_at),
    },
    {
      key: 'batch',
      title: t('pages.groupMemories.colBatch'),
      width: 160,
      render: (row) => (
        <div>
          <div className={css({ fontFamily: 'mono' })}>
            {row.first_message_id}–{row.through_message_id}
          </div>
          <div className={SECONDARY}>
            {t('pages.groupMemories.runMessages', {
              lane: t(row.lane === 'live' ? 'pages.groupMemories.laneLive' : 'pages.groupMemories.laneBackfill'),
              day: row.day,
              count: row.messages,
            })}
          </div>
        </div>
      ),
    },
    {
      key: 'result',
      title: t('pages.groupMemories.colResult'),
      width: 128,
      render: (row) => (
        <div className={css({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1' })}>
          {row.state === 'success' ? (
            <ToneBadge tone="success">{t('pages.groupMemories.runSuccess', { count: row.events ?? 0 })}</ToneBadge>
          ) : row.state === 'running' ? (
            <ToneBadge tone="info">{t('pages.groupMemories.statusRunning')}</ToneBadge>
          ) : (
            <ToneBadge tone="danger">{t('pages.groupMemories.runFailed')}</ToneBadge>
          )}
          <span className={cx(SECONDARY, NUMERIC)}>
            {t('pages.groupMemories.runCalls', { count: row.model_calls })}
          </span>
        </div>
      ),
    },
    {
      key: 'reason',
      title: t('pages.groupMemories.colReason'),
      render: (row) =>
        row.error_code === null ? (
          <span className={css({ color: 'text-muted' })}>—</span>
        ) : (
          <div className={css({ minWidth: '0', whiteSpace: 'normal' })}>
            <div>{failureLabel(row.error_code)}</div>
            {row.error_detail === null ? null : (
              <div className={cx(SECONDARY, css({ fontFamily: 'mono', overflowWrap: 'anywhere' }))}>
                {row.error_detail}
              </div>
            )}
          </div>
        ),
    },
  ];
  return (
    <SnapshotList
      factory={groupMemoryRunsQuery}
      filters={filters}
      renderItems={(items, { loading }) => (
        <TableShell
          columns={columns}
          data={items}
          rowKey={(row) => row.id}
          loading={loading}
          minWidth={640}
          emptyText={t('pages.groupMemories.runsEmpty')}
        />
      )}
    />
  );
}
