import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Download, Info, Merge, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog, FilterToolbar, TableShell, TextFilter } from '@/components/business';
import { DictionaryConflictAlert } from '@/components/dictionary/conflict-alert.tsx';
import { dictionaryColumns } from '@/components/dictionary/entry-columns.tsx';
import { EntryFormFields } from '@/components/dictionary/entry-form.tsx';
import { ExportDialog } from '@/components/dictionary/export-dialog.tsx';
import { ImportDialog } from '@/components/dictionary/import-dialog.tsx';
import { InjectionPanel } from '@/components/dictionary/injection-panel.tsx';
import { MergeDialog } from '@/components/dictionary/merge-dialog.tsx';
import { DictionaryScopePanel } from '@/components/dictionary/scope-panel.tsx';
import { Panel } from '@/components/layout/panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

import {
  conflictedEntryIds,
  type DictionaryDraftErrors,
  dictionaryErrorMessage,
  draftFromEntry,
  isDictionaryConflict,
  normalizeDraft,
  validateDraft,
} from '@/lib/dictionary.ts';
import { dictionaryChatsQuery, dictionaryQuery } from '@/lib/queries.ts';
import { useChatScope, useChatScopeSetter } from '@/lib/search-params.ts';
import { createDictionaryEntry, deleteDictionaryEntry, updateDictionaryEntry } from '@/lib/api/dictionary.ts';
import type { DictionaryDraft, DictionaryEntry, DictionaryScope } from '@/lib/api/dictionary.ts';

const EMPTY_DRAFT: DictionaryDraft = {
  term: '',
  definition: '',
  aliases: [],
  scope: 'global',
  chat_id: null,
  enabled: true,
};

