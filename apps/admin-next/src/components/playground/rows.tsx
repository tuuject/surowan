import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { StateBadge, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';

import { errorMessage } from '@/lib/errors';
import { formatNumber, formatTime } from '@/lib/format';
import { StatusPill } from './shared.tsx';
import { playgroundAssetUrl, retryPlaygroundRelease } from '@/lib/api/playground.ts';
import type { PlaygroundInvocation, PlaygroundTimelineItem } from '@/lib/api/playground.ts';

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
    <li className="space-y-1 border-b py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{invocation.id}</span>
        <StateBadge state={invocation.state} />
        <Link
          to="/invocations/$invocationId"
          params={{ invocationId: invocation.id }}
          className="text-primary text-xs underline-offset-4 hover:underline"
        >
          {t('playground.runs.openAudit')}
        </Link>
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
