import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  KvList,
  ListPageHeader,
  ListSearchForm,
  MonoValue,
  QuerySelectField,
  QueryTextField,
  RowActions,
  SnapshotList,
  StateBadge,
  TableShell,
  TextValue,
} from '@/components/business';
import { CancelIcon, EyeIcon } from '@/components/icons';
import { AppLink } from '@/components/router-links';
import type { AlarmListItem } from '@/lib/api/alarms.ts';
import { cancelAlarm } from '@/lib/api/alarms.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime, stateLabel } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { alarmsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const ALARM_STATES = ['pending', 'firing', 'fired', 'cancelled'] as const;
const EMPTY_FILTERS = { state: '', chat: '', target: '' };

function ChatCell({ row }: { readonly row: AlarmListItem }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ minWidth: '0' })}>
      <div className={css({ truncate: true })}>{row.chat.title ?? row.chat.telegram_chat_id}</div>
      <div className={css({ display: 'flex', gap: '2', textStyle: 'small', color: 'text-muted' })}>
        <span>{row.chat.telegram_chat_id}</span>
        {row.chat.message_thread_id === '0' ? null : (
          <span>{t('invocations.invocations.topicLabel', { id: row.chat.message_thread_id })}</span>
        )}
      </div>
    </div>
  );
}

function TargetCell({ row }: { readonly row: AlarmListItem }): ReactElement {
  return (
    <div className={css({ minWidth: '0' })}>
      <div className={css({ truncate: true })}>{row.target_display_name}</div>
      <div className={css({ textStyle: 'small', color: 'text-muted' })}>{row.target_user_id}</div>
    </div>
  );
}

function InvocationLink({ id }: { readonly id: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <AppLink to="/invocations/$invocationId" params={{ invocationId: id }}>
      {t('pages.alarms.toolSession', { id })}
    </AppLink>
  );
}

function AlarmDetails({ row }: { readonly row: AlarmListItem }): ReactElement {
  const { t } = useTranslation();
  const createdBy = row.created_by_invocation_id;
  const fired = `${formatTime(row.fired_at)}${row.invocation_outcome === null ? '' : t('pages.alarms.outcomeSuffix', { outcome: stateLabel(row.invocation_outcome) })}${row.completion_reason === null ? '' : t('pages.alarms.firedReasonSuffix', { reason: row.completion_reason })}`;
  const cancelled = `${formatTime(row.cancelled_at)}${row.cancelled_by === null ? '' : t('pages.alarms.bySuffix', { by: row.cancelled_by })}${row.cancel_reason === null ? '' : t('pages.alarms.reasonSuffix', { reason: row.cancel_reason })}${row.admin_cancelled ? t('pages.alarms.adminCancelledSuffix') : ''}`;
  return (
    <KvList
      items={[
        { label: t('pages.alarms.labelAlarmId'), value: <MonoValue value={row.id} /> },
        { label: t('pages.alarms.labelConversationId'), value: <MonoValue value={row.conversation_id} /> },
        { label: t('pages.alarms.labelScheduledUtc'), value: <MonoValue value={row.scheduled_at} /> },
        {
          label: t('pages.alarms.labelTelegramChat'),
          value: `${row.chat.telegram_chat_id}${row.chat.message_thread_id === '0' ? '' : t('pages.alarms.threadSuffix', { thread: row.chat.message_thread_id })}`,
        },
        { label: t('pages.alarms.labelTargetUserId'), value: <MonoValue value={row.target_user_id} /> },
        {
          label: t('pages.alarms.labelSummary'),
          value: <span className={css({ textWrap: 'wrap', whiteSpace: 'pre-wrap' })}>{row.summary}</span>,
        },
        {
          label: t('pages.alarms.labelCreated'),
          value: `${formatTime(row.created_at)}${createdBy === null ? '' : t('pages.alarms.createdBySuffix', { id: createdBy })}`,
        },
        { label: t('pages.alarms.labelFired'), value: fired },
        { label: t('pages.alarms.labelCancelled'), value: cancelled },
        { label: t('pages.alarms.labelUpdated'), value: formatTime(row.updated_at) },
        {
          label: t('pages.alarms.labelInvocation'),
          value: row.invocation_id === null ? <TextValue value={null} /> : <InvocationLink id={row.invocation_id} />,
        },
      ]}
    />
  );
}

