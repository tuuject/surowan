import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfirmDialog,
  ListFooter,
  ListPageHeader,
  ListSearchForm,
  ListToolbar,
  QueryTextField,
  useClientPagination,
} from '@/components/business';
import { ChatDialog } from '@/components/chats/chat-dialog';
import { ChatTable } from '@/components/chats/chat-table';
import { GroupMemoryDialog } from '@/components/chats/group-memory-dialog';
import { ParticipationDialog } from '@/components/chats/participation-dialog';
import { ProactiveReplyDialog } from '@/components/chats/proactive-reply-dialog';
import { RestartBanner } from '@/components/models/restart-banner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import { deleteChat } from '@/lib/api/chats.ts';
import { restartServer } from '@/lib/api/config.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { isConfigConflict } from '@/lib/model-manager';
import { chatsQuery } from '@/lib/queries';
import { waitForAdminServer } from '@/lib/restart';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

const EMPTY_FILTERS = { search: '' };

export default function ChatsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery(chatsQuery);
  const listQuery = useListQuery(EMPTY_FILTERS);
  const search = listQuery.value.search;
  const write = useProviderWrite();
  const [editing, setEditing] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry | null } | null>(null);
  const [scheduling, setScheduling] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry } | null>(null);
  const [proactive, setProactive] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry } | null>(null);
  const [groupMemory, setGroupMemory] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry } | null>(null);
  const [removing, setRemoving] = useState<{ readonly chat: ChatEntry; readonly revision: string } | null>(null);
  const remove = useMutation({
    mutationFn: (target: { readonly chat: ChatEntry; readonly revision: string }) =>
      deleteChat(target.chat.id, target.revision),
    onSuccess: (result) => {
      setRemoving(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        setRemoving(null);
        toast.error('config.jsonc changed. Nothing was removed - review the refreshed Chat before trying again.');
      }
    },
  });
  const restart = useMutation({
    mutationFn: restartServer,
    onSuccess: async () => {
      toast.info(t('pages.chats.restarting'));
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success(t('pages.chats.serverBack'));
      } else {
        toast.error(t('pages.chats.restartTimeout'));
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const filteredChats = (query.data?.items ?? []).filter((chatEntry) => {
    if (search.length === 0) {
      return true;
    }
    const needle = search.toLowerCase();
    return chatEntry.id.includes(needle) || (chatEntry.title ?? '').toLowerCase().includes(needle);
  });
  const pagination = useClientPagination(filteredChats, listQuery.resetKey);
  if (query.isPending) {
    return (
      <div className="space-y-5">
        <ListPageHeader title={t('pages.chats.allowlistTitle')} />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-3">
        <ListPageHeader title={t('pages.chats.allowlistTitle')} />
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(query.error)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const view = query.data;
  return (
    <div className="space-y-5">
      <ListPageHeader title={t('pages.chats.allowlistTitle')} description={t('pages.chats.dialogDescription')} />
      <RestartBanner
        paths={view.restart_required}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />
      <ListSearchForm value={listQuery.value} emptyValue={EMPTY_FILTERS} onSearch={listQuery.apply}>
        {({ draft, change }) => (
          <QueryTextField
            label={t('pages.chats.colChat')}
            value={draft.search}
            onChange={(search) => change({ search })}
          />
        )}
      </ListSearchForm>
      <ListToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
        <Button onClick={() => setEditing({ view, chat: null })}>
          <Plus />
          {t('pages.chats.addChat')}
        </Button>
      </ListToolbar>
      <div>
        <ChatTable
          view={view}
          items={pagination.items}
          onEdit={(chat) => setEditing({ view, chat })}
          onSchedule={(chat) => setScheduling({ view, chat })}
          onProactive={(chat) => setProactive({ view, chat })}
          onGroupMemory={(chat) => setGroupMemory({ view, chat })}
          onRemove={(chat) => {
            remove.reset();
            setRemoving({ chat, revision: view.revision });
          }}
        />
        <ListFooter
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
      </div>
      {editing !== null ? (
        <ChatDialog view={editing.view} chat={editing.chat} onClose={() => setEditing(null)} />
      ) : null}
      {scheduling !== null ? (
        <ParticipationDialog view={scheduling.view} chat={scheduling.chat} onClose={() => setScheduling(null)} />
      ) : null}
      {proactive !== null ? (
        <ProactiveReplyDialog view={proactive.view} chat={proactive.chat} onClose={() => setProactive(null)} />
      ) : null}
      {groupMemory !== null ? (
        <GroupMemoryDialog view={groupMemory.view} chat={groupMemory.chat} onClose={() => setGroupMemory(null)} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
          }
        }}
        title={t('pages.chats.removeTitle', { id: removing?.chat.id ?? '' })}
        description={t('pages.chats.removeDescription')}
        confirmText={t('pages.chats.removeConfirm')}
        destructive
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      />
    </div>
  );
}
