import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { ChatIcon } from '@/components/icons';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, ListPageHeader, ListToolbar, useClientPagination } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { RoomWorkspace } from '@/components/playground/room-workspace.tsx';
import { outcomeUnknown, usePayloadKey } from '@/components/playground/shared.tsx';
import { Button } from '@tuuject/koi-react/button';
import { Dialog } from '@tuuject/koi-react/dialog';
import { Empty } from '@tuuject/koi-react/empty';
import { Input } from '@tuuject/koi-react/input';
import { Field } from '@tuuject/koi-react/field';
import { createPlaygroundRoom } from '@/lib/api/playground.ts';

import { errorMessage } from '@/lib/errors';
import { playgroundRoomsQuery } from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

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
    <div className={css({ display: 'flex', minWidth: '0', flexDirection: 'column', gap: '5' })}>
      <ListPageHeader title={t('playground.title')} description={t('playground.intro')} />
      <ListToolbar onRefresh={() => void rooms.refetch()} refreshing={rooms.isRefetching}>
        <Button
          type="button"
          variant="outline"
          color="secondary"
          onClick={() => setCreateOpen(true)}
          iconStart={<PlusIcon className={css({ width: 'icon', height: 'icon' })} />}
        >
          {t('playground.rooms.create')}
        </Button>
      </ListToolbar>

      <div
        className={css({
          display: 'grid',
          minWidth: '0',
          gap: '4',
          '@media (min-width: 1024px)': { gridTemplateColumns: '320px minmax(0,1fr)' },
        })}
      >
        <Panel
          title={t('playground.rooms.heading')}
          description={t('playground.rooms.select')}
          action={
            <span className={css({ textStyle: 'small', color: 'text-muted', fontVariantNumeric: 'tabular-nums' })}>
              {pagination.total}
            </span>
          }
          className={css({ minWidth: '0' })}
        >
          <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
            {rooms.isPending ? (
              <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('common.loading')}</p>
            ) : null}
            {rooms.isError ? (
              <p className={css({ textStyle: 'body', color: 'error-text' })}>{t('playground.rooms.loadFailed')}</p>
            ) : null}
            {rooms.data?.items.length === 0 ? (
              <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('playground.rooms.empty')}</p>
            ) : null}
            <ul className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
              {pagination.items.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={entry.id === roomId ? 'soft' : 'ghost'}
                    color="secondary"
                    className={css({ width: '100%', justifyContent: 'flex-start' })}
                    onClick={() => selectRoom(entry.id)}
                    aria-current={entry.id === roomId ? 'true' : undefined}
                  >
                    <span className={css({ truncate: true })}>{entry.title}</span>
                    <span className={css({ textStyle: 'small', color: 'text-muted', marginInlineStart: 'auto' })}>
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

        <div className={css({ display: 'flex', minWidth: '0', flexDirection: 'column', gap: '4' })}>
          {roomId.length === 0 ? (
            <div className={css({ borderTopWidth: '1px', borderColor: 'divider', paddingBlock: '6' })}>
              <Empty
                icon={<ChatIcon />}
                title={t('playground.rooms.empty')}
                description={t('playground.rooms.createHint')}
              />
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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => !open && !createRoom.isPending && setCreateOpen(false)}
        title={t('playground.rooms.create')}
        description={t('playground.rooms.createHint')}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              color="secondary"
              disabled={createRoom.isPending}
              onClick={() => setCreateOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={submitCreate} disabled={createRoom.isPending}>
              {createRoom.isPending ? t('common.submitting') : t('common.create')}
            </Button>
          </>
        }
      >
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
          <Field label={t('playground.rooms.createTitle')}>
            <Input id="playground-room-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} />
          </Field>
          <Field label={t('playground.rooms.createMembers')}>
            <Input value={newMembers} onChange={(event) => setNewMembers(event.target.value)} placeholder="Ada, Bo" />
          </Field>
        </div>
        {createRoom.isError ? (
          <p role="alert" className={css({ textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
            {t('playground.errors.failed', { message: errorMessage(createRoom.error) })}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
