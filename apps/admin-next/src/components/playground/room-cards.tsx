import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, ToneBadge, useClientPagination } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@tuuject/koi-react/button';
import { Input } from '@tuuject/koi-react/input';
import { Label } from '@/components/ui/label';
import { Field } from '@tuuject/koi-react/field';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@tuuject/koi-react/switch';
import type { PlaygroundParticipant, PlaygroundRoom, PlaygroundRoomDetail } from '@/lib/api/playground.ts';
import { StatusPill } from './shared.tsx';
import { css } from '@tuuject/koi-react/styled-system/css';

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
    <Panel
      title={room?.title ?? t('common.loading')}
      description={t('playground.room.releaseHint')}
      className={css({ minWidth: '0' })}
    >
      <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('playground.room.revision', { revision })}
          </span>
          <ToneBadge tone={room?.hold === true ? 'warning' : 'neutral'}>
            {room?.hold === true ? t('playground.room.holdOn') : t('playground.room.holdOff')}
          </ToneBadge>
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>
            {pending === 0 ? t('playground.room.noPending') : t('playground.room.pending', { count: pending })}
          </span>
        </div>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
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
            color="secondary"
            onClick={() => hold.mutate()}
            disabled={hold.isPending || room?.hold === true}
          >
            {t('playground.room.openHold')}
          </Button>
          {(room?.expired_inputs ?? 0) > 0 ? (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('playground.room.expiredInputs', { count: room?.expired_inputs ?? 0 })}
            </span>
          ) : null}
        </div>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
          <StatusPill label={t('playground.room.queued', { count: '' }).trim()} value={room?.queued_invocations ?? 0} />
          <StatusPill
            label={t('playground.room.running', { count: '' }).trim()}
            value={room?.running_invocations ?? 0}
          />
        </div>
        <Separator />
        <div
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '3',
          })}
        >
          <div className={css({ display: 'flex', alignItems: 'center', gap: '3' })}>
            <Switch
              id="playground-image-switch"
              checked={room?.image_enabled === true}
              onCheckedChange={(checked) => capabilities.mutate(checked)}
              disabled={room === undefined || capabilities.isPending}
              aria-label={t('playground.capabilities.image')}
            />
            <div className={css({ minWidth: '0' })}>
              <Label htmlFor="playground-image-switch">{t('playground.capabilities.image')}</Label>
              <p className={css({ textStyle: 'small', color: 'text-muted' })}>
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
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('playground.capabilities.stagedAssets', { count: detail.data?.staged_assets.length ?? 0 })}
            </span>
          ) : (
            <span className={css({ textStyle: 'small', color: 'text-muted' })}>
              {t('playground.capabilities.imageHint')}
            </span>
          )}
        </div>
      </div>
    </Panel>
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
  const pagination = useClientPagination(participants, 'playground-identities');
  return (
    <Panel
      title={t('playground.identities.heading')}
      description={t('playground.identities.addHint')}
      className={css({ minWidth: '0' })}
    >
      <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        <ul className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
          {pagination.items.map((member) => (
            <li
              key={member.id}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '2',
                borderRadius: 'lg',
                borderWidth: '1px',
                borderColor: 'border',
                paddingInline: '2',
                paddingBlock: '1',
              })}
            >
              <span className={css({ textStyle: 'body' })}>{member.name}</span>
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t(`playground.identities.${member.role}`)}
              </span>
            </li>
          ))}
        </ul>
        <ListFooter
          count={pagination.total}
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
        />
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '2' })}>
          <Field label={t('playground.identities.name')}>
            <Input
              value={participantName}
              onChange={(event) => setParticipantName(event.target.value)}
              className={css({ width: '192px' })}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            color="secondary"
            onClick={() => {
              const payload = { name: participantName.trim() };
              addIdentity.mutate({ ...payload, request_key: participantKey.keyFor(payload) });
            }}
            disabled={participantName.trim().length === 0 || addIdentity.isPending}
          >
            {t('playground.identities.add')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