export default function AlarmsPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { state, chat, target } = query.value;
  const [viewing, setViewing] = useState<AlarmListItem | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [cancelling, setCancelling] = useState<AlarmListItem | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const filters = useMemo(
    () => ({ state: optionalQuery(state), chat: chatQuery(chat), target: optionalQuery(target) }),
    [state, chat, target],
  );

  const cancel = useMutation({
    mutationFn: cancelAlarm,
    onSuccess: () => {
      setCancelOpen(false);
      toast.success(t('pages.alarms.alarmCancelled'));
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
    },
    onError: () => {
      // 409 (alarm_not_pending) or any other failure: keep the dialog open
      // with the real message and refresh anyway so the list shows the true
      // state (a 409 means the alarm is no longer pending).
      void queryClient.invalidateQueries({ queryKey: ['alarms'] });
    },
  });

  const columns: readonly ColumnSpec<AlarmListItem>[] = [
    {
      key: 'state',
      title: t('pages.alarms.colStatus'),
      width: 112,
      render: (row) => <StateBadge state={row.state} />,
    },
    {
      key: 'scheduled_at',
      title: t('pages.alarms.colScheduled'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.scheduled_at),
    },
    { key: 'chat', title: t('pages.alarms.colChat'), render: (row) => <ChatCell row={row} /> },
    { key: 'target', title: t('pages.alarms.colTargetUser'), width: 160, render: (row) => <TargetCell row={row} /> },
    {
      key: 'summary',
      title: t('pages.alarms.colSummary'),
      render: (row) => <div className={css({ truncate: true })}>{row.summary}</div>,
    },
    {
      key: 'invocation',
      title: t('pages.alarms.colInvocation'),
      width: 168,
      render: (row) => {
        const id = row.invocation_id ?? row.created_by_invocation_id;
        return id === null ? <span className={css({ color: 'text-muted' })}>—</span> : <InvocationLink id={id} />;
      },
    },
    {
      key: 'action',
      title: t('pages.alarms.colAction'),
      align: 'right',
      width: 104,
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            onClick={() => {
              setViewing(row);
              setViewOpen(true);
            }}
            label={t('common.view')}
            icon={<EyeIcon />}
          />
          {row.state === 'pending' ? (
            <IconButton
              variant="ghost"
              color="error"
              label={t('common.cancel')}
              icon={<CancelIcon />}
              onClick={() => {
                cancel.reset();
                setCancelling(row);
                setCancelOpen(true);
              }}
            />
          ) : null}
        </RowActions>
      ),
    },
  ];

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.alarms')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('pages.alarms.filterState')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={ALARM_STATES.map((value) => ({ value, label: stateLabel(value) }))}
            />
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
            <QueryTextField
              label={t('pages.alarms.filterTargetUserId')}
              value={draft.target}
              onChange={(target) => change({ target })}
            />
          </>
        )}
      </ListSearchForm>
      <SnapshotList
        factory={alarmsQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1060}
            emptyText={t('pages.alarms.emptyAlarms')}
          />
        )}
      />
      <Dialog
        open={viewOpen}
        onOpenChange={setViewOpen}
        title={t('pages.alarms.labelAlarmId')}
        description={viewing === null ? undefined : <MonoValue value={viewing.id} />}
        size="lg"
        hideClose
        footer={
          <Button variant="ghost" color="secondary" onClick={() => setViewOpen(false)}>
            {t('common.dismiss')}
          </Button>
        }
      >
        {viewing === null ? null : <AlarmDetails row={viewing} />}
      </Dialog>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelOpen(false);
          }
        }}
        title={t('pages.alarms.cancelTitle')}
        description={t('pages.alarms.cancelDescription')}
        confirmText={t('pages.alarms.cancelConfirm')}
        destructive
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => {
          if (cancelling !== null) {
            cancel.mutate(cancelling.id);
          }
        }}
      />
    </div>
  );
}
