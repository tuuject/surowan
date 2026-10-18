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
  getPlaygroundRelease,
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
  playgroundRoomQuery,
  playgroundRoomsQuery,
} from '@/lib/queries';

/** A request key lives as long as its draft: the same action retries the same key. */
function useKeyFactory(): { key: (scope: string) => string; reset: (scope: string) => void } {
  const keys = useRef(new Map<string, string>());
  return {
    key: (scope: string): string => {
      const existing = keys.current.get(scope);
      if (existing !== undefined) {
        return existing;
      }
      const created = `${scope}-${crypto.randomUUID()}`;
      keys.current.set(scope, created);
      return created;
    },
    reset: (scope: string): void => {
      for (const key of [...keys.current.keys()]) {
        if (key.startsWith(scope)) {
          keys.current.delete(key);
        }
      }
    },
  };
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
  readonly onRetried: (invocationId: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const retry = useMutation({
    mutationFn: (releaseId: string) =>
      retryPlaygroundRelease(roomId, releaseId, { attempt_key: `retry-${crypto.randomUUID()}` }),
    onSuccess: (result) => {
      toast.success(t('playground.runs.retried', { id: result.invocation_id }));
      onRetried(result.invocation_id);
    },
  });
  const canRetry = invocation.state === 'failed' || invocation.state === 'aborted';
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
        <Button type="button" variant="outline" size="sm" onClick={() => retry.mutate(invocation.id)}>
          {t('playground.runs.retry')}
        </Button>
      ) : null}
    </li>
  );
}

const route = getRouteApi('/playground');

