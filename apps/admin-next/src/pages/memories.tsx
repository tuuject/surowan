import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChatFilter, ConfirmDialog, CursorList, FilterToolbar, SelectFilter, TableShell } from '@/components/business';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  DAY_SECONDS,
  daysToTtlSeconds,
  editTtlSeconds,
  formatTtl,
  MEMORY_DETAIL_MAX_LENGTH,
  MEMORY_SUMMARY_MAX_LENGTH,
  TTL_MAX_DAYS,
  TTL_MIN_DAYS,
} from '@/lib/memory-ttl';
import { memoriesQuery, memoryChatsQuery } from '@/lib/queries';
import { useChatScope, useChatScopeSetter } from '@/lib/search-params';
import { createMemory, deleteMemory, updateMemory } from '@/lib/api/memories.ts';
import type { MemoryDraft, MemoryEntry, MemoryUpdate } from '@/lib/api/memories.ts';
import { memoryColumns } from './memories-columns.tsx';
import { MemoryDetail } from './memories-detail.tsx';
import { EMPTY_FORM, type MemoryFormErrors, type MemoryFormValues, validateMemoryForm } from './memories-form.ts';
import { MEMORY_STATES, MemoryStatus, STATE_LABEL_KEYS } from './memories-status.tsx';

export default function MemoriesPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<string | undefined>(undefined);
  const chat = useChatScope();
  const navigate = useNavigate({ from: '/memories' });
  const setChat = useChatScopeSetter(navigate);
  const filters = useMemo(() => ({ state, chat }), [state, chat]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createValues, setCreateValues] = useState<MemoryFormValues>(EMPTY_FORM);
  const [createErrors, setCreateErrors] = useState<MemoryFormErrors>({});
  const [viewing, setViewing] = useState<MemoryEntry | null>(null);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [editValues, setEditValues] = useState<MemoryFormValues>(EMPTY_FORM);
  const [editErrors, setEditErrors] = useState<MemoryFormErrors>({});
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);

  const chats = useQuery(memoryChatsQuery);

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
      setCreateOpen(false);
      setCreateValues(EMPTY_FORM);
      setCreateErrors({});
      toast.success(t('pages.memories.memoCreated'));
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open; the inline error shows why and the input is kept.
    },
  });

  const update = useMutation({
    mutationFn: ({ id, values }: { readonly id: string; readonly values: MemoryFormValues }) => {
      const body: MemoryUpdate = {
        summary: values.summary.trim(),
        detail: values.detail,
        ttl_seconds: editTtlSeconds(values.ttl_days.trim().length === 0 ? null : Number(values.ttl_days)),
      };
      return updateMemory(id, body);
    },
    onSuccess: () => {
      setEditing(null);
      setEditValues(EMPTY_FORM);
      setEditErrors({});
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
      setDeleting(null);
      toast.success(t('pages.memories.memoDeleted'));
      invalidateMemories();
    },
    onError: () => {
      // Dialog stays open with the inline error; the list still refreshes so a
      // stale row disappears if it was already gone.
      invalidateMemories();
    },
  });

  const columns = memoryColumns(t, {
    onView: setViewing,
    onEdit: (row) => {
      setEditValues({
        chat_id: '',
        summary: row.summary,
        detail: row.detail,
        ttl_days:
          row.ttl_seconds === null ? '' : String(Math.max(TTL_MIN_DAYS, Math.round(row.ttl_seconds / DAY_SECONDS))),
      });
      setEditErrors({});
      setEditing(row);
    },
    onDelete: setDeleting,
  });

  const chatOptions = (chats.data?.items ?? []).map((chatOption) => ({
    value: chatOption.telegram_chat_id,
    label: `${chatOption.title ?? chatOption.telegram_chat_id} (${chatOption.type}${chatOption.username === null ? '' : ` @${chatOption.username}`})`,
  }));

  const stateOptions = MEMORY_STATES.map((value) => ({ value, label: t(STATE_LABEL_KEYS[value]) }));

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>{t('pages.memories.alertTitle')}</AlertTitle>
        <AlertDescription>
          <Trans i18nKey="pages.memories.alertDescription" components={{ code: <code /> }} />
        </AlertDescription>
      </Alert>

      <FilterToolbar>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          {t('pages.memories.newMemo')}
        </Button>
        <ChatFilter value={chat} onChange={setChat} />
        <SelectFilter
          placeholder={t('pages.memories.filterState')}
          value={state}
          onChange={setState}
          options={stateOptions}
        />
      </FilterToolbar>

      <CursorList
        factory={memoriesQuery}
        filters={filters}
        empty={
          <div className="text-muted-foreground py-8 text-center text-sm">{t('pages.memories.emptyMemories')}</div>
        }
        renderItems={(items) => (
          <TableShell columns={columns} data={items} rowKey={(row) => row.id} className="max-w-full overflow-x-auto" />
        )}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pages.memories.createTitle')}</DialogTitle>
            <DialogDescription>{t('pages.memories.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="memory-chat">{t('pages.memories.chatLabel')}</Label>
              <Select
                {...(createValues.chat_id.length === 0 ? {} : { value: createValues.chat_id })}
                onValueChange={(value) => setCreateValues((previous) => ({ ...previous, chat_id: value }))}
              >
                <SelectTrigger id="memory-chat" className="w-full" aria-label={t('pages.memories.selectChat')}>
                  <SelectValue placeholder={t('pages.memories.selectChat')} />
                </SelectTrigger>
                <SelectContent>
                  {chatOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chats.isPending ? (
                <p className="text-muted-foreground text-xs">{t('pages.memories.loadingChatOptions')}</p>
              ) : null}
              {chats.isError ? (
                <p className="text-destructive text-xs break-words">{errorMessage(chats.error)}</p>
              ) : null}
              {createErrors.chat_id !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.chat_id}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-summary">{t('pages.memories.summaryLabel')}</Label>
              <Input
                id="memory-summary"
                maxLength={MEMORY_SUMMARY_MAX_LENGTH}
                value={createValues.summary}
                onChange={(event) => setCreateValues((previous) => ({ ...previous, summary: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">
                {createValues.summary.length}/{MEMORY_SUMMARY_MAX_LENGTH}
              </p>
              {createErrors.summary !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.summary}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-detail">{t('pages.memories.detailLabel')}</Label>
              <Textarea
                id="memory-detail"
                rows={6}
                maxLength={MEMORY_DETAIL_MAX_LENGTH}
                value={createValues.detail}
                onChange={(event) => setCreateValues((previous) => ({ ...previous, detail: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">{t('pages.memories.detailHint')}</p>
              {createErrors.detail !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.detail}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-ttl">{t('pages.memories.ttlLabel')}</Label>
              <Input
                id="memory-ttl"
                type="number"
                min={TTL_MIN_DAYS}
                max={TTL_MAX_DAYS}
                step={1}
                value={createValues.ttl_days}
                onChange={(event) => setCreateValues((previous) => ({ ...previous, ttl_days: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">{t('pages.memories.ttlHint')}</p>
              {createErrors.ttl_days !== undefined ? (
                <p className="text-destructive text-sm">{createErrors.ttl_days}</p>
              ) : null}
            </div>
            {create.isError ? (
              <p className="text-destructive text-sm break-words">{errorMessage(create.error)}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={create.isPending}
              onClick={() => {
                const errors = validateMemoryForm(createValues, false, t);
                setCreateErrors(errors);
                if (Object.keys(errors).length === 0) {
                  create.mutate(createValues);
                }
              }}
            >
              {create.isPending ? t('pages.memories.creating') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pages.memories.viewTitle')}</DialogTitle>
            <DialogDescription>{viewing?.id ?? ''}</DialogDescription>
          </DialogHeader>
          {viewing === null ? null : (
            <div className="space-y-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('pages.memories.colChat')}</dt>
                <dd className="break-words">
                  {viewing.chat.title ?? viewing.chat.telegram_chat_id} ({viewing.chat.telegram_chat_id})
                </dd>
                <dt className="text-muted-foreground">{t('pages.memories.colStatus')}</dt>
                <dd>
                  <MemoryStatus row={viewing} />
                </dd>
                <dt className="text-muted-foreground">{t('pages.memories.colCreated')}</dt>
                <dd>{formatTime(viewing.created_at)}</dd>
                <dt className="text-muted-foreground">{t('pages.memories.colExpires')}</dt>
                <dd>{viewing.expires_at === null ? t('pages.memories.permanent') : formatTime(viewing.expires_at)}</dd>
                <dt className="text-muted-foreground">{t('pages.memories.colTtl')}</dt>
                <dd>{viewing.ttl_seconds === null ? t('pages.memories.permanent') : formatTtl(viewing.ttl_seconds)}</dd>
              </dl>
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs uppercase">{t('pages.memories.summaryLabel')}</div>
                <p className="text-sm font-medium break-words">{viewing.summary}</p>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs uppercase">{t('pages.memories.detailLabel')}</div>
                <MemoryDetail detail={viewing.detail} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setViewing(null)}>
              {t('pages.memories.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pages.memories.editTitle', { id: editing?.id ?? '' })}</DialogTitle>
            <DialogDescription>{t('pages.memories.editDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-summary">{t('pages.memories.summaryLabel')}</Label>
              <Input
                id="edit-summary"
                maxLength={MEMORY_SUMMARY_MAX_LENGTH}
                value={editValues.summary}
                onChange={(event) => setEditValues((previous) => ({ ...previous, summary: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">
                {editValues.summary.length}/{MEMORY_SUMMARY_MAX_LENGTH}
              </p>
              {editErrors.summary !== undefined ? (
                <p className="text-destructive text-sm">{editErrors.summary}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-detail">{t('pages.memories.detailLabel')}</Label>
              <Textarea
                id="edit-detail"
                rows={6}
                maxLength={MEMORY_DETAIL_MAX_LENGTH}
                value={editValues.detail}
                onChange={(event) => setEditValues((previous) => ({ ...previous, detail: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">{t('pages.memories.detailHint')}</p>
              {editErrors.detail !== undefined ? <p className="text-destructive text-sm">{editErrors.detail}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-ttl">{t('pages.memories.ttlLabel')}</Label>
              <Input
                id="edit-ttl"
                type="number"
                min={TTL_MIN_DAYS}
                max={TTL_MAX_DAYS}
                step={1}
                value={editValues.ttl_days}
                onChange={(event) => setEditValues((previous) => ({ ...previous, ttl_days: event.target.value }))}
              />
              <p className="text-muted-foreground text-xs">{t('pages.memories.editTtlHint')}</p>
              {editErrors.ttl_days !== undefined ? (
                <p className="text-destructive text-sm">{editErrors.ttl_days}</p>
              ) : null}
            </div>
            {update.isError ? (
              <p className="text-destructive text-sm break-words">{errorMessage(update.error)}</p>
            ) : null}
          </div>
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
                const errors = validateMemoryForm(editValues, true, t);
                setEditErrors(errors);
                if (Object.keys(errors).length === 0) {
                  update.mutate({ id: editing.id, values: editValues });
                }
              }}
            >
              {update.isPending ? t('common.saving') : t('common.save')}
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
