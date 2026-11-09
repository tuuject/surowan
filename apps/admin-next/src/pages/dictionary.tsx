import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { PlusIcon, UploadIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  ListToolbar,
  QueryTextField,
  TableShell,
  useClientPagination,
} from '@/components/business';
import { DictionaryConflictAlert } from '@/components/dictionary/conflict-alert.tsx';
import { dictionaryColumns } from '@/components/dictionary/entry-columns.tsx';
import { EntryFormFields } from '@/components/dictionary/entry-form.tsx';
import { ExportDialog } from '@/components/dictionary/export-dialog.tsx';
import { ImportDialog } from '@/components/dictionary/import-dialog.tsx';
import { InjectionPanel } from '@/components/dictionary/injection-panel.tsx';
import { MergeDialog } from '@/components/dictionary/merge-dialog.tsx';
import { DictionaryScopePanel } from '@/components/dictionary/scope-panel.tsx';
import { DownloadIcon, MergeIcon } from '@/components/icons';
import type { DictionaryDraft, DictionaryEntry, DictionaryScope } from '@/lib/api/dictionary.ts';
import { createDictionaryEntry, deleteDictionaryEntry, updateDictionaryEntry } from '@/lib/api/dictionary.ts';
import {
  conflictedEntryIds,
  type DictionaryDraftErrors,
  dictionaryErrorMessage,
  draftFromEntry,
  isDictionaryConflict,
  normalizeDraft,
  validateDraft,
} from '@/lib/dictionary.ts';
import { chatQuery, useListQuery } from '@/lib/list-query';
import { dictionaryChatsQuery, dictionaryQuery } from '@/lib/queries.ts';
import { toast } from '@/lib/toast.ts';

const EMPTY_FILTERS = { chat: '', search: '' };
const EMPTY_DRAFT: DictionaryDraft = {
  term: '',
  definition: '',
  aliases: [],
  scope: 'global',
  chat_id: null,
  enabled: true,
};

