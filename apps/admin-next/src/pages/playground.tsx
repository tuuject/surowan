import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, ListPageHeader, ListToolbar, useClientPagination } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { RoomWorkspace } from '@/components/playground/room-workspace.tsx';
import { outcomeUnknown, usePayloadKey } from '@/components/playground/shared.tsx';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createPlaygroundRoom } from '@/lib/api/playground.ts';

import { errorMessage } from '@/lib/errors';
import { playgroundRoomsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';

const route = getRouteApi('/playground');

export default function PlaygroundPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = route.useNavigate();
  const { room: roomParam } = route.useSearch();
  const queryClient = useQueryClient();
  const rooms = useQuery(playgroundRoomsQuery);
  const pagination = useClientPagination(rooms.data?.items ?? [], 'playground-rooms');
  const roomId = roomParam ?? '';
  const roomKey = usePayloadKey('room');

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMembers, setNewMembers] = useState('');

  const selectRoom = useCallback(
    (next: string) => {
      void navigate({ search: { room: next } });
    },
    [navigate],
  );

  const createRoom = useMutation({
    mutationFn: (body: Parameters<typeof createPlaygroundRoom>[0]) => createPlaygroundRoom(body),
    onSuccess: (result) => {
      toast.success(t('playground.rooms.created'));
      setCreateOpen(false);
      setNewTitle('');
      setNewMembers('');
      roomKey.settle();
      void queryClient.invalidateQueries({ queryKey: ['playground-rooms'] });
      selectRoom(result.room.id);
    },
    onError: (error) => {
      // A refusal frees the key; an unknown outcome keeps it, so sending the
      // same form again answers with the room it may have created.
      if (!outcomeUnknown(error)) {
        roomKey.settle();
      }
      toast.error(t('playground.errors.failed', { message: errorMessage(error) }));
    },
  });

  const submitCreate = (): void => {
    const payload = {
      title: newTitle.trim().length === 0 ? t('playground.title') : newTitle.trim(),
      members: newMembers
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .map((name) => ({ name })),
    };
    createRoom.mutate({ ...payload, request_key: roomKey.keyFor(payload) });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ListPageHeader title={t('playground.title')} description={t('playground.intro')} />
      <ListToolbar onRefresh={() => void rooms.refetch()} refreshing={rooms.isRefetching}>
        <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t('playground.rooms.create')}
        </Button>
      </ListToolbar>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Panel
          title={t('playground.rooms.heading')}
          description={t('playground.rooms.select')}
          action={<span className="text-muted-foreground text-xs tabular-nums">{pagination.total}</span>}
          className="min-w-0"
        >
          <div className="min-w-0 space-y-2">
            {rooms.isPending ? <p className="text-muted-foreground text-sm">{t('common.loading')}</p> : null}
            {rooms.isError ? <p className="text-destructive text-sm">{t('playground.rooms.loadFailed')}</p> : null}
            {rooms.data?.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('playground.rooms.empty')}</p>
            ) : null}
            <ul className="min-w-0 space-y-1">
              {pagination.items.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={entry.id === roomId ? 'secondary' : 'ghost'}
                    className="w-full justify-start"
                    onClick={() => selectRoom(entry.id)}
                    aria-current={entry.id === roomId ? 'true' : undefined}
                  >
                    <span className="truncate">{entry.title}</span>
                    <span className="text-muted-foreground ml-auto text-xs">
                      {t('playground.room.pending', { count: entry.held_count ?? 0 })}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            <ListFooter
              count={pagination.total}
              page={pagination.page}
              pageCount={pagination.pageCount}
              onPageChange={pagination.onPageChange}
            />
          </div>
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          {roomId.length === 0 ? (
            <div className="border-t py-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessagesSquare />
                  </EmptyMedia>
                  <EmptyTitle>{t('playground.rooms.empty')}</EmptyTitle>
                  <EmptyDescription>{t('playground.rooms.createHint')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            // Keyed by room: every draft, selection, pending upload and key
            // belongs to one room, however the URL changed (a click, Back or
            // Forward). A late callback of the previous room updates an
            // unmounted workspace and never reaches this one.
            <RoomWorkspace key={roomId} roomId={roomId} />
          )}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => !open && !createRoom.isPending && setCreateOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('playground.rooms.create')}</DialogTitle>
            <DialogDescription>{t('playground.rooms.createHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="playground-room-title">{t('playground.rooms.createTitle')}</Label>
              <Input
                id="playground-room-title"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="playground-room-members">{t('playground.rooms.createMembers')}</Label>
              <Input
                id="playground-room-members"
                value={newMembers}
                onChange={(event) => setNewMembers(event.target.value)}
                placeholder="Ada, Bo"
              />
            </div>
          </div>
          {createRoom.isError ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {t('playground.errors.failed', { message: errorMessage(createRoom.error) })}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={createRoom.isPending}
              onClick={() => setCreateOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={submitCreate} disabled={createRoom.isPending}>
              {createRoom.isPending ? t('common.submitting') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
