import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { MessagesSquare, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { RoomWorkspace } from '@/components/playground/room-workspace.tsx';
import { outcomeUnknown, usePayloadKey } from '@/components/playground/shared.tsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { errorMessage } from '@/lib/errors';
import { playgroundRoomsQuery } from '@/lib/queries';
import { createPlaygroundRoom } from '@/lib/api/playground.ts';

const route = getRouteApi('/playground');

export default function PlaygroundPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = route.useNavigate();
  const { room: roomParam } = route.useSearch();
  const queryClient = useQueryClient();
  const rooms = useQuery(playgroundRoomsQuery);
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
    <div className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-lg font-semibold">{t('playground.title')}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t('playground.intro')}</p>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <div>
              <CardTitle>{t('playground.rooms.heading')}</CardTitle>
              <CardDescription>{t('playground.rooms.select')}</CardDescription>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('playground.rooms.create')}
            </Button>
          </CardHeader>
          <CardContent className="min-w-0 space-y-2">
            {rooms.isPending ? <p className="text-muted-foreground text-sm">{t('common.loading')}</p> : null}
            {rooms.isError ? <p className="text-destructive text-sm">{t('playground.rooms.loadFailed')}</p> : null}
            {rooms.data?.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('playground.rooms.empty')}</p>
            ) : null}
            <ul className="min-w-0 space-y-1">
              {(rooms.data?.items ?? []).map((entry) => (
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
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {roomId.length === 0 ? (
            <Card>
              <CardContent>
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessagesSquare />
                    </EmptyMedia>
                    <EmptyTitle>{t('playground.rooms.empty')}</EmptyTitle>
                    <EmptyDescription>{t('playground.rooms.createHint')}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          ) : (
            // Keyed by room: every draft, selection, pending upload and key
            // belongs to one room, however the URL changed (a click, Back or
            // Forward). A late callback of the previous room updates an
            // unmounted workspace and never reaches this one.
            <RoomWorkspace key={roomId} roomId={roomId} />
          )}
        </div>
      </div>

      {createOpen ? (
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('playground.rooms.create')}</CardTitle>
            <CardDescription>{t('playground.rooms.createHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
            <div className="flex gap-2">
              <Button type="button" onClick={submitCreate} disabled={createRoom.isPending}>
                {t('common.create')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
