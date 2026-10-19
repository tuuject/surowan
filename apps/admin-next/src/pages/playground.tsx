import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { MessagesSquare, Plus, Send, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { StateBadge, ToneBadge } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ApiError,
  addPlaygroundParticipant,
  type PlaygroundInvocation,
  type PlaygroundReleaseDetail,
  type PlaygroundRoom,
  type PlaygroundTimelineItem,
  createPlaygroundRoom,
  holdPlaygroundRoom,
  playgroundAssetUrl,
  releasePlaygroundRoom,
  retryPlaygroundRelease,
  setPlaygroundCapabilities,
  submitPlaygroundMessage,
  uploadPlaygroundAsset,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import {
  playgroundInvocationsQuery,
  playgroundMessagesQuery,
  playgroundReleaseQuery,
  playgroundRoomQuery,
  playgroundRoomsQuery,
} from '@/lib/queries';

/**
 * One request key per payload. Sending the same payload again reuses its key,
 * so a lost response replays the original result; any other payload gets a
 * fresh key, so an edited retry is never refused as a conflict. Keys are
 * opaque: nothing a user typed becomes part of one.
 */
function usePayloadKey(scope: string): { keyFor: (payload: unknown) => string; settle: () => void } {
  const current = useRef<{ readonly signature: string; readonly key: string } | null>(null);
  return {
    keyFor: (payload: unknown): string => {
      const signature = JSON.stringify(payload);
      if (current.current?.signature !== signature) {
        current.current = { signature, key: `${scope}-${crypto.randomUUID()}` };
      }
      return current.current.key;
    },
    settle: (): void => {
      current.current = null;
    },
  };
}

/**
 * Whether a failed write may still have happened. A 4xx answer is the server
 * refusing before it wrote; a network failure or a 5xx leaves it unknown.
 */
function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function StatusPill({ label, value }: { readonly label: string; readonly value: string | number }): React.ReactElement {
  return (
    <span className="text-muted-foreground text-xs">
      {label}: <span className="text-foreground font-medium">{value}</span>
    </span>
  );
}

function TimelineRow({
  roomId,
  item,
  onReply,
}: {
  readonly roomId: string;
  readonly item: PlaygroundTimelineItem;
  readonly onReply: (seq: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const state = item.sent_by_bot ? item.send_state : item.input_state;
  const stateLabel = state === null ? null : (t(`playground.states.${state}`, { defaultValue: state }) as string);
  return (
    <li className="flex min-w-0 flex-col gap-1 border-b py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">#{item.seq}</span>
        <span className="text-sm font-medium">
          {item.sender?.name ?? (item.sent_by_bot ? t('playground.identities.bot') : '—')}
        </span>
        {stateLabel === null ? null : (
          <ToneBadge
            tone={
              state === 'success' || state === 'released'
                ? 'success'
                : state === 'error' || state === 'expired'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {stateLabel}
          </ToneBadge>
        )}
        <span className="text-muted-foreground ml-auto text-xs">{formatTime(item.created_at)}</span>
      </div>
      {item.reply_to_seq === null ? null : (
        <p className="text-muted-foreground text-xs">{t('playground.messages.replyTo', { seq: item.reply_to_seq })}</p>
      )}
      {item.text === null || item.text.length === 0 ? null : (
        <p className="text-sm break-words whitespace-pre-wrap">{item.text}</p>
      )}
      {item.caption === null || item.caption.length === 0 ? null : (
        <p className="text-sm break-words whitespace-pre-wrap">{item.caption}</p>
      )}
      {item.media.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {item.media.map((media) =>
            media.asset_id === null ? (
              <span key={media.media_id} className="text-muted-foreground text-xs">
                {t('playground.messages.unsupportedMedia', { kind: media.kind })}
              </span>
            ) : (
              <img
                key={media.media_id}
                src={playgroundAssetUrl(roomId, media.asset_id)}
                alt={media.kind}
                className="border-border h-24 w-24 rounded-md border object-cover"
              />
            ),
          )}
        </div>
      )}
      {item.sent_by_bot ? null : (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onReply(item.seq)}>
            {t('playground.messages.reply')}
          </Button>
        </div>
      )}
    </li>
  );
}

function AttemptRow({
  roomId,
  invocation,
  onRetried,
}: {
  readonly roomId: string;
  readonly invocation: PlaygroundInvocation;
  readonly onRetried: (releaseId: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const retry = useMutation({
    // A retry is addressed by the attempt's Release. The key names the attempt
    // being retried, so a click after a lost response replays that retry
    // instead of asking for a second one.
    mutationFn: (releaseId: string) =>
      retryPlaygroundRelease(roomId, releaseId, { attempt_key: `retry-of-${invocation.id}` }),
    onSuccess: (result, releaseId) => {
      toast.success(t('playground.runs.retried', { id: result.invocation_id }));
      onRetried(releaseId);
    },
    onError: (error) => toast.error(t('playground.runs.retryRefused', { reason: errorMessage(error) })),
  });
  const releaseId = invocation.release_id;
  const canRetry = releaseId !== null && (invocation.state === 'failed' || invocation.state === 'aborted');
  return (
    <li className="space-y-1 border-b py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{invocation.id}</span>
        <StateBadge state={invocation.state} />
        {invocation.retry_of_invocation_id === null ? null : (
          <span className="text-muted-foreground text-xs">
            {t('playground.runs.retryOf', { id: invocation.retry_of_invocation_id })}
          </span>
        )}
        <StatusPill label="tokens" value={formatNumber(invocation.total_tokens)} />
        <span className="text-muted-foreground ml-auto text-xs">{formatTime(invocation.finished_at)}</span>
      </div>
      <p className="text-muted-foreground text-xs">
        {invocation.completion_reason ?? invocation.state}
        {invocation.error_code === null ? '' : ` · ${invocation.error_code}`}
      </p>
      {canRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => retry.mutate(releaseId)}
          disabled={retry.isPending}
        >
          {retry.isPending ? t('playground.runs.retrying') : t('playground.runs.retry')}
        </Button>
      ) : null}
    </li>
  );
}

const route = getRouteApi('/playground');
/** The server's room picture limit; a larger file is refused before it is read. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

/** The message a send carries; exactly what its request key is bound to. */
interface MessagePayload {
  readonly sender_id: string;
  readonly text: string;
  readonly reply_to_seq: string | null;
  readonly asset_ids: readonly string[];
}

function RoomWorkspace({ roomId }: { readonly roomId: string }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery(playgroundRoomQuery(roomId));
  const messages = useInfiniteQuery(playgroundMessagesQuery(roomId));
  const runs = useQuery(playgroundInvocationsQuery(roomId));
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
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'release_conflict') {
        toast.error(t('playground.room.contributing'));
      } else {
        toast.error(errorMessage(error));
      }
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-messages', roomId] });
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

  const pages = messages.data?.pages ?? [];
  const items = useMemo(() => {
    const seen = new Set<string>();
    const ordered: PlaygroundTimelineItem[] = [];
    // Pages come newest-first; later pages are older, so a simple two-axis
    // dedup keeps the list stable while polling replaces the first page.
    for (const page of pages) {
      for (const item of page.items) {
        if (seen.has(item.message_id)) {
          continue;
        }
        seen.add(item.message_id);
        ordered.push(item);
      }
    }
    return ordered.sort((left, right) => Number(right.seq) - Number(left.seq));
  }, [pages]);
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
      <Card className="min-w-0">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{room?.title ?? t('common.loading')}</CardTitle>
            <span className="text-muted-foreground text-xs">{t('playground.room.revision', { revision })}</span>
            <ToneBadge tone={room?.hold === true ? 'warning' : 'neutral'}>
              {room?.hold === true ? t('playground.room.holdOn') : t('playground.room.holdOff')}
            </ToneBadge>
            <span className="text-muted-foreground text-xs">
              {pending === 0 ? t('playground.room.noPending') : t('playground.room.pending', { count: pending })}
            </span>
          </div>
          <CardDescription>{t('playground.room.releaseHint')}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => release.mutate({ revision, throughSeq: latestInputSeq, count: pending })}
              disabled={release.isPending}
              aria-label={
                pending === 0 ? t('playground.room.releaseEmpty') : t('playground.room.release', { count: pending })
              }
            >
              {pending === 0 ? t('playground.room.releaseEmpty') : t('playground.room.release', { count: pending })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => hold.mutate()}
              disabled={hold.isPending || room?.hold === true}
            >
              {t('playground.room.openHold')}
            </Button>
            {(room?.expired_inputs ?? 0) > 0 ? (
              <span className="text-muted-foreground text-xs">
                {t('playground.room.expiredInputs', { count: room?.expired_inputs ?? 0 })}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill
              label={t('playground.room.queued', { count: '' }).trim()}
              value={room?.queued_invocations ?? 0}
            />
            <StatusPill
              label={t('playground.room.running', { count: '' }).trim()}
              value={room?.running_invocations ?? 0}
            />
          </div>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Switch
                id="playground-image-switch"
                checked={room?.image_enabled === true}
                onCheckedChange={(checked) => capabilities.mutate(checked)}
                disabled={room === undefined || capabilities.isPending}
                aria-label={t('playground.capabilities.image')}
              />
              <div className="min-w-0">
                <Label htmlFor="playground-image-switch">{t('playground.capabilities.image')}</Label>
                <p className="text-muted-foreground text-xs">
                  {room?.image_enabled === true
                    ? t('playground.capabilities.imageOn')
                    : t('playground.capabilities.imageOff')}
                  {room?.image_enabled_by === null || room?.image_enabled_by === undefined
                    ? ''
                    : ` · ${t('playground.capabilities.imageEnabledBy', { actor: room.image_enabled_by })}`}
                </p>
              </div>
            </div>
            {(detail.data?.staged_assets.length ?? 0) > 0 ? (
              <span className="text-muted-foreground text-xs">
                {t('playground.capabilities.stagedAssets', { count: detail.data?.staged_assets.length ?? 0 })}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">{t('playground.capabilities.imageHint')}</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t('playground.identities.heading')}</CardTitle>
          <CardDescription>{t('playground.identities.addHint')}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <ul className="flex flex-wrap gap-2">
            {participants.map((member) => (
              <li key={member.id} className="flex items-center gap-2 rounded-md border px-2 py-1">
                <span className="text-sm">{member.name}</span>
                <span className="text-muted-foreground text-xs">{t(`playground.identities.${member.role}`)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="playground-participant-name">{t('playground.identities.name')}</Label>
              <Input
                id="playground-participant-name"
                value={participantName}
                onChange={(event) => setParticipantName(event.target.value)}
                className="w-48"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const payload = { name: participantName.trim() };
                addIdentity.mutate({ ...payload, request_key: participantKey.keyFor(payload) });
              }}
              disabled={participantName.trim().length === 0 || addIdentity.isPending}
            >
              {t('playground.identities.add')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t('playground.messages.heading')}</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('playground.messages.empty')}</p>
          ) : (
            <ul className="min-w-0">
              {items.map((item) => (
                <TimelineRow
                  key={item.message_id}
                  roomId={roomId}
                  item={item}
                  onReply={(seq) => {
                    if (!composerLocked) {
                      setReplySeq(seq);
                    }
                  }}
                />
              ))}
            </ul>
          )}
          {messages.hasNextPage === true ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void messages.fetchNextPage()}
              disabled={messages.isFetchingNextPage}
            >
              {t('playground.messages.loadOlder')}
            </Button>
          ) : null}
          <Separator />
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="playground-sender">{t('playground.identities.select')}</Label>
                <Select value={shown.sender_id} onValueChange={setSenderId} disabled={composerLocked}>
                  <SelectTrigger id="playground-sender" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {participants.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {shown.reply_to_seq === null ? null : (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {t('playground.messages.replyTo', { seq: shown.reply_to_seq })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setReplySeq(null)}
                    disabled={composerLocked}
                  >
                    {t('playground.messages.replyClear')}
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="playground-text">{t('playground.messages.composer')}</Label>
              <Textarea
                id="playground-text"
                value={shown.text}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t('playground.messages.composerPlaceholder')}
                readOnly={composerLocked}
                rows={3}
              />
            </div>
            {unresolved === null ? null : (
              <Alert>
                <AlertTitle>{t('playground.messages.unresolved')}</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {t('playground.messages.unresolvedHint')}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // The user takes the risk explicitly: the earlier send
                      // may be in the room, and the draft becomes a new message.
                      messageKey.settle();
                      setUnresolved(null);
                    }}
                  >
                    {t('playground.messages.unresolvedEdit')}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" asChild variant="outline" disabled={uploading || composerLocked}>
                <label htmlFor="playground-attachment" className="cursor-pointer">
                  <Upload className="size-4" />
                  {t('playground.messages.attach')}
                  <input
                    id="playground-attachment"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    disabled={uploading || composerLocked}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file === undefined) {
                        return;
                      }
                      if (attachments.length >= 4) {
                        toast.error(t('playground.errors.uploadLimit'));
                        return;
                      }
                      if (file.size > MAX_UPLOAD_BYTES) {
                        toast.error(t('playground.errors.uploadTooLarge'));
                        return;
                      }
                      setUploading(true);
                      upload.mutate(file, { onSettled: () => setUploading(false) });
                    }}
                  />
                </label>
              </Button>
              {shown.asset_ids.length === 0 ? null : (
                <span className="text-muted-foreground text-xs">
                  {t('playground.messages.attached', { count: shown.asset_ids.length })}
                </span>
              )}
              <Button
                type="button"
                className="ml-auto"
                onClick={() => submit.mutate(shown)}
                // An upload still in flight would land after the send cleared
                // the composer, so sending waits for it.
                disabled={submit.isPending || uploading || sendBlocked || shown.sender_id.length === 0}
              >
                <Send className="size-4" />
                {submit.isPending ? t('playground.messages.sending') : t('playground.messages.send')}
              </Button>
            </div>
            {effectiveSender.length === 0 ? (
              <Alert>
                <AlertTitle>{t('playground.errors.identityRequired')}</AlertTitle>
                <AlertDescription>{t('playground.identities.addHint')}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t('playground.runs.heading')}</CardTitle>
          <CardDescription>
            {status === undefined ? '' : t('playground.room.statusSummary', { revision, pending })}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          {runs.data?.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('playground.runs.empty')}</p>
          ) : null}
          <ul className="min-w-0">
            {(runs.data?.items ?? []).map((invocation) => (
              <AttemptRow
                key={invocation.id}
                roomId={roomId}
                invocation={invocation}
                onRetried={(releaseId) => {
                  void queryClient.invalidateQueries({ queryKey: ['playground-invocations', roomId] });
                  void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
                  void queryClient.invalidateQueries({ queryKey: ['playground-release', roomId, releaseId] });
                }}
              />
            ))}
          </ul>
          {(detail.data?.releases ?? []).length === 0 ? null : (
            <div className="flex flex-wrap gap-2">
              {(detail.data?.releases ?? []).map((entry) => (
                <Button
                  key={entry.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOpenRelease(entry.id);
                    // Re-opening the same Release asks for its current state.
                    void queryClient.invalidateQueries({ queryKey: ['playground-release', roomId, entry.id] });
                  }}
                >
                  {t('playground.runs.detail')} #{entry.id}
                </Button>
              ))}
            </div>
          )}
          {releaseDetail.data === undefined ? null : <ReleaseDetails detail={releaseDetail.data} />}
          {runs.data?.items.some((entry) => entry.state === 'completed' && entry.sends_used === 0) === true ? (
            <p className="text-muted-foreground text-xs">{t('playground.runs.noSend')}</p>
          ) : null}
        </CardContent>
      </Card>

      {detail.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('common.requestFailed')}</AlertTitle>
          <AlertDescription>{errorMessage(detail.error)}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function ReleaseDetails({ detail }: { readonly detail: PlaygroundReleaseDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="bg-muted/40 space-y-2 rounded-md p-3">
      <p className="text-xs">
        {t('playground.runs.detail')} #{detail.release.id} ·{' '}
        {t('playground.runs.throughSeq', { seq: detail.release.through_seq })}
        {detail.release.bucket_id === null ? '' : ` · ${t('playground.runs.bucket', { id: detail.release.bucket_id })}`}
      </p>
      <ul>
        {detail.attempts.map((attempt) => (
          <li key={attempt.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">{attempt.id}</span>
            <StateBadge state={attempt.state} />
            <span className="text-muted-foreground">
              {t('playground.runs.usage', { tokens: attempt.total_tokens, cost: attempt.total_cost ?? 0 })}
            </span>
            {attempt.receipt_state === null ? null : (
              <span className="text-muted-foreground">
                {t('playground.runs.receipt', { state: attempt.receipt_state })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {detail.sends.length === 0 ? null : (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t('playground.runs.sends')}</p>
          <ul>
            {detail.sends.map((send) => (
              <li key={send.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{send.kind}</span>
                <StateBadge state={send.state} />
                <span className="text-muted-foreground">{send.message_id === null ? '' : `#${send.message_id}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