export default function DictionaryPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chats = useQuery(dictionaryChatsQuery);

  const chat = useChatScope();
  const navigate = useNavigate({ from: '/dictionary' });
  const setChat = useChatScopeSetter(navigate);
  const scope: DictionaryScope = chat === undefined ? 'global' : 'group';
  const chatId: string | null = chat ?? null;
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<DictionaryDraft>(EMPTY_DRAFT);
  const [createErrors, setCreateErrors] = useState<DictionaryDraftErrors>({});
  const [editing, setEditing] = useState<{ readonly entry: DictionaryEntry; readonly draft: DictionaryDraft } | null>(
    null,
  );
  const [editErrors, setEditErrors] = useState<DictionaryDraftErrors>({});
  const [deleting, setDeleting] = useState<DictionaryEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const target = { scope, chat: chatId };
  const list = useQuery(dictionaryQuery(target, search ?? ''));

  const chatOptions = chats.data?.items ?? [];
  const conflicts = list.data?.conflicts ?? [];
  const conflicted = useMemo(() => conflictedEntryIds(conflicts), [conflicts]);
  const items = list.data?.items ?? [];

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
      setCreateOpen(false);
      setCreateDraft(EMPTY_DRAFT);
      setCreateErrors({});
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
      setEditing(null);
      setEditErrors({});
      toast.success(t('dictionary.entry.updated'));
      invalidate();
    },
    onError: (error) => {
      invalidate();
      // A revision conflict closes the form: retrying would overwrite whatever
      // changed on the server, so the admin reopens against fresh data.
      if (isDictionaryConflict(error)) {
        setEditing(null);
        toast.error(t('dictionary.entry.staleTitle'), { description: t('dictionary.entry.staleDescription') });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (entry: DictionaryEntry) => deleteDictionaryEntry(entry.id, entry.revision),
    onSuccess: () => {
      setDeleting(null);
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

  const allVisibleSelected = items.length > 0 && items.every((entry) => selected.has(entry.id));

  const columns = dictionaryColumns({
    t,
    chats: chatOptions,
    conflicted,
    selected,
    toggleEnabledPending: toggleEnabled.isPending,
    onToggleSelected: toggleSelected,
    onToggleEnabled: (entry) => toggleEnabled.mutate(entry),
    onEdit: (entry) => {
      setEditErrors({});
      setEditing({ entry, draft: draftFromEntry(entry) });
    },
    onDelete: (entry) => setDeleting(entry),
  });

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>{t('dictionary.page.title')}</AlertTitle>
        <AlertDescription>{t('dictionary.page.description')}</AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <DictionaryScopePanel
          chatId={chatId}
          chats={chatOptions}
          chatsPending={chats.isPending}
          chatsFailed={chats.isError}
          chatsError={chats.error}
          onSelect={(nextChatId) => {
            setChat(nextChatId ?? undefined);
            setSelected(new Set());
          }}
        />

        <InjectionPanel chatId={chatId} />
      </div>

      <FilterToolbar>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          {t('dictionary.page.newEntry')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload />
          {t('dictionary.page.import')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setExportOpen(true)}>
          <Download />
          {t('dictionary.page.export')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={selectedEntries.length < 2}
          title={selectedEntries.length < 2 ? t('dictionary.page.mergeNeedsTwo') : undefined}
          onClick={() => setMergeOpen(true)}
        >
          <Merge />
          {t('dictionary.page.mergeSelected', { count: selectedEntries.length })}
        </Button>
        <TextFilter
          value={search}
          placeholder={t('dictionary.page.searchPlaceholder')}
          onCommit={(value) => setSearch(value.length === 0 ? undefined : value)}
          onClear={() => setSearch(undefined)}
        />
      </FilterToolbar>

      {list.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('dictionary.page.loadFailed')}</AlertTitle>
          <AlertDescription>{dictionaryErrorMessage(list.error)}</AlertDescription>
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

      <Panel
        title={t('dictionary.page.title')}
        flush
        action={
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={allVisibleSelected}
              disabled={items.length === 0}
              onChange={() => {
                setSelected(allVisibleSelected ? new Set() : new Set(items.map((entry) => entry.id)));
              }}
            />
            {t('dictionary.page.selectAll')}
          </label>
        }
      >
        {list.isPending ? (
          <div className="space-y-2 px-6 pb-4">
            {['a', 'b', 'c', 'd'].map((key) => (
              <Skeleton key={key} className="h-9 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <TableShell
            columns={columns}
            data={items}
            rowKey={(entry) => entry.id}
            className="max-w-full overflow-x-auto"
            emptyText={search === undefined ? t('dictionary.page.emptyEntries') : t('dictionary.page.emptyFiltered')}
          />
        )}
        <p className="text-muted-foreground px-6 pt-3 pb-4 text-xs">{t('dictionary.page.retentionNote')}</p>
      </Panel>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && create.isPending) {
            return;
          }
          setCreateOpen(open);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('dictionary.entry.createTitle')}</DialogTitle>
            <DialogDescription>{t('dictionary.entry.createDescription')}</DialogDescription>
          </DialogHeader>
          <EntryFormFields
            draft={createDraft}
            chats={chatOptions}
            errors={createErrors}
            disabled={create.isPending}
            idPrefix="create-entry"
            onChange={setCreateDraft}
          />
          {create.isError ? (
            <p className="text-destructive text-sm break-words">{dictionaryErrorMessage(create.error)}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={create.isPending}
              onClick={() => {
                const errors = validateDraft(createDraft);
                setCreateErrors(errors);
                if (Object.keys(errors).length === 0) {
                  create.mutate(createDraft);
                }
              }}
            >
              {create.isPending ? t('common.saving') : t('dictionary.entry.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && update.isPending) {
            return;
          }
          if (!open) {
            setEditing(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('dictionary.entry.editTitle', { term: editing?.entry.term ?? '' })}</DialogTitle>
            <DialogDescription>{t('dictionary.entry.editDescription')}</DialogDescription>
          </DialogHeader>
          {editing !== null ? (
            <EntryFormFields
              draft={editing.draft}
              chats={chatOptions}
              errors={editErrors}
              disabled={update.isPending}
              idPrefix="edit-entry"
              onChange={(draft) => setEditing({ entry: editing.entry, draft })}
            />
          ) : null}
          {conflicted.has(editing?.entry.id ?? '') ? (
            <p className="text-warning-foreground text-sm">{t('dictionary.entry.conflictWarning')}</p>
          ) : null}
          {update.isError ? (
            <p className="text-destructive text-sm break-words">{dictionaryErrorMessage(update.error)}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={update.isPending} onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={update.isPending}
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
              {update.isPending ? t('common.saving') : t('dictionary.entry.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setDeleting(null);
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

      {importOpen ? (
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          chats={chatOptions}
          defaultScope={scope}
          defaultChatId={chatId}
          onImported={invalidate}
        />
      ) : null}

      {exportOpen ? (
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} scope={scope} chatId={chatId} />
      ) : null}

      {mergeOpen ? (
        <MergeDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          entries={selectedEntries}
          chats={chatOptions}
          defaultScope={scope}
          defaultChatId={chatId}
          onMerged={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}
