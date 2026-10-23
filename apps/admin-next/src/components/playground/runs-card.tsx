import type { QueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StateBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AttemptRow } from './rows.tsx';
import type {
  PlaygroundInvocation,
  PlaygroundReleaseDetail,
  PlaygroundRoomDetail,
  PlaygroundStatusSummary,
} from '@/lib/api/playground.ts';

interface RunsCardProps {
  readonly roomId: string;
  readonly status: PlaygroundStatusSummary | undefined;
  readonly revision: string;
  readonly pending: number;
  readonly runs: { readonly data: { readonly items: readonly PlaygroundInvocation[] } | undefined };
  readonly detail: { readonly data: PlaygroundRoomDetail | undefined };
  readonly releaseDetail: { readonly data: PlaygroundReleaseDetail | undefined };
  readonly queryClient: QueryClient;
  readonly setOpenRelease: (releaseId: string) => void;
}

export function RunsCard({
  roomId,
  status,
  revision,
  pending,
  runs,
  detail,
  releaseDetail,
  queryClient,
  setOpenRelease,
}: RunsCardProps): React.ReactElement {
  const { t } = useTranslation();
  return (
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
