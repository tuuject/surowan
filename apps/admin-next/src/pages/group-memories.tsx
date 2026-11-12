import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Field } from '@tuuject/koi-react/field';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  ListPageHeader,
  ListSearchForm,
  QueryTextField,
  RowActions,
  SnapshotList,
  TableShell,
} from '@/components/business';
import { EditIcon, EyeIcon } from '@/components/icons';
import type { GroupMemoryEntry } from '@/lib/api/group-memories.ts';
import { deleteGroupMemory, groupMemorySource, updateGroupMemory } from '@/lib/api/group-memories.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { groupMemoriesQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const SUMMARY_MAX_LENGTH = 150;
const EMPTY_FILTERS = { chat: '', day: '', search: '' };

export default function GroupMemoriesPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { chat, day, search } = query.value;
  const filters = useMemo(
    () => ({ chat: chatQuery(chat), day: optionalQuery(day), search: optionalQuery(search) }),
    [chat, day, search],
  );
  // Each dialog keeps `open` apart from its entry, so closing never blanks the content mid-fade.
  const [editing, setEditing] = useState<GroupMemoryEntry | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [deleting, setDeleting] = useState<GroupMemoryEntry | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [source, setSource] = useState<GroupMemoryEntry | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['group-memories'] });
  };

  const update = useMutation({
    mutationFn: (target: GroupMemoryEntry) => updateGroupMemory(target.id, summary.trim()),
    onSuccess: () => {
      setEditOpen(false);
      toast.success(t('pages.groupMemories.updated'));
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (target: GroupMemoryEntry) => deleteGroupMemory(target.id),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success(t('pages.groupMemories.deleted'));
      invalidate();
    },
  });
  const sourceQuery = useQuery({
    queryKey: ['group-memory-source', source?.id ?? null],
    queryFn: () => groupMemorySource(source?.id ?? ''),
    enabled: sourceOpen && source !== null,
  });

  const columns: readonly ColumnSpec<GroupMemoryEntry>[] = [
    {
      key: 'day',
      title: t('pages.groupMemories.colDay'),
      width: 120,
      skeleton: '2026-01-18',
      render: (row) => row.day,
    },
    {
      key: 'chat',
      title: t('pages.groupMemories.colChat'),
      width: 200,
      render: (row) => (
        <div className={css({ minWidth: '0' })}>
          <div className={css({ truncate: true })}>{row.chat.title ?? row.chat.telegram_chat_id}</div>
          <div className={css({ textStyle: 'small', color: 'text-muted' })}>{row.chat.telegram_chat_id}</div>
        </div>
      ),
    },
    {
      key: 'summary',
      title: t('pages.groupMemories.colSummary'),
      render: (row) => (
        <p className={css({ margin: '0', lineClamp: '2', whiteSpace: 'normal', overflowWrap: 'anywhere' })}>
          {row.summary}
        </p>
      ),
    },
    {
      key: 'range',
      title: t('pages.groupMemories.colRange'),
      width: 136,
      render: (row) => (
        <span className={css({ fontFamily: 'mono' })}>
          {row.first_message_id}–{row.last_message_id}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.groupMemories.colCreated'),
      width: 184,
      skeleton: '2026-01-18 10:58:15',
      render: (row) => formatTime(row.created_at),
    },
    {
      key: 'actions',
      title: t('pages.groupMemories.colActions'),
      align: 'right',
      width: 140,
      paddingBlock: 'none',
      render: (row) => (
        <RowActions>
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('pages.groupMemories.viewSource')}
            icon={<EyeIcon />}
            onClick={() => {
              setSource(row);
              setSourceOpen(true);
            }}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            label={t('common.edit')}
            icon={<EditIcon />}
            onClick={() => {
              update.reset();
              setSummary(row.summary);
              setEditing(row);
              setEditOpen(true);
            }}
          />
          <IconButton
            variant="ghost"
            color="error"
            label={t('common.delete')}
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

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.groupMemories')} />
      <Alert tone="info" title={t('pages.groupMemories.alertTitle')}>
        <Trans i18nKey="pages.groupMemories.alertDescription" components={{ code: <code /> }} />
      </Alert>

      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
            <QueryTextField
              label={t('pages.groupMemories.searchPlaceholder')}
              value={draft.search}
              onChange={(search) => change({ search })}
            />
            <QueryTextField
              type="date"
              label={t('pages.groupMemories.dayFilter')}
              value={draft.day}
              onChange={(day) => change({ day })}
            />
          </>
        )}
      </ListSearchForm>

      <SnapshotList
        factory={groupMemoriesQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={1000}
            emptyText={t('pages.groupMemories.empty')}
          />
        )}
      />

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          if (!open && !update.isPending) {
            setEditOpen(false);
          }
        }}
        title={t('pages.groupMemories.editTitle')}
        description={t('pages.groupMemories.editDescription')}
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={update.isPending} onClick={() => setEditOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={summary.trim().length === 0}
              loading={update.isPending}
              loadingLabel={t('common.saving')}
              onClick={() => editing !== null && update.mutate(editing)}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '4' })}>
          <Field label={t('pages.groupMemories.summaryLabel')} help={`${summary.length} / ${SUMMARY_MAX_LENGTH}`}>
            <Input
              maxLength={SUMMARY_MAX_LENGTH}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          {update.isError ? (
            <p role="alert" className={css({ margin: '0', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(update.error)}
            </p>
          ) : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleteOpen(false);
          }
        }}
        title={t('pages.groupMemories.deleteTitle')}
        description={t('pages.groupMemories.deleteDescription')}
        confirmText={t('pages.groupMemories.deleteConfirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
      />

      <Dialog
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        title={t('pages.groupMemories.sourceTitle')}
        description={
          source === null
            ? ''
            : t('pages.groupMemories.sourceDescription', {
                first: source.first_message_id,
                last: source.last_message_id,
              })
        }
        size="lg"
        hideClose
        footer={
          <Button variant="ghost" color="secondary" onClick={() => setSourceOpen(false)}>
            {t('pages.groupMemories.close')}
          </Button>
        }
      >
        {sourceQuery.isPending ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>
        ) : sourceQuery.isError ? (
          <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {errorMessage(sourceQuery.error)}
          </p>
        ) : (
          <pre
            className={css({
              margin: '0',
              maxHeight: '60dvh',
              overflow: 'auto',
              borderRadius: 'xl',
              bg: 'surface-muted',
              padding: '4',
              fontFamily: 'mono',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            })}
          >
            {sourceQuery.data?.text ?? ''}
          </pre>
        )}
      </Dialog>
    </div>
  );
}