export default function PlaygroundPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = route.useNavigate();
  const { room: roomParam } = route.useSearch();
  const queryClient = useQueryClient();
  const rooms = useQuery(playgroundRoomsQuery);
  const roomId = roomParam ?? '';
  const detail = useQuery(playgroundRoomQuery(roomId));
  const messages = useInfiniteQuery(playgroundMessagesQuery(roomId));
  const runs = useQuery(playgroundInvocationsQuery(roomId));
  const keys = useKeyFactory();

  const [draft, setDraft] = useState('');
  const [senderId, setSenderId] = useState('');
  const [replySeq, setReplySeq] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMembers, setNewMembers] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [openRelease, setOpenRelease] = useState<string | null>(null);

  // Switching rooms clears the composer (the draft belongs to the previous
  // room), and every query is keyed by room id, so a late response for the old
  // room can never land in the new one.
  const selectRoom = useCallback(
    (next: string) => {
      setSenderId('');
      setDraft('');
      setReplySeq(null);
      setAttachments([]);
      setOpenRelease(null);
      void navigate({ search: { room: next } });
    },
    [navigate],
  );

  const room: PlaygroundRoom | undefined = detail.data?.room;
  const participants = detail.data?.participants ?? [];
  const effectiveSender = senderId.length > 0 ? senderId : (participants[0]?.id ?? '');

  useEffect(() => {
    if (participants.length > 0 && senderId.length === 0) {
      setSenderId(participants[0]?.id ?? '');
    }
  }, [participants, senderId]);

  const createRoom = useMutation({
    mutationFn: () =>
      createPlaygroundRoom({
        title: newTitle.trim().length === 0 ? t('playground.title') : newTitle.trim(),
        members: newMembers
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .map((name) => ({ name })),
        request_key: keys.key('room'),
      }),
    onSuccess: (result) => {
      toast.success(t('playground.rooms.created'));
      setCreateOpen(false);
      setNewTitle('');
      setNewMembers('');
      keys.reset('room');
      void queryClient.invalidateQueries({ queryKey: ['playground-rooms'] });
      selectRoom(result.room.id);
    },
  });

  const addIdentity = useMutation({
    mutationFn: () =>
      addPlaygroundParticipant(roomId, {
        name: participantName.trim(),
        request_key: keys.key(`participant-${participantName.trim()}`),
      }),
    onSuccess: (result) => {
      toast.success(t('playground.identities.added'));
      setParticipantName('');
      keys.reset('participant-');
      setSenderId(result.member.id);
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
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
    mutationFn: () =>
      submitPlaygroundMessage(roomId, {
        request_key: keys.key('message'),
        sender_id: effectiveSender,
        text: draft,
        reply_to_seq: replySeq,
        asset_ids: attachments,
      }),
    onSuccess: () => {
      toast.success(t('playground.messages.sent'));
      keys.reset('message');
      setDraft('');
      setReplySeq(null);
      setAttachments([]);
      void queryClient.invalidateQueries({ queryKey: ['playground-messages', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['playground-room', roomId] });
    },
    onError: (error) => toast.error(`${t('playground.messages.draftKept')}: ${errorMessage(error)}`),
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
        request_key: keys.key(`release-${input.revision}`),
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

  const releaseDetail = useQuery({
    queryKey: ['playground-release', roomId, openRelease ?? ''],
    queryFn: () => getPlaygroundRelease(roomId, openRelease as string),
    enabled: openRelease !== null && roomId.length > 0,
  });

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
  const roomFromDetail = detail.data?.room;
  const pending = roomFromDetail?.pending ?? status?.pending ?? 0;
  const revision = roomFromDetail?.revision ?? status?.revision ?? '0';
  const nextSeq = roomFromDetail?.next_seq ?? status?.next_seq ?? '0';

  const sendBlocked = draft.trim().length === 0 && attachments.length === 0;

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
                      {pending === 0
                        ? t('playground.room.noPending')
                        : t('playground.room.pending', { count: pending })}
                    </span>
                  </div>
                  <CardDescription>{t('playground.room.releaseHint')}</CardDescription>
                </CardHeader>
                <CardContent className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() =>
                        release.mutate({
                          revision,
                          throughSeq: (BigInt(nextSeq) - 1n).toString(),
                          count: pending,
                        })
                      }
                      disabled={release.isPending}
                      aria-label={
                        pending === 0
                          ? t('playground.room.releaseEmpty')
                          : t('playground.room.release', { count: pending })
                      }
                    >
                      {pending === 0
                        ? t('playground.room.releaseEmpty')
                        : t('playground.room.release', { count: pending })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => hold.mutate()}
                      disabled={hold.isPending || room?.hold === true}
                    >
                      {t('playground.room.openHold')}
                    </Button>
                    {(detail.data?.room.expired_inputs ?? 0) > 0 ? (
                      <span className="text-muted-foreground text-xs">
                        {t('playground.room.expiredInputs', { count: detail.data?.room.expired_inputs ?? 0 })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill
                      label={t('playground.room.queued', { count: '' }).trim()}
                      value={detail.data?.room.queued_invocations ?? 0}
                    />
                    <StatusPill
                      label={t('playground.room.running', { count: '' }).trim()}
                      value={detail.data?.room.running_invocations ?? 0}
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
                        <span className="text-muted-foreground text-xs">
                          {t(`playground.identities.${member.role}`)}
                        </span>
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
                      onClick={() => addIdentity.mutate()}
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
                        <TimelineRow key={item.message_id} roomId={roomId} item={item} onReply={setReplySeq} />
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
                        <Select value={effectiveSender} onValueChange={setSenderId}>
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
                      {replySeq === null ? null : (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {t('playground.messages.replyTo', { seq: replySeq })}
                          </span>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setReplySeq(null)}>
                            {t('playground.messages.replyClear')}
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="playground-text">{t('playground.messages.composer')}</Label>
                      <Textarea
                        id="playground-text"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t('playground.messages.composerPlaceholder')}
                        rows={3}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" asChild variant="outline" disabled={uploading}>
                        <label htmlFor="playground-attachment" className="cursor-pointer">
                          <Upload className="size-4" />
                          {t('playground.messages.attach')}
                          <input
                            id="playground-attachment"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
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
                              setUploading(true);
                              upload.mutate(file, { onSettled: () => setUploading(false) });
                            }}
                          />
                        </label>
                      </Button>
                      {attachments.length === 0 ? null : (
                        <span className="text-muted-foreground text-xs">
                          {t('playground.messages.attached', { count: attachments.length })}
                        </span>
                      )}
                      <Button
                        type="button"
                        className="ml-auto"
                        onClick={() => submit.mutate()}
                        disabled={submit.isPending || sendBlocked || effectiveSender.length === 0}
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
                        onRetried={() => {
                          void queryClient.invalidateQueries({ queryKey: ['playground-invocations', roomId] });
                        }}
                      />
                    ))}
                  </ul>
                  {(detail.data?.releases ?? []).length === 0 ? null : (
                    <div className="flex flex-wrap gap-2">
                      {(detail.data?.releases ?? []).map((release) => (
                        <Button
                          key={release.id}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setOpenRelease(release.id)}
                        >
                          {t('playground.runs.detail')} #{release.id}
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
            </>
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
              <Button type="button" onClick={() => createRoom.mutate()} disabled={createRoom.isPending}>
                {t('common.create')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {detail.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('common.requestFailed')}</AlertTitle>
          <AlertDescription>{errorMessage(detail.error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
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
