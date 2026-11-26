import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, ListFooter, ListPageHeader, useClientPagination } from '@/components/business';
import { ChatCardList } from '@/components/chats/card-list';
import { ChatDialog } from '@/components/chats/chat-dialog';
import { ChatTable } from '@/components/chats/chat-table';
import { DecisionGateDialog } from '@/components/chats/decision-gate-dialog';
import { GroupMemoryDialog } from '@/components/chats/group-memory-dialog';
import { McpBindingDialog } from '@/components/chats/mcp-binding-dialog';
import { ParticipationDialog } from '@/components/chats/participation-dialog';
import { ProactiveReplyDialog } from '@/components/chats/proactive-reply-dialog';
import type { ChatRowHandlers } from '@/components/chats/row-parts';
import { ChatsToolbar } from '@/components/chats/toolbar';
import { RestartBanner } from '@/components/models/restart-banner';
import type { ChatEntry, ChatsView } from '@/lib/api/chats.ts';
import { deleteChat } from '@/lib/api/chats.ts';
import { restartServer } from '@/lib/api/config.ts';
import { errorMessage } from '@/lib/errors';
import { useListQuery } from '@/lib/list-query';
import { isConfigConflict } from '@/lib/model-manager';
import { chatsQuery, decisionGateQuery } from '@/lib/queries';
import { waitForAdminServer } from '@/lib/restart';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write';

const EMPTY_FILTERS = { search: '' };

/**
 * The table needs this much width for its five columns to read without
 * squeezing; below it, measured on the list's own box rather than the window,
 * the same Chats render as a stacked list.
 */
const tableShown = css({ display: 'none', '@container (min-width: 920px)': { display: 'block' } });
const listShown = css({ '@container (min-width: 920px)': { display: 'none' } });

export default function ChatsPage(): ReactElement {
  const { t } = useTranslation();
  const query = useQuery(chatsQuery);
  // The Chats view leaves out the global entry gate; without it a row names only its own overrides.
  const gate = useQuery(decisionGateQuery);
  const listQuery = useListQuery(EMPTY_FILTERS);
  const search = listQuery.value.search;
  const write = useProviderWrite();
  // Every editor stays mounted so its dialog can play the exit transition; `open`
  // is separate state, and the captured target survives the close until the next open
  // so the title and body stay put while the fade runs. `nonce` remounts the form.
  const [editing, setEditing] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry | null;
    readonly nonce: number;
  } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [scheduling, setScheduling] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry;
    readonly nonce: number;
  } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [proactive, setProactive] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry;
    readonly nonce: number;
  } | null>(null);
  const [proactiveOpen, setProactiveOpen] = useState(false);
  const [decisionGate, setDecisionGate] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry;
    readonly nonce: number;
  } | null>(null);
  const [decisionGateOpen, setDecisionGateOpen] = useState(false);
  const [groupMemory, setGroupMemory] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry;
    readonly nonce: number;
  } | null>(null);
  const [groupMemoryOpen, setGroupMemoryOpen] = useState(false);
  const [mcpBinding, setMcpBinding] = useState<{
    readonly view: ChatsView;
    readonly chat: ChatEntry;
    readonly nonce: number;
  } | null>(null);
  const [mcpBindingOpen, setMcpBindingOpen] = useState(false);
  const [removing, setRemoving] = useState<{ readonly chat: ChatEntry; readonly revision: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation({
    mutationFn: (target: { readonly chat: ChatEntry; readonly revision: string }) =>
      deleteChat(target.chat.id, target.revision),
    onSuccess: (result) => {
      // Only the visibility flips: the snapshot keeps feeding the title during the exit fade.
      setRemoveOpen(false);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        setRemoveOpen(false);
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
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
        <ListPageHeader title={t('pages.chats.allowlistTitle')} />
        <Skeleton className={css({ height: '256px', width: '100%', borderRadius: 'xl' })} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <ListPageHeader title={t('pages.chats.allowlistTitle')} />
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Alert>
      </div>
    );
  }
  const view = query.data;
  const handlers: ChatRowHandlers = {
    onEdit: (chat) => {
      setEditing((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setChatOpen(true);
    },
    onSchedule: (chat) => {
      setScheduling((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setScheduleOpen(true);
    },
    onProactive: (chat) => {
      setProactive((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setProactiveOpen(true);
    },
    onDecisionGate: (chat) => {
      setDecisionGate((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setDecisionGateOpen(true);
    },
    onGroupMemory: (chat) => {
      setGroupMemory((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setGroupMemoryOpen(true);
    },
    onMcp: (chat) => {
      setMcpBinding((previous) => ({ view, chat, nonce: (previous?.nonce ?? 0) + 1 }));
      setMcpBindingOpen(true);
    },
    onRemove: (chat) => {
      remove.reset();
      setRemoving({ chat, revision: view.revision });
      setRemoveOpen(true);
    },
  };
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('pages.chats.allowlistTitle')} />
      <RestartBanner
        paths={view.restart_required}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />
      <ChatsToolbar
        search={search}
        onSearch={(next) => listQuery.apply({ search: next })}
        onAdd={() => {
          setEditing((previous) => ({ view, chat: null, nonce: (previous?.nonce ?? 0) + 1 }));
          setChatOpen(true);
        }}
        onRefresh={() => {
          void query.refetch();
          void gate.refetch();
        }}
        refreshing={query.isRefetching}
      />
      <div className={css({ containerType: 'inline-size' })}>
        <div className={tableShown}>
          <ChatTable view={view} items={pagination.items} gate={gate.data} handlers={handlers} />
          <ListFooter
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          />
        </div>
        <div className={listShown}>
          <ChatCardList view={view} items={pagination.items} gate={gate.data} handlers={handlers} />
          <ListFooter
            inset={false}
            count={pagination.total}
            page={pagination.page}
            pageCount={pagination.pageCount}
            onPageChange={pagination.onPageChange}
          />
        </div>
      </div>
      <ChatDialog
        open={chatOpen}
        onOpenChange={setChatOpen}
        view={editing?.view ?? view}
        chat={editing?.chat ?? null}
        formKey={editing?.nonce ?? 0}
      />
      <ParticipationDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        view={scheduling?.view ?? view}
        chat={scheduling?.chat ?? null}
        formKey={scheduling?.nonce ?? 0}
      />
      <ProactiveReplyDialog
        open={proactiveOpen}
        onOpenChange={setProactiveOpen}
        view={proactive?.view ?? view}
        chat={proactive?.chat ?? null}
        formKey={proactive?.nonce ?? 0}
      />
      <DecisionGateDialog
        open={decisionGateOpen}
        onOpenChange={setDecisionGateOpen}
        view={decisionGate?.view ?? view}
        chat={decisionGate?.chat ?? null}
        formKey={decisionGate?.nonce ?? 0}
      />
      <GroupMemoryDialog
        open={groupMemoryOpen}
        onOpenChange={setGroupMemoryOpen}
        view={groupMemory?.view ?? view}
        chat={groupMemory?.chat ?? null}
        formKey={groupMemory?.nonce ?? 0}
      />
      <McpBindingDialog
        open={mcpBindingOpen}
        onOpenChange={setMcpBindingOpen}
        view={mcpBinding?.view ?? view}
        chat={mcpBinding?.chat ?? null}
        formKey={mcpBinding?.nonce ?? 0}
      />
      {/* `open` stays apart from the snapshot so the Chat id doesn't blank out while the exit fade plays. */}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoveOpen(false);
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
