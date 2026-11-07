import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  CursorList,
  KvList,
  ListPageHeader,
  ListSearchForm,
  MonoValue,
  QuerySelectField,
  QueryTextField,
  StateBadge,
  TableShell,
  TextValue,
} from '@/components/business';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AlarmListItem } from '@/lib/api/alarms.ts';
import { cancelAlarm } from '@/lib/api/alarms.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { alarmsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const ALARM_STATES = ['pending', 'firing', 'fired', 'cancelled'] as const;
const EMPTY_FILTERS = { state: '', chat: '', target: '' };

function ChatCell({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</div>
      <div className="text-muted-foreground text-xs">
        {row.chat.telegram_chat_id}
        {row.chat.message_thread_id === '0' ? '' : t('pages.alarms.topicSuffix', { topic: row.chat.message_thread_id })}
      </div>
    </div>
  );
}

function TargetCell({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="font-medium">{row.target_display_name}</div>
      <div className="text-muted-foreground text-xs">{row.target_user_id}</div>
    </div>
  );
}

function InvocationLink({ id }: { readonly id: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Link
      to="/invocations/$invocationId"
      params={{ invocationId: id }}
      className="font-mono text-xs break-all underline-offset-4 hover:underline"
    >
      {t('pages.alarms.toolSession', { id })}
    </Link>
  );
}

function AlarmDetails({ row }: { readonly row: AlarmListItem }): React.ReactElement {
  const { t } = useTranslation();
  const createdBy = row.created_by_invocation_id;
  const fired = `${formatTime(row.fired_at)}${row.invocation_outcome === null ? '' : t('pages.alarms.outcomeSuffix', { outcome: row.invocation_outcome })}${row.completion_reason === null ? '' : t('pages.alarms.firedReasonSuffix', { reason: row.completion_reason })}`;
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
          value: <span className="text-wrap whitespace-pre-wrap">{row.summary}</span>,
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

export default function AlarmsPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { state, chat, target } = query.value;
  const [viewing, setViewing] = useState<AlarmListItem | null>(null);
  const [cancelling, setCancelling] = useState<AlarmListItem | null>(null);
  const filters = useMemo(
    () => ({ state: optionalQuery(state), chat: chatQuery(chat), target: optionalQuery(target) }),
    [state, chat, target],
  );

  const cancel = useMutation({
    mutationFn: cancelAlarm,
    onSuccess: () => {
      setCancelling(null);
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
    { key: 'state', title: t('pages.alarms.colStatus'), render: (row) => <StateBadge state={row.state} /> },
    { key: 'scheduled_at', title: t('pages.alarms.colScheduled'), render: (row) => formatTime(row.scheduled_at) },
    { key: 'chat', title: t('pages.alarms.colChat'), render: (row) => <ChatCell row={row} /> },
    { key: 'target', title: t('pages.alarms.colTargetUser'), render: (row) => <TargetCell row={row} /> },
    {
      key: 'summary',
      title: t('pages.alarms.colSummary'),
      className: 'max-w-72 min-w-40 whitespace-normal',
      render: (row) => <div className="line-clamp-1">{row.summary}</div>,
    },
    {
      key: 'invocation',
      title: t('pages.alarms.colInvocation'),
      render: (row) => {
        const id = row.invocation_id ?? row.created_by_invocation_id;
        return id === null ? <span className="text-muted-foreground">—</span> : <InvocationLink id={id} />;
      },
    },
    {
      key: 'action',
      title: t('pages.alarms.colAction'),
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('common.view')}
            onClick={() => setViewing(row)}
          >
            <Eye />
          </Button>
          {row.state === 'pending' ? (
            <Button type="button" size="sm" variant="destructive" onClick={() => setCancelling(row)}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <ListPageHeader title={t('layout.nav.alarms')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('pages.alarms.filterState')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={ALARM_STATES.map((value) => ({ value, label: value }))}
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
      <CursorList
        factory={alarmsQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            frame={false}
            emptyText={t('pages.alarms.emptyAlarms')}
          />
        )}
      />
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pages.alarms.labelAlarmId')}</DialogTitle>
            <DialogDescription>{viewing?.id ?? ''}</DialogDescription>
          </DialogHeader>
          {viewing === null ? null : <AlarmDetails row={viewing} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setViewing(null)}>
              {t('common.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) {
            setCancelling(null);
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
