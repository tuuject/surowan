import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

import { StatusPill } from './shared.tsx';
import type { PlaygroundParticipant, PlaygroundRoom, PlaygroundRoomDetail } from '@/lib/api/playground.ts';

interface RoomReleaseControl {
  readonly isPending: boolean;
  readonly mutate: (input: { readonly revision: string; readonly throughSeq: string; readonly count: number }) => void;
}

interface RoomHeaderCardProps {
  readonly room: PlaygroundRoom | undefined;
  readonly revision: string;
  readonly latestInputSeq: string;
  readonly pending: number;
  readonly detail: { readonly data: PlaygroundRoomDetail | undefined };
  readonly release: RoomReleaseControl;
  readonly hold: { readonly isPending: boolean; readonly mutate: () => void };
  readonly capabilities: { readonly isPending: boolean; readonly mutate: (checked: boolean) => void };
}

interface IdentitiesCardProps {
  readonly participants: readonly PlaygroundParticipant[];
  readonly participantName: string;
  readonly setParticipantName: (name: string) => void;
  readonly participantKey: { readonly keyFor: (payload: unknown) => string };
  readonly addIdentity: {
    readonly isPending: boolean;
    readonly mutate: (body: { readonly name: string; readonly request_key: string }) => void;
  };
}

export function RoomHeaderCard({
  room,
  revision,
  latestInputSeq,
  pending,
  detail,
  release,
  hold,
  capabilities,
}: RoomHeaderCardProps): React.ReactElement {
  const { t } = useTranslation();
  return (
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
          <StatusPill label={t('playground.room.queued', { count: '' }).trim()} value={room?.queued_invocations ?? 0} />
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
  );
}

export function IdentitiesCard({
  participants,
  participantName,
  setParticipantName,
  participantKey,
  addIdentity,
}: IdentitiesCardProps): React.ReactElement {
  const { t } = useTranslation();
  return (
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
  );
}
