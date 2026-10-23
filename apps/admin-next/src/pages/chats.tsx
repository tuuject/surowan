import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ChatDialog } from '@/components/chats/chat-dialog';
import { ChatTable } from '@/components/chats/chat-table';
import { ParticipationDialog } from '@/components/chats/participation-dialog';
import { ProactiveReplyDialog } from '@/components/chats/proactive-reply-dialog';
import { ConfirmDialog } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { RestartBanner } from '@/components/models/restart-banner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { errorMessage } from '@/lib/errors';
import { isConfigConflict } from '@/lib/model-manager';
import { chatsQuery } from '@/lib/queries';
import { waitForAdminServer } from '@/lib/restart';
import { useProviderWrite } from '@/lib/use-provider-write';
import { useTranslation } from 'react-i18next';
import { deleteChat } from '@/lib/api/chats.ts';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import { restartServer } from '@/lib/api/config.ts';

export default function ChatsPage(): React.ReactElement {
  const { t } = useTranslation();
  const query = useQuery(chatsQuery);
  const write = useProviderWrite();
  const [editing, setEditing] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry | null } | null>(null);
  const [scheduling, setScheduling] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry } | null>(null);
  const [proactive, setProactive] = useState<{ readonly view: ChatsView; readonly chat: ChatEntry } | null>(null);
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
  if (query.isPending) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }
  if (query.isError) {
    return (
      <div className="space-y-3">
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
    <div className="space-y-6">
      <RestartBanner
        paths={view.restart_required}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />
      <Panel
        title={t('pages.chats.allowlistTitle')}
        flush
        action={
          <Button size="sm" onClick={() => setEditing({ view, chat: null })}>
            <Plus />
            {t('pages.chats.addChat')}
          </Button>
        }
      >
        <ChatTable
          view={view}
          onEdit={(chat) => setEditing({ view, chat })}
          onSchedule={(chat) => setScheduling({ view, chat })}
          onProactive={(chat) => setProactive({ view, chat })}
          onRemove={(chat) => {
            remove.reset();
            setRemoving({ chat, revision: view.revision });
          }}
        />
      </Panel>
      {editing !== null ? (
        <ChatDialog view={editing.view} chat={editing.chat} onClose={() => setEditing(null)} />
      ) : null}
      {scheduling !== null ? (
        <ParticipationDialog view={scheduling.view} chat={scheduling.chat} onClose={() => setScheduling(null)} />
      ) : null}
      {proactive !== null ? (
        <ProactiveReplyDialog view={proactive.view} chat={proactive.chat} onClose={() => setProactive(null)} />
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
