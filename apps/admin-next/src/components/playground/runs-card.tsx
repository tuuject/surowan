import type { QueryClient } from '@tanstack/react-query';
import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, type OffsetPagination, StateBadge, useClientPagination } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import type {
  PlaygroundInvocation,
  PlaygroundReleaseDetail,
  PlaygroundRoomDetail,
  PlaygroundStatusSummary,
} from '@/lib/api/playground.ts';
import { AttemptRow } from './rows.tsx';

interface RunsCardProps {
  readonly roomId: string;
  readonly status: PlaygroundStatusSummary | undefined;
  readonly revision: string;
  readonly pending: number;
  readonly runs: {
    readonly data: { readonly items: readonly PlaygroundInvocation[]; readonly total: number } | undefined;
  };
  readonly pagination: OffsetPagination;
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
  pagination: runPagination,
  detail,
  releaseDetail,
  queryClient,
  setOpenRelease,
}: RunsCardProps): React.ReactElement {
  const { t } = useTranslation();
  const releasePagination = useClientPagination(detail.data?.releases ?? [], `${roomId}:releases`);
  return (
    <Panel
      title={t('playground.runs.heading')}
      description={status === undefined ? undefined : t('playground.room.statusSummary', { revision, pending })}
      className={css({ minWidth: '0' })}
    >
      <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
        {runs.data?.items.length === 0 ? (
          <p className={css({ textStyle: 'body', color: 'text-muted' })}>{t('playground.runs.empty')}</p>
        ) : null}
        <ul className={css({ minWidth: '0' })}>
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
        {runs.data === undefined ? null : (
          <ListFooter
            count={runs.data.total}
            page={runPagination.page}
            pageCount={runPagination.pageCount(runs.data.total)}
            onPageChange={runPagination.onPageChange}
          />
        )}
        {(detail.data?.releases ?? []).length === 0 ? null : (
          <div>
            <div className={css({ display: 'flex', flexWrap: 'wrap', gap: '2' })}>
              {releasePagination.items.map((entry) => (
                <Button
                  key={entry.id}
                  type="button"
                  variant="outline"
                  color="secondary"
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
            <ListFooter
              count={releasePagination.total}
              page={releasePagination.page}
              pageCount={releasePagination.pageCount}
              onPageChange={releasePagination.onPageChange}
            />
          </div>
        )}
        {releaseDetail.data === undefined ? null : <ReleaseDetails detail={releaseDetail.data} />}
        {runs.data?.items.some((entry) => entry.state === 'completed' && entry.sends_used === 0) === true ? (
          <p className={css({ textStyle: 'small', color: 'text-muted' })}>{t('playground.runs.noSend')}</p>
        ) : null}
      </div>
    </Panel>
  );
}

function ReleaseDetails({ detail }: { readonly detail: PlaygroundReleaseDetail }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={css({
        '& > :not(:last-child)': { marginBlockEnd: '2' },
        borderInlineStartWidth: '1px',
        borderColor: 'divider',
        paddingBlock: '2',
        paddingInlineStart: '3',
      })}
    >
      <p
        className={css({
          margin: '0',
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: '3',
          rowGap: '1',
          textStyle: 'small',
        })}
      >
        <span>
          {t('playground.runs.detail')} #{detail.release.id}
        </span>
        <span>{t('playground.runs.throughSeq', { seq: detail.release.through_seq })}</span>
        {detail.release.bucket_id === null ? null : (
          <span>{t('playground.runs.bucket', { id: detail.release.bucket_id })}</span>
        )}
      </p>
      <ul>
        {detail.attempts.map((attempt) => (
          <li
            key={attempt.id}
            className={css({ textStyle: 'small', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}
          >
            <span className={css({ fontFamily: 'mono' })}>{attempt.id}</span>
            <StateBadge state={attempt.state} />
            <span className={css({ color: 'text-muted' })}>
              {t('playground.runs.usage', { tokens: attempt.total_tokens, cost: attempt.total_cost ?? 0 })}
            </span>
            {attempt.receipt_state === null ? null : (
              <span className={css({ color: 'text-muted' })}>
                {t('playground.runs.receipt', { state: attempt.receipt_state })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {detail.sends.length === 0 ? null : (
        <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <p className={css({ textStyle: 'small' })}>{t('playground.runs.sends')}</p>
          <ul>
            {detail.sends.map((send) => (
              <li
                key={send.id}
                className={css({
                  textStyle: 'small',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '2',
                })}
              >
                <span className={css({ fontFamily: 'mono' })}>{send.kind}</span>
                <StateBadge state={send.state} />
                <span className={css({ color: 'text-muted' })}>
                  {send.message_id === null ? '' : `#${send.message_id}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
