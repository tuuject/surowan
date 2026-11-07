import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { EditIcon, EyeIcon } from '@/components/icons';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  CursorList,
  ListPageHeader,
  ListSearchForm,
  QueryTextField,
  TableShell,
} from '@/components/business';
import { Alert } from '@tuuject/koi-react/alert';
import { Button, IconButton } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import type { GroupMemoryEntry } from '@/lib/api/group-memories.ts';
import { deleteGroupMemory, groupMemorySource, updateGroupMemory } from '@/lib/api/group-memories.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { groupMemoriesQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

const SUMMARY_MAX_LENGTH = 150;
const EMPTY_FILTERS = { chat: '', day: '', search: '' };

export default function GroupMemoriesPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { chat, day, search } = query.value;
  const filters = useMemo(
    () => ({ chat: chatQuery(chat), day: optionalQuery(day), search: optionalQuery(search) }),
    [chat, day, search],
  );
  const [editing, setEditing] = useState<GroupMemoryEntry | null>(null);
  const [summary, setSummary] = useState('');
  const [deleting, setDeleting] = useState<GroupMemoryEntry | null>(null);
  const [source, setSource] = useState<GroupMemoryEntry | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['group-memories'] });
  };

  const update = useMutation({
    mutationFn: (target: GroupMemoryEntry) => updateGroupMemory(target.id, summary.trim()),
    onSuccess: () => {
      setEditing(null);
      toast.success(t('pages.groupMemories.updated'));
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (target: GroupMemoryEntry) => deleteGroupMemory(target.id),
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('pages.groupMemories.deleted'));
      invalidate();
    },
  });
  const sourceQuery = useQuery({
    queryKey: ['group-memory-source', source?.id ?? null],
    queryFn: () => groupMemorySource(source?.id ?? ''),
    enabled: source !== null,
  });

  const columns: readonly ColumnSpec<GroupMemoryEntry>[] = [
    {
      key: 'day',
      title: t('pages.groupMemories.colDay'),
      render: (row) => <span className={css({ fontVariantNumeric: 'tabular-nums' })}>{row.day}</span>,
    },
    {
      key: 'chat',
      title: t('pages.groupMemories.colChat'),
      render: (row) => (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'label' })}>{row.chat.title ?? row.chat.telegram_chat_id}</p>
          <p className={css({ textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>
            {row.chat.telegram_chat_id}
          </p>
        </div>
      ),
    },
    {
      key: 'summary',
      title: t('pages.groupMemories.colSummary'),
      render: (row) => (
        <p className={css({ textStyle: 'body', maxWidth: '42rem', overflowWrap: 'anywhere' })}>{row.summary}</p>
      ),
    },
    {
      key: 'range',
      title: t('pages.groupMemories.colRange'),
      render: (row) => (
        <span className={css({ textStyle: 'small', fontFamily: 'mono', fontVariantNumeric: 'tabular-nums' })}>
          {row.first_message_id}–{row.last_message_id}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.groupMemories.colCreated'),
      render: (row) => (
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>{formatTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t('pages.groupMemories.colActions'),
      align: 'right',
      render: (row) => (
        <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '1' })}>
          <IconButton
            variant="ghost"
            color="secondary"
            title={t('pages.groupMemories.viewSource')}
            onClick={() => setSource(row)}
            label={t('pages.groupMemories.viewSource')}
            icon={<EyeIcon />}
          />
          <IconButton
            variant="ghost"
            color="secondary"
            onClick={() => {
              setSummary(row.summary);
              setEditing(row);
            }}
            label={t('common.edit')}
            icon={<EditIcon />}
          />
          <IconButton
            variant="ghost"
            onClick={() => setDeleting(row)}
            label={t('common.delete')}
            icon={<TrashIcon />}
          />
        </div>
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

      <CursorList
        factory={groupMemoriesQuery}
        filters={filters}
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            emptyText={t('pages.groupMemories.empty')}
          />
        )}
      />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) {
            setEditing(null);
          }
        }}
        title={t('pages.groupMemories.editTitle')}
        description={t('pages.groupMemories.editDescription')}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              disabled={update.isPending}
              onClick={() => setEditing(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={update.isPending || summary.trim().length === 0}
              onClick={() => editing !== null && update.mutate(editing)}
            >
              {update.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
          <Label htmlFor="group-memory-summary">{t('pages.groupMemories.summaryLabel')}</Label>
          <Input
            id="group-memory-summary"
            maxLength={SUMMARY_MAX_LENGTH}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>
            {summary.length}/{SUMMARY_MAX_LENGTH}
          </p>
          {update.isError ? (
            <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {errorMessage(update.error)}
            </p>
          ) : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
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
        open={source !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSource(null);
          }
        }}
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
        footer={
          <>
            <Button type="button" variant="outline" color="secondary" onClick={() => setSource(null)}>
              {t('pages.groupMemories.close')}
            </Button>
          </>
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
              textStyle: 'small',
              maxHeight: '60dvh',
              overflow: 'auto',
              borderRadius: 'lg',
              borderWidth: '1px',
              borderColor: 'border',
              padding: '3',
              whiteSpace: 'pre-wrap',
            })}
          >
            {sourceQuery.data?.text ?? ''}
          </pre>
        )}
      </Dialog>
    </div>
  );
}
