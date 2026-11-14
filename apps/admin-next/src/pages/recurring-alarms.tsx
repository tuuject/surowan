import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { PlusIcon, TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { Switch } from '@tuuject/koi-react/switch';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  RowActions,
  SnapshotList,
  TableShell,
  TimeText,
} from '@/components/business';
import { EditIcon, EyeIcon, PlayIcon } from '@/components/icons';
import {
  AlarmFormFields,
  type RecurringFormErrors,
  targetLabel,
  validateForm,
} from '@/components/recurring-alarms/alarm-form.tsx';
import { FiringSummary, RecurringAlarmDetails } from '@/components/recurring-alarms/details.tsx';
import { ApiError } from '@/lib/api/core.ts';
import {
  createRecurringAlarm,
  deleteRecurringAlarm,
  draftFromAlarm,
  listRecurringTargets,
  type RecurringAlarm,
  runRecurringAlarm,
  updateRecurringAlarm,
} from '@/lib/api/recurring-alarms.ts';
import { errorMessage } from '@/lib/errors';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { recurringAlarmsQuery } from '@/lib/queries';
import {
  draftFromForm,
  emptyForm,
  formFromAlarm,
  incompleteBuilder,
  type RecurringFormState,
  targetKey,
} from '@/lib/recurring-form.ts';
import { toast } from '@/lib/toast.ts';

const EMPTY_FILTERS = { enabled: '', chat: '' };
const KNOWN_ERRORS = ['previous_pending', 'target_unavailable', 'too_many_recurring_alarms'] as const;

function useRecurringErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation();
  return (error) => {
    const known = error instanceof ApiError ? KNOWN_ERRORS.find((code) => code === error.code) : undefined;
    return known === undefined ? errorMessage(error) : t(`pages.recurringAlarms.errors.${known}`);
  };
}

