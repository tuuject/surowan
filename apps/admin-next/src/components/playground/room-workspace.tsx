import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CLIENT_PAGE_SIZE, useCursorPages, useOffsetPagination } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApiError } from '@/lib/api/core.ts';
import type { PlaygroundRoom } from '@/lib/api/playground.ts';
import {
  addPlaygroundParticipant,
  holdPlaygroundRoom,
  releasePlaygroundRoom,
  setPlaygroundCapabilities,
  submitPlaygroundMessage,
  uploadPlaygroundAsset,
} from '@/lib/api/playground.ts';
import { errorMessage } from '@/lib/errors';
import {
  playgroundInvocationsQuery,
  playgroundMessagesQuery,
  playgroundReleaseQuery,
  playgroundRoomQuery,
} from '@/lib/queries';
import { toast } from '@/lib/toast.ts';
import { ComposerCard } from './composer-card.tsx';
import { IdentitiesCard, RoomHeaderCard } from './room-cards.tsx';
import { RunsCard } from './runs-card.tsx';
import { type MessagePayload, outcomeUnknown, usePayloadKey } from './shared.tsx';

export function RoomWorkspace({ roomId }: { readonly roomId: string }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery(playgroundRoomQuery(roomId));
  const messagePages = useCursorPages(playgroundMessagesQuery(roomId));
  const runPagination = useOffsetPagination(roomId, CLIENT_PAGE_SIZE);
  const runs = useQuery(playgroundInvocationsQuery(roomId, runPagination.pageSize, runPagination.offset));
  const runPageCount = runPagination.pageCount(runs.data?.total);
  const messageKey = usePayloadKey('message');
  const participantKey = usePayloadKey('participant');

  const [draft, setDraft] = useState('');
  const [senderId, setSenderId] = useState('');
  const [replySeq, setReplySeq] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [participantName, setParticipantName] = useState('');
  const [openRelease, setOpenRelease] = useState<string | null>(null);
  // A send whose outcome is unknown (the response was lost). The draft stays
  // locked to it until the same payload is sent again, which replays it, or
  // the user explicitly turns it into a new message.
  const [unresolved, setUnresolved] = useState<MessagePayload | null>(null);

  const room: PlaygroundRoom | undefined = detail.data?.room;
  const participants = detail.data?.participants ?? [];
  const effectiveSender = senderId.length > 0 ? senderId : (participants[0]?.id ?? '');

  useEffect(() => {
    if (participants.length > 0 && senderId.length === 0) {
      setSenderId(participants[0]?.id ?? '');
    }
  }, [participants, senderId]);

  useEffect(() => {
    if (runs.data !== undefined && runPagination.page > runPageCount) {
      runPagination.onPageChange(runPageCount);
    }
  }, [runPageCount, runPagination, runs.data]);

  const addIdentity = useMutation({
    mutationFn: (body: Parameters<typeof addPlaygroundParticipant>[1]) => addPlaygroundParticipant(roomId, body),
    onSuccess: (result) => {
      toast.success(t('playground.identities.added'));
      setParticipantName('');
      participantKey.settle();
      setSenderId(result.member.id);
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
    },
    onError: (error) => {
      if (!outcomeUnknown(error)) {
        participantKey.settle();
      }
      toast.error(t('playground.errors.failed', { message: errorMessage(error) }));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      let binary = '';
      for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
      }
      return await uploadPlaygroundAsset(roomId, {
        content_base64: btoa(binary),
        mime: file.type.length === 0 ? 'image/png' : file.type,
        name: file.name,
      });
    },
    onSuccess: (asset) => {
      setAttachments((current) => [...current, asset.asset_id]);
      toast.success(t('playground.messages.attached', { count: 1 }));
    },
    onError: (error) => toast.error(`${t('playground.messages.uploadFailed')}: ${errorMessage(error)}`),
  });

  const submit = useMutation({
    mutationFn: (payload: MessagePayload) =>
      submitPlaygroundMessage(roomId, { ...payload, request_key: messageKey.keyFor(payload) }),
    onSuccess: () => {
      toast.success(t('playground.messages.sent'));
      messageKey.settle();
      setUnresolved(null);
      // The composer is locked while a send is in flight, so what is cleared
      // here is exactly what was sent.
      setDraft('');
      setReplySeq(null);
      setAttachments([]);
      void queryClient.invalidateQueries({ queryKey: ['playground-messages', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
      // The room list shows each room's pending count.
      void queryClient.invalidateQueries({ queryKey: ['playground-rooms'] });
    },
    onError: (error, payload) => {
      if (outcomeUnknown(error)) {
        setUnresolved(payload);
      } else {
        // The server refused before writing: the key is free and the draft
        // stays editable for the user to correct.
        messageKey.settle();
        setUnresolved(null);
      }
      toast.error(`${t('playground.messages.draftKept')}: ${errorMessage(error)}`);
    },
  });

  const hold = useMutation({
    mutationFn: () => holdPlaygroundRoom(roomId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const release = useMutation({
    mutationFn: (input: { readonly revision: string; readonly throughSeq: string; readonly count: number }) =>
      releasePlaygroundRoom(roomId, {
        // One Release per room revision, so the revision is the payload.
        request_key: `release-${input.revision}`,
        revision: input.revision,
        through_seq: input.throughSeq,
      }),
    onSuccess: (result, variables) => {
      toast.success(
        result.invocation_id === null
          ? t('playground.room.releasedEmpty')
          : t('playground.room.released', { count: variables.count }),
      );
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-messages', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-invocations', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-rooms'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'release_conflict') {
        toast.error(t('playground.room.contributing'));
      } else {
        toast.error(errorMessage(error));
      }
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-messages', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-rooms'] });
    },
  });

  const capabilities = useMutation({
    mutationFn: (enabled: boolean) =>
      setPlaygroundCapabilities(roomId, { image_enabled: enabled, revision: room?.revision ?? '0' }),
    onSuccess: (_result, enabled) => {
      toast.success(t('playground.capabilities.toggled', { state: enabled ? t('common.on') : t('common.off') }));
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
    },
  });

  const releaseDetail = useQuery(playgroundReleaseQuery(roomId, openRelease ?? ''));

  const { pages, items: currentItems, page, pageCount, onPageChange } = messagePages;
  const items = useMemo(() => {
    // Only the current cursor page is visible. It arrives newest-first and is
    // sorted locally without ever concatenating older pages into the view.
    return [...currentItems].sort((left, right) => Number(right.seq) - Number(left.seq));
  }, [currentItems]);
  const status = pages[0]?.status;
  const pending = room?.pending ?? status?.pending ?? 0;
  const revision = room?.revision ?? status?.revision ?? '0';
  const latestInputSeq = room?.latest_input_seq ?? status?.latest_input_seq ?? '0';

  const composerLocked = submit.isPending || unresolved !== null;
  const shown: MessagePayload = unresolved ?? {
    sender_id: effectiveSender,
    text: draft,
    reply_to_seq: replySeq,
    asset_ids: attachments,
  };
  const sendBlocked = shown.text.trim().length === 0 && shown.asset_ids.length === 0;

  return (
    <>
      <RoomHeaderCard
        room={room}
        revision={revision}
        latestInputSeq={latestInputSeq}
        pending={pending}
        detail={detail}
        release={release}
        hold={{ isPending: hold.isPending, mutate: () => hold.mutate() }}
        capabilities={capabilities}
      />
      <IdentitiesCard
        participants={participants}
        participantName={participantName}
        setParticipantName={setParticipantName}
        participantKey={participantKey}
        addIdentity={{
          isPending: addIdentity.isPending,
          mutate: (body) => addIdentity.mutate(body),
        }}
      />
      <ComposerCard
        roomId={roomId}
        items={items}
        participants={participants}
        shown={shown}
        unresolved={unresolved}
        composerLocked={composerLocked}
        sendBlocked={sendBlocked}
        effectiveSender={effectiveSender}
        uploading={uploading}
        attachments={attachments}
        messages={{
          page,
          pageCount,
          isFetchingNextPage: messagePages.query.isFetchingNextPage,
          onPageChange,
        }}
        submit={submit}
        upload={{
          mutate: (file, options) => upload.mutate(file, options),
        }}
        messageKey={messageKey}
        setUploading={setUploading}
        setDraft={setDraft}
        setSenderId={setSenderId}
        setReplySeq={setReplySeq}
        setUnresolved={setUnresolved}
      />
      <RunsCard
        roomId={roomId}
        status={status}
        revision={revision}
        pending={pending}
        runs={runs}
        pagination={runPagination}
        detail={detail}
        releaseDetail={releaseDetail}
        queryClient={queryClient}
        setOpenRelease={setOpenRelease}
      />
      {detail.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('common.requestFailed')}</AlertTitle>
          <AlertDescription>{errorMessage(detail.error)}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
