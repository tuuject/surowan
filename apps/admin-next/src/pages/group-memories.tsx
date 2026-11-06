import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Eye, Info, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ChatFilter,
  type ColumnSpec,
  ConfirmDialog,
  CursorList,
  FilterToolbar,
  TableShell,
  TextFilter,
} from '@/components/business';
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
import type { GroupMemoryEntry } from '@/lib/api/group-memories.ts';
import { deleteGroupMemory, groupMemorySource, updateGroupMemory } from '@/lib/api/group-memories.ts';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { groupMemoriesQuery } from '@/lib/queries';
import { useChatScope, useChatScopeSetter } from '@/lib/search-params';
import { toast } from '@/lib/toast.ts';

const SUMMARY_MAX_LENGTH = 150;

export default function GroupMemoriesPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chat = useChatScope();
  const navigate = useNavigate({ from: '/group-memories' });
  const setChat = useChatScopeSetter(navigate);
  const [day, setDay] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState<string | undefined>(undefined);
  const filters = useMemo(() => ({ chat, day, search }), [chat, day, search]);
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
      render: (row) => <span className="tabular-nums">{row.day}</span>,
    },
    {
      key: 'chat',
      title: t('pages.groupMemories.colChat'),
      render: (row) => (
        <div className="space-y-0.5">
          <p className="font-medium">{row.chat.title ?? row.chat.telegram_chat_id}</p>
          <p className="text-muted-foreground font-mono text-xs">{row.chat.telegram_chat_id}</p>
        </div>
      ),
    },
    {
      key: 'summary',
      title: t('pages.groupMemories.colSummary'),
      render: (row) => <p className="max-w-2xl text-sm break-words">{row.summary}</p>,
    },
    {
      key: 'range',
      title: t('pages.groupMemories.colRange'),
      render: (row) => (
        <span className="font-mono text-xs tabular-nums">
          {row.first_message_id}–{row.last_message_id}
        </span>
      ),
    },
    {
      key: 'created',
      title: t('pages.groupMemories.colCreated'),
      render: (row) => <span className="text-muted-foreground text-xs">{formatTime(row.created_at)}</span>,
    },
    {
      key: 'actions',
      title: t('pages.groupMemories.colActions'),
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('pages.groupMemories.viewSource')}
            title={t('pages.groupMemories.viewSource')}
            onClick={() => setSource(row)}
          >
            <Eye />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('common.edit')}
            onClick={() => {
              setSummary(row.summary);
              setEditing(row);
            }}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label={t('common.delete')}
            onClick={() => setDeleting(row)}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>{t('pages.groupMemories.alertTitle')}</AlertTitle>
        <AlertDescription>
          <Trans i18nKey="pages.groupMemories.alertDescription" components={{ code: <code /> }} />
        </AlertDescription>
      </Alert>

      <FilterToolbar>
        <ChatFilter value={chat} onChange={setChat} />
        <TextFilter
          value={search}
          placeholder={t('pages.groupMemories.searchPlaceholder')}
          onCommit={(value) => setSearch(value.length === 0 ? undefined : value)}
          onClear={() => setSearch(undefined)}
        />
        <Input
          type="date"
          aria-label={t('pages.groupMemories.dayFilter')}
          className="h-8 w-40"
          value={day ?? ''}
          onChange={(event) => setDay(event.target.value.length === 0 ? undefined : event.target.value)}
        />
      </FilterToolbar>

      <CursorList
        factory={groupMemoriesQuery}
        filters={filters}
        empty={<div className="text-muted-foreground py-8 text-center text-sm">{t('pages.groupMemories.empty')}</div>}
        renderItems={(items) => (
          <TableShell columns={columns} data={items} rowKey={(row) => row.id} className="max-w-full overflow-x-auto" />
        )}
      />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !update.isPending) {
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages.groupMemories.editTitle')}</DialogTitle>
            <DialogDescription>{t('pages.groupMemories.editDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="group-memory-summary">{t('pages.groupMemories.summaryLabel')}</Label>
            <Input
              id="group-memory-summary"
              maxLength={SUMMARY_MAX_LENGTH}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {summary.length}/{SUMMARY_MAX_LENGTH}
            </p>
            {update.isError ? (
              <p role="alert" className="text-destructive text-sm break-words">
                {errorMessage(update.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={update.isPending} onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={update.isPending || summary.trim().length === 0}
              onClick={() => editing !== null && update.mutate(editing)}
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
      >
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('pages.groupMemories.sourceTitle')}</DialogTitle>
            <DialogDescription>
              {source === null
                ? ''
                : t('pages.groupMemories.sourceDescription', {
                    first: source.first_message_id,
                    last: source.last_message_id,
                  })}
            </DialogDescription>
          </DialogHeader>
          {sourceQuery.isPending ? (
            <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
          ) : sourceQuery.isError ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(sourceQuery.error)}
            </p>
          ) : (
            <pre className="max-h-[60dvh] overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap">
              {sourceQuery.data?.text ?? ''}
            </pre>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSource(null)}>
              {t('pages.groupMemories.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