export default function DictionaryPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery(dictionaryChatsQuery);

  const query = useListQuery(EMPTY_FILTERS);
  const chat = chatQuery(query.value.chat);
  const scope: DictionaryScope = chat === undefined ? 'global' : 'group';
  const chatId: string | null = chat ?? null;
  const search = query.value.search;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  // Remounts the form per open, so a dialog reopened before its exit transition
  // ends still starts from the fresh draft (the popup is only unmounted once
  // the transition completes).
  const [createFormKey, setCreateFormKey] = useState(0);
  const [createDraft, setCreateDraft] = useState<DictionaryDraft>(EMPTY_DRAFT);
  const [createErrors, setCreateErrors] = useState<DictionaryDraftErrors>({});
  // Every dialog stays mounted and keeps its target snapshot after it closes:
  // `open` is what the transition follows, and the snapshot is replaced on the
  // next open so the title and fields do not blank out during the exit fade.
  const [editing, setEditing] = useState<{ readonly entry: DictionaryEntry; readonly draft: DictionaryDraft } | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [editFormKey, setEditFormKey] = useState(0);
  const [editErrors, setEditErrors] = useState<DictionaryDraftErrors>({});
  const [deleting, setDeleting] = useState<DictionaryEntry | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mergeTargets, setMergeTargets] = useState<readonly DictionaryEntry[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const target = { scope, chat: chatId };
  const list = useQuery(dictionaryQuery(target, search));

  const chatOptions = chats.data?.items ?? [];
  const conflicts = list.data?.conflicts ?? [];
  const conflicted = useMemo(() => conflictedEntryIds(conflicts), [conflicts]);
  const items = list.data?.items ?? [];
  const pagination = useClientPagination(items, `${scope}:${chatId ?? ''}:${query.resetKey}`);

  // Selection only makes sense for entries that are actually listed; a search
  // or scope change drops ids no longer visible.
  const visibleIds = useMemo(() => new Set(items.map((entry) => entry.id)), [items]);
  const selectedIds = useMemo(() => [...selected].filter((id) => visibleIds.has(id)), [selected, visibleIds]);
  const selectedEntries = items.filter((entry) => selectedIds.includes(entry.id));

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['dictionary'] });
  };

  const toggleSelected = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const create = useMutation({
    mutationFn: (draft: DictionaryDraft) => createDictionaryEntry(normalizeDraft(draft)),
    onSuccess: () => {
      // The draft stays until the next open so the fields render through the
      // exit transition; `openCreate` replaces it.
      setCreateOpen(false);
      toast.success(t('dictionary.entry.created'));
      invalidate();
    },
    onError: () => {
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (input: { readonly entry: DictionaryEntry; readonly draft: DictionaryDraft }) =>
      updateDictionaryEntry(input.entry.id, normalizeDraft(input.draft), input.entry.revision),
    onSuccess: () => {
      setEditOpen(false);
      toast.success(t('dictionary.entry.updated'));
      invalidate();
    },
    onError: (error) => {
      invalidate();
      // A revision conflict closes the form: retrying would overwrite whatever
      // changed on the server, so the admin reopens against fresh data.
      if (isDictionaryConflict(error)) {
        setEditOpen(false);
        toast.error(t('dictionary.entry.staleTitle'), { description: t('dictionary.entry.staleDescription') });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (entry: DictionaryEntry) => deleteDictionaryEntry(entry.id, entry.revision),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success(t('dictionary.delete.deleted'));
      invalidate();
    },
    onError: () => {
      invalidate();
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: (entry: DictionaryEntry) =>
      updateDictionaryEntry(entry.id, { ...draftFromEntry(entry), enabled: !entry.enabled }, entry.revision),
    onSuccess: () => {
      invalidate();
    },
    onError: () => {
      invalidate();
    },
  });

  const openCreate = (): void => {
    create.reset();
    setCreateDraft(EMPTY_DRAFT);
    setCreateErrors({});
    setCreateFormKey((key) => key + 1);
    setCreateOpen(true);
  };

  const columns = dictionaryColumns({
    t,
    chats: chatOptions,
    conflicted,
    toggleEnabledPending: toggleEnabled.isPending,
    onToggleEnabled: (entry) => toggleEnabled.mutate(entry),
    onEdit: (entry) => {
      update.reset();
      setEditErrors({});
      setEditing({ entry, draft: draftFromEntry(entry) });
      setEditFormKey((key) => key + 1);
      setEditOpen(true);
    },
    onDelete: (entry) => {
      remove.reset();
      setDeleting(entry);
      setDeleteOpen(true);
    },
  });

  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('dictionary.page.title')} description={t('dictionary.page.description')} />
      <div
        className={css({
          display: 'grid',
          gap: '4',
          '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0,20rem) minmax(0,1fr)' },
        })}
      >
        <DictionaryScopePanel
          chatId={chatId}
          chats={chatOptions}
          chatsPending={chats.isPending}
          chatsFailed={chats.isError}
          chatsError={chats.error}
          onSelect={(nextChatId) => {
            query.apply({ ...query.value, chat: nextChatId ?? '' });
            setSelected(new Set());
          }}
        />

        <InjectionPanel chatId={chatId} />
      </div>

      <ListSearchForm
        value={query.value}
        emptyValue={{ ...EMPTY_FILTERS, chat: query.value.chat }}
        onSearch={query.apply}
      >
        {({ draft, change }) => (
          <QueryTextField
            label={t('dictionary.page.searchPlaceholder')}
            value={draft.search}
            onChange={(search) => change({ search })}
          />
        )}
      </ListSearchForm>

      <ListToolbar
        onRefresh={() => void list.refetch()}
        refreshing={list.isRefetching}
        trailing={
          selectedEntries.length > 0 ? (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('dictionary.page.selectedCount', { count: selectedEntries.length })}
            </span>
          ) : null
        }
      >
        <Button variant="outline" iconStart={<PlusIcon />} onClick={openCreate}>
          {t('dictionary.page.newEntry')}
        </Button>
        <Button
          type="button"
          variant="outline"
          color="secondary"
          onClick={() => setImportOpen(true)}
          iconStart={<UploadIcon />}
        >
          {t('dictionary.page.import')}
        </Button>
        <Button
          type="button"
          variant="outline"
          color="secondary"
          onClick={() => setExportOpen(true)}
          iconStart={<DownloadIcon />}
        >
          {t('dictionary.page.export')}
        </Button>
        <Button
          type="button"
          variant="outline"
          color="secondary"
          disabled={selectedEntries.length < 2}
          title={selectedEntries.length < 2 ? t('dictionary.page.mergeNeedsTwo') : undefined}
          onClick={() => {
            setMergeTargets(selectedEntries);
            setMergeOpen(true);
          }}
          iconStart={<MergeIcon />}
        >
          {t('dictionary.page.mergeSelected', { count: selectedEntries.length })}
        </Button>
      </ListToolbar>

      {list.isError ? (
        <Alert tone="error" title={t('dictionary.page.loadFailed')}>
          {dictionaryErrorMessage(list.error)}
        </Alert>
      ) : null}

      {conflicts.length > 0 ? (
        <DictionaryConflictAlert
          conflicts={conflicts}
          onSelectEntries={(entryIds) => {
            setSelected(new Set(entryIds));
            setMergeOpen(false);
          }}
        />
      ) : null}

      {list.isPending || list.data !== undefined ? (
        <div>
          <TableShell
            columns={columns}
            data={pagination.items}
            rowKey={(entry) => entry.id}
            loading={list.isPending}
            minWidth={1100}
            selection={{
              selected,
              onToggle: (entry) => toggleSelected(entry.id),
              onToggleAll: (checked) =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  for (const entry of pagination.items) {
                    if (checked) {
                      next.add(entry.id);
                    } else {
                      next.delete(entry.id);
                    }
                  }
                  return next;
                }),
              allLabel: t('dictionary.page.selectAll'),
              rowLabel: (entry) => t('dictionary.page.selectAria', { term: entry.term }),
            }}
            emptyText={search.length === 0 ? t('dictionary.page.emptyEntries') : t('dictionary.page.emptyFiltered')}
          />
          <ListFooter
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          >
            <span className={css({ textStyle: 'small', color: 'text-muted', maxWidth: '42rem' })}>
              {t('dictionary.page.retentionNote')}
            </span>
          </ListFooter>
        </div>
      ) : null}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && create.isPending) {
            return;
          }
          setCreateOpen(open);
        }}
        title={t('dictionary.entry.createTitle')}
        description={t('dictionary.entry.createDescription')}
        size="md"
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={create.isPending} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={create.isPending}
              loadingLabel={t('common.saving')}
              onClick={() => {
                const errors = validateDraft(createDraft);
                setCreateErrors(errors);
                if (Object.keys(errors).length === 0) {
                  create.mutate(createDraft);
                }
              }}
            >
              {t('dictionary.entry.create')}
            </Button>
          </>
        }
      >
        <EntryFormFields
          key={createFormKey}
          draft={createDraft}
          chats={chatOptions}
          errors={createErrors}
          disabled={create.isPending}
          idPrefix="create-entry"
          onChange={setCreateDraft}
        />
        {create.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(create.error)}
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          if (!open && update.isPending) {
            return;
          }
          if (!open) {
            setEditOpen(false);
          }
        }}
        title={t('dictionary.entry.editTitle', { term: editing?.entry.term ?? '' })}
        description={t('dictionary.entry.editDescription')}
        size="md"
        footer={
          <>
            <Button variant="ghost" color="secondary" disabled={update.isPending} onClick={() => setEditOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={update.isPending}
              loadingLabel={t('common.saving')}
              onClick={() => {
                if (editing === null) {
                  return;
                }
                const errors = validateDraft(editing.draft);
                setEditErrors(errors);
                if (Object.keys(errors).length === 0) {
                  update.mutate({ entry: editing.entry, draft: editing.draft });
                }
              }}
            >
              {t('dictionary.entry.save')}
            </Button>
          </>
        }
      >
        {editing !== null ? (
          <EntryFormFields
            key={editFormKey}
            draft={editing.draft}
            chats={chatOptions}
            errors={editErrors}
            disabled={update.isPending}
            idPrefix="edit-entry"
            onChange={(draft) => setEditing({ entry: editing.entry, draft })}
          />
        ) : null}
        {conflicted.has(editing?.entry.id ?? '') ? (
          <p className={css({ textStyle: 'body', color: 'warning-text' })}>{t('dictionary.entry.conflictWarning')}</p>
        ) : null}
        {update.isError ? (
          <p className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {dictionaryErrorMessage(update.error)}
          </p>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleteOpen(false);
          }
        }}
        title={t('dictionary.delete.title', { term: deleting?.term ?? '' })}
        description={t('dictionary.delete.description')}
        confirmText={t('dictionary.delete.confirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? dictionaryErrorMessage(remove.error) : null}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        chats={chatOptions}
        defaultScope={scope}
        defaultChatId={chatId}
        onImported={invalidate}
      />

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} scope={scope} chatId={chatId} />

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        entries={mergeTargets}
        chats={chatOptions}
        defaultScope={scope}
        defaultChatId={chatId}
        onMerged={() => setSelected(new Set())}
      />
    </div>
  );
}
