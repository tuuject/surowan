import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StateBadge, ToneBadge } from '@/components/business';
import type { PlaygroundInvocation, PlaygroundTimelineItem } from '@/lib/api/playground.ts';
import { playgroundAssetUrl, retryPlaygroundRelease } from '@/lib/api/playground.ts';
import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { toast } from '@/lib/toast.ts';
import { StatusPill } from './shared.tsx';

export function TimelineRow({
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
    <li
      className={css({
        display: 'flex',
        minWidth: '0',
        flexDirection: 'column',
        gap: '1',
        borderBottomWidth: '1px',
        borderColor: 'divider',
        paddingBlock: '2',
        _last: { borderBottomWidth: '0' },
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
        <span className={css({ textStyle: 'small', color: 'text-muted', fontFamily: 'mono' })}>#{item.seq}</span>
        <span className={css({ textStyle: 'label' })}>
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
        <span className={css({ textStyle: 'small', color: 'text-muted', marginInlineStart: 'auto' })}>
          {formatTime(item.created_at)}
        </span>
      </div>
      {item.reply_to_seq === null ? null : (
        <p className={css({ textStyle: 'small', color: 'text-muted' })}>
          {t('playground.messages.replyTo', { seq: item.reply_to_seq })}
        </p>
      )}
      {item.text === null || item.text.length === 0 ? null : (
        <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>{item.text}</p>
      )}
      {item.caption === null || item.caption.length === 0 ? null : (
        <p className={css({ textStyle: 'body', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' })}>{item.caption}</p>
      )}
      {item.media.length === 0 ? null : (
        <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
          {item.media.map((media) =>
            media.asset_id === null ? (
              <span key={media.media_id} className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('playground.messages.unsupportedMedia', { kind: media.kind })}
              </span>
            ) : (
              <img
                key={media.media_id}
                src={playgroundAssetUrl(roomId, media.asset_id)}
                alt={media.kind}
                className={css({
                  borderColor: 'border',
                  height: '96px',
                  width: '96px',
                  borderRadius: 'lg',
                  borderWidth: '1px',
                  objectFit: 'cover',
                })}
              />
            ),
          )}
        </div>
      )}
      {item.sent_by_bot ? null : (
        <div>
          <Button type="button" variant="ghost" color="secondary" size="sm" onClick={() => onReply(item.seq)}>
            {t('playground.messages.reply')}
          </Button>
        </div>
      )}
    </li>
  );
}

export function AttemptRow({
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
    <li
      className={css({
        textStyle: 'body',
        '& > :not(:last-child)': { marginBlockEnd: '1' },
        borderBottomWidth: '1px',
        borderColor: 'divider',
        paddingBlock: '2',
        _last: { borderBottomWidth: '0' },
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
        <span className={css({ textStyle: 'small', fontFamily: 'mono' })}>{invocation.id}</span>
        <StateBadge state={invocation.state} />
        <Link
          to="/invocations/$invocationId"
          params={{ invocationId: invocation.id }}
          className={css({
            textStyle: 'small',
            color: 'text-brand',
            textUnderlineOffset: '4px',
            _hover: { textDecorationLine: 'underline' },
          })}
        >
          {t('playground.runs.openAudit')}
        </Link>
        {invocation.retry_of_invocation_id === null ? null : (
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('playground.runs.retryOf', { id: invocation.retry_of_invocation_id })}
          </span>
        )}
        <StatusPill label="tokens" value={formatNumber(invocation.total_tokens)} />
        <span className={css({ textStyle: 'small', color: 'text-muted', marginInlineStart: 'auto' })}>
          {formatTime(invocation.finished_at)}
        </span>
      </div>
      <p className={css({ textStyle: 'small', color: 'text-muted' })}>
        {invocation.completion_reason ?? invocation.state}
        {invocation.error_code === null ? '' : ` · ${invocation.error_code}`}
      </p>
      {canRetry ? (
        <Button
          type="button"
          variant="outline"
          color="secondary"
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
