import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatFilter,
  ConfirmDialog,
  ListPageHeader,
  ListSearchForm,
  QuerySelectField,
  SnapshotList,
  TableShell,
} from '@/components/business';
import type { MemoryDraft, MemoryEntry, MemoryUpdate } from '@/lib/api/memories.ts';
import { createMemory, deleteMemory, updateMemory } from '@/lib/api/memories.ts';
import { errorMessage } from '@/lib/errors';
import { chatQuery, optionalQuery, useListQuery } from '@/lib/list-query';
import { daysToTtlSeconds, editTtlDays, editTtlSeconds } from '@/lib/memory-ttl';
import { memoriesQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { memoryColumns } from './memories-columns.tsx';
import { MemoryFormDialog, MemoryViewDialog } from './memories-dialogs.tsx';
import { EMPTY_FORM, type MemoryFormErrors, type MemoryFormValues, validateMemoryForm } from './memories-form.ts';
import { MEMORY_STATES, STATE_LABEL_KEYS } from './memories-status.tsx';

const EMPTY_FILTERS = { state: '', chat: '' };

export default function MemoriesPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useListQuery(EMPTY_FILTERS);
  const { state, chat } = query.value;
  const filters = useMemo(() => ({ state: optionalQuery(state), chat: chatQuery(chat) }), [state, chat]);

  // Each dialog keeps `open` apart from the data it shows, so closing never blanks it mid-fade.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [formValues, setFormValues] = useState<MemoryFormValues>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<MemoryFormErrors>({});
  const [viewOpen, setViewOpen] = useState(false);
  const [viewing, setViewing] = useState<MemoryEntry | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);
  const [created, setCreated] = useState(0);

  const invalidateMemories = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
  };

  const create = useMutation({
    mutationFn: (values: MemoryFormValues) => {
      const ttlSeconds = daysToTtlSeconds(values.ttl_days.trim().length === 0 ? undefined : Number(values.ttl_days));
      const draft: MemoryDraft = {
        chat_id: values.chat_id,
        summary: values.summary.trim(),
        detail: values.detail,
        ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
      };
      return createMemory(draft);
    },
    onSuccess: () => {
      setFormOpen(false);
      toast.success(t('pages.memories.memoCreated'));
      invalidateMemories();
      setCreated((count) => count + 1);
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const update = useMutation({
    mutationFn: ({ entry, values }: { readonly entry: MemoryEntry; readonly values: MemoryFormValues }) => {
      const ttlSeconds = editTtlSeconds(
        values.ttl_days.trim().length === 0 ? null : Number(values.ttl_days),
        editTtlDays(entry.ttl_seconds),
      );
      const body: MemoryUpdate = {
        summary: values.summary.trim(),
        detail: values.detail,
        ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
      };
      return updateMemory(entry.id, body);
    },
    onSuccess: () => {
      setFormOpen(false);
      toast.success(t('pages.memories.memoUpdated'));
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const remove = useMutation({
    mutationFn: deleteMemory,
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success(t('pages.memories.memoDeleted'));
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open with the inline error; the list still refreshes so a
      // stale row disappears if it was already gone.
      invalidateMemories();
    },
  });

  const openCreate = (): void => {
    create.reset();
    setEditing(null);
    setFormValues(EMPTY_FORM);
    setFormErrors({});
    setFormOpen(true);
  };

  const columns = memoryColumns(t, {
    onView: (row) => {
      setViewing(row);
      setViewOpen(true);
    },
    onEdit: (row) => {
      update.reset();
      setEditing(row);
      setFormValues({
        chat_id: '',
        summary: row.summary,
        detail: row.detail,
        ttl_days: String(editTtlDays(row.ttl_seconds) ?? ''),
      });
      setFormErrors({});
      setFormOpen(true);
    },
    onDelete: (row) => {
      remove.reset();
      setDeleting(row);
      setDeleteOpen(true);
    },
  });

  const stateOptions = MEMORY_STATES.map((value) => ({ value, label: t(STATE_LABEL_KEYS[value]) }));
  const submitting = editing === null ? create : update;

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('layout.nav.memories')} />
      <ListSearchForm value={query.value} emptyValue={EMPTY_FILTERS} onSearch={query.apply}>
        {({ draft, change }) => (
          <>
            <ChatFilter value={draft.chat} onChange={(chat) => change({ chat })} />
            <QuerySelectField
              label={t('pages.memories.filterState')}
              value={draft.state}
              onChange={(state) => change({ state })}
              options={stateOptions}
            />
          </>
        )}
      </ListSearchForm>

      <SnapshotList
        factory={memoriesQuery}
        filters={filters}
        snapshotKey={created}
        actions={
          <Button variant="outline" iconStart={<PlusIcon />} onClick={openCreate}>
            {t('pages.memories.newMemo')}
          </Button>
        }
        renderItems={(items, { loading }) => (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            loading={loading}
            minWidth={960}
            emptyText={t('pages.memories.emptyMemories')}
          />
        )}
      />

      <MemoryFormDialog
        open={formOpen}
        editing={editing}
        values={formValues}
        errors={formErrors}
        pending={submitting.isPending}
        error={submitting.isError ? submitting.error : null}
        onOpenChange={setFormOpen}
        onChange={(patch) => setFormValues((previous) => ({ ...previous, ...patch }))}
        onSubmit={() => {
          const errors = validateMemoryForm(formValues, editing !== null, t);
          setFormErrors(errors);
          if (Object.keys(errors).length > 0 || submitting.isPending) {
            return;
          }
          if (editing === null) {
            create.mutate(formValues);
          } else {
            update.mutate({ entry: editing, values: formValues });
          }
        }}
      />

      <MemoryViewDialog open={viewOpen} entry={viewing} onOpenChange={setViewOpen} />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleteOpen(false);
          }
        }}
        title={t('pages.memories.deleteTitle')}
        description={t('pages.memories.deleteDescription')}
        confirmText={t('pages.memories.deleteConfirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting.id);
          }
        }}
      />
    </div>
  );
}