export default function RecurringAlarmsPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const recurringError = useRecurringErrorMessage();
  const query = useListQuery(EMPTY_FILTERS);
  const filters = useMemo(
    () => ({ enabled: optionalQuery(query.value.enabled), chat: chatQuery(query.value.chat) }),
    [query.value.enabled, query.value.chat],
  );
  const targets = useQuery({ queryKey: ['recurring-alarms', 'targets'], queryFn: listRecurringTargets });
  const [snapshotKey, setSnapshotKey] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringAlarm | null>(null);
  const [form, setForm] = useState<RecurringFormState | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [formErrors, setFormErrors] = useState<RecurringFormErrors>({});
  const [viewing, setViewing] = useState<RecurringAlarm | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [running, setRunning] = useState<RecurringAlarm | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [deleting, setDeleting] = useState<RecurringAlarm | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['recurring-alarms'] });
  };

  const save = useMutation({
    mutationFn: async (input: { readonly state: RecurringFormState; readonly alarm: RecurringAlarm | null }) => {
      const draft = draftFromForm(input.state);
      if (input.alarm !== null) {
        return await updateRecurringAlarm(input.alarm.id, draft, input.alarm.revision);
      }
      const [chatId = '', threadId = '0'] = input.state.target.split(':');
      return await createRecurringAlarm({ ...draft, chat_id: chatId, message_thread_id: threadId });
    },
    onSuccess: (_saved, input) => {
      setFormOpen(false);
      toast.success(input.alarm === null ? t('pages.recurringAlarms.created') : t('pages.recurringAlarms.updated'));
      if (input.alarm === null) {
        setSnapshotKey((key) => key + 1);
      }
      invalidate();
    },
    onError: (error, input) => {
      invalidate();
      // A stale revision closes the form: retrying would overwrite the newer version.
      if (input.alarm !== null && error instanceof ApiError && error.code === 'revision_conflict') {
        setFormOpen(false);
        toast.error(t('pages.recurringAlarms.staleTitle'), {
          description: t('pages.recurringAlarms.staleDescription'),
        });
      }
    },
  });

  const toggle = useMutation({
    mutationFn: (alarm: RecurringAlarm) =>
      updateRecurringAlarm(alarm.id, { ...draftFromAlarm(alarm), enabled: !alarm.enabled }, alarm.revision),
    onSettled: invalidate,
    onError: (error) => toast.error(recurringError(error)),
  });

  const run = useMutation({
    mutationFn: (alarm: RecurringAlarm) => runRecurringAlarm(alarm.id),
    onSuccess: (_result, alarm) => {
      setRunOpen(false);
      toast.success(t('pages.recurringAlarms.ran'));
      invalidate();
      setViewing(alarm);
      setViewOpen(true);
    },
    onError: invalidate,
  });

  const remove = useMutation({
    mutationFn: (alarm: RecurringAlarm) => deleteRecurringAlarm(alarm.id),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success(t('pages.recurringAlarms.deleted'));
      invalidate();
    },
    onError: invalidate,
  });

  const openCreate = (): void => {
    save.reset();
    const firstAvailable = targets.data?.items.find((option) => option.available);
    setEditing(null);
    setForm(
      emptyForm(
        targets.data?.default_time_zone ?? 'UTC',
        firstAvailable === undefined ? '' : targetKey(firstAvailable),
      ),
    );
    setFormErrors({});
    setFormKey((key) => key + 1);
    setFormOpen(true);
  };

  const openEdit = (alarm: RecurringAlarm): void => {
    save.reset();
    setEditing(alarm);
    setForm(formFromAlarm(alarm));
    setFormErrors({});
    setFormKey((key) => key + 1);
    setFormOpen(true);
  };

  const columns: readonly ColumnSpec<RecurringAlarm>[] = [
    {
      key: 'title',
      title: t('pages.recurringAlarms.colTitle'),
      render: (row) => (
        <div dir="auto" className={css({ truncate: true, fontWeight: 'medium' })}>
          {row.title}
        </div>
      ),
    },
    {
      key: 'target',
      title: t('pages.recurringAlarms.colTarget'),
      render: (row) => <div className={css({ truncate: true })}>{targetLabel(t, row.target)}</div>,
    },
    {
      key: 'schedule',
      title: t('pages.recurringAlarms.colSchedule'),
      width: 168,
      render: (row) => (
        <div className={css({ fontFamily: 'mono', textStyle: 'small', whiteSpace: 'pre-line' })}>
          {row.rules.join('\n')}
        </div>
      ),
    },
    {
      key: 'next',
      title: t('pages.recurringAlarms.colNext'),
      width: 200,
      skeleton: 'Thu 2026-11-19 08:00',
      render: (row) => (
        <div>
          <div>
            <TimeText value={row.next_fire_at} timeZone={row.time_zone} />
          </div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>{row.time_zone}</div>
        </div>
      ),
    },
    {
      key: 'enabled',
      title: t('pages.recurringAlarms.colEnabled'),
      width: 88,
      render: (row) => (
        <Switch
          aria-label={t('pages.recurringAlarms.toggleAria', { title: row.title })}
          checked={row.enabled}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate(row)}
        />
      ),
    },
    {
      key: 'last',
      title: t('pages.recurringAlarms.colLast'),
      width: 200,
      render: (row) => <FiringSummary firing={row.last_firing} />,
    },
    {
      key: 'action',
      title: t('pages.recurringAlarms.colAction'),
      align: 'right',
      width: 168,
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.recurringAlarms.details')}
            icon={<EyeIcon />}
            onClick={() => {
              setViewing(row);
              setViewOpen(true);
            }}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.recurringAlarms.edit')}
            icon={<EditIcon />}
            onClick={() => openEdit(row)}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.recurringAlarms.runNow')}
            icon={<PlayIcon />}
            onClick={() => {
              run.reset();
              setRunning(row);
              setRunOpen(true);
            }}
          />
          <IconButton
            variant="ghost"
            color="error"
            label={t('pages.recurringAlarms.delete')}
            icon={<TrashIcon />}
            onClick={() => {
              remove.reset();
              setDeleting(row);
              setDeleteOpen(true);
            }}
          />
        </RowActions>
      ),
    },
  ];

  const blocked = form === null || incompleteBuilder(form).size > 0;

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader
        title={t('layout.nav.recurringAlarms')}
        actions={
          <Button iconStart={<PlusIcon />} disabled={targets.data === undefined} onClick={openCreate}>
            {t('pages.recurringAlarms.newAlarm')}
          </Button>
        }
      />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <QuerySelectField
              label={t('pages.recurringAlarms.filterStatus')}
              value={draft.enabled}
              onChange={(enabled) => change({ enabled })}
              options={[
                { value: 'true', label: t('pages.recurringAlarms.statusEnabled') },
                { value: 'false', label: t('pages.recurringAlarms.statusDisabled') },
              ]}
            />
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
          </>
        )}
      </ListSearchForm>
      <SnapshotList
        factory={recurringAlarmsQuery}
        filters={filters}
        snapshotKey={snapshotKey}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1180}
            emptyText={t('pages.recurringAlarms.empty')}
          />
        )}
      />
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (!open && save.isPending) {
            return;
          }
          setFormOpen(open);
        }}
        title={
          editing === null
            ? t('pages.recurringAlarms.createTitle')
            : t('pages.recurringAlarms.editTitle', { title: editing.title })
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={save.isPending} onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={save.isPending}
              loadingLabel={t('common.saving')}
              disabled={blocked}
              onClick={() => {
                if (form === null) {
                  return;
                }
                const errors = validateForm(t, form);
                setFormErrors(errors);
                if (Object.keys(errors).length === 0) {
                  save.mutate({ state: form, alarm: editing });
                }
              }}
            >
              {editing === null ? t('pages.recurringAlarms.create') : t('pages.recurringAlarms.save')}
            </Button>
          </>
        }
      >
        {form === null ? null : (
          <AlarmFormFields
            key={formKey}
            state={form}
            onChange={setForm}
            targets={
              editing === null
                ? (targets.data?.items ?? [])
                : [
                    {
                      ...editing.target,
                      conversation_id: editing.target.conversation_id,
                      available: true,
                      reason: null,
                    },
                  ]
            }
            errors={formErrors}
            disabled={save.isPending}
            editing={editing !== null}
          />
        )}
        {save.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {recurringError(save.error)}
          </p>
        ) : null}
      </Dialog>
      <Dialog
        open={viewOpen}
        onOpenChange={setViewOpen}
        title={viewing?.title ?? ''}
        size="lg"
        hideClose
        footer={
          <Button variant="ghost" color="secondary" onClick={() => setViewOpen(false)}>
            {t('common.dismiss')}
          </Button>
        }
      >
        {viewing === null ? null : <RecurringAlarmDetails id={viewing.id} />}
      </Dialog>
      <ConfirmDialog
        open={runOpen}
        onOpenChange={(open) => {
          if (!open && !run.isPending) {
            setRunOpen(false);
          }
        }}
        title={t('pages.recurringAlarms.runTitle', { title: running?.title ?? '' })}
        description={t('pages.recurringAlarms.runDescription')}
        confirmText={t('pages.recurringAlarms.runConfirm')}
        pending={run.isPending}
        error={run.isError ? recurringError(run.error) : null}
        onConfirm={() => {
          if (running !== null) {
            run.mutate(running);
          }
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleteOpen(false);
          }
        }}
        title={t('pages.recurringAlarms.deleteTitle', { title: deleting?.title ?? '' })}
        description={t('pages.recurringAlarms.deleteDescription')}
        confirmText={t('pages.recurringAlarms.deleteConfirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? recurringError(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
      />
    </div>
  );
}
