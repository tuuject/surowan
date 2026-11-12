import { type QueryKey, type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, ListToolbar } from '@/components/business/list-page';
import type { ListFilters, Page } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';
import type { SnapshotPosition } from '@/lib/queries';

export type { SnapshotPosition };

export type SnapshotQueryOptions<TPage, TQueryKey extends QueryKey = QueryKey> = UseQueryOptions<
  TPage,
  Error,
  TPage,
  TQueryKey
>;

export type SnapshotQueryFactory<T, TQueryKey extends QueryKey = QueryKey> = (
  filters: ListFilters,
  position: SnapshotPosition,
) => SnapshotQueryOptions<Page<T>, TQueryKey>;

interface PositionState extends SnapshotPosition {
  readonly resetKey: string;
}

let snapshots = 0;

function nextSnapshot(): number {
  snapshots += 1;
  return snapshots;
}

/**
 * Page state over a snapshot listing. A `resetKey` change (new filters) and
 * `renew` both open a new snapshot on page 1; `onPageChange` and the query's
 * own polling stay on the current one and only refresh its rows and
 * `new_count`.
 */
export function useSnapshotPages<TPage extends Page<unknown>, TQueryKey extends QueryKey = QueryKey>(
  options: (position: SnapshotPosition) => SnapshotQueryOptions<TPage, TQueryKey>,
  resetKey: string,
) {
  const [state, setState] = useState<PositionState>(() => ({
    resetKey,
    snapshot: nextSnapshot(),
    asOf: null,
    page: 1,
  }));
  let position = state;
  if (position.resetKey !== resetKey) {
    position = { resetKey, snapshot: nextSnapshot(), asOf: null, page: 1 };
    setState(position);
  }
  const query = useQuery(options(position));
  const data = query.isPlaceholderData ? undefined : query.data;
  if (position.asOf === null && data !== undefined) {
    // The opening response names the snapshot; the query key already names it
    // by id, so pinning the token does not refetch.
    position = { ...position, asOf: data.as_of };
    setState(position);
  }
  const shown = query.data;
  const pageSize = shown?.limit ?? 1;
  const total = shown?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (data !== undefined && position.page > pageCount) {
    // Deletions shrank the snapshot below the current page.
    position = { ...position, page: pageCount };
    setState(position);
  }

  return {
    query,
    /** The page on screen; while another page loads, the previous one stays. */
    data: shown,
    items: (shown?.items ?? []) as TPage['items'],
    page: position.page,
    pageCount,
    total,
    // A placeholder is only ever a page of the same snapshot, so its count still holds.
    newCount: shown?.new_count ?? 0,
    onPageChange: (next: number): void => {
      const page = Math.min(Math.max(1, Math.trunc(next)), pageCount);
      setState((current) => (current.page === page ? current : { ...current, page }));
    },
    /** Drops the snapshot: page 1 of a new one, including every arrival. */
    renew: (): void => {
      setState({ resetKey, snapshot: nextSnapshot(), asOf: null, page: 1 });
    },
  };
}

/**
 * The prompt that new rows arrived after the snapshot. The list stays as it
 * is until the reader asks for the new rows.
 */
export function SnapshotNotice({
  count,
  onRenew,
  title,
  actionLabel,
  className,
}: {
  readonly count: number;
  readonly onRenew: () => void;
  readonly title?: string;
  readonly actionLabel?: string;
  readonly className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (count <= 0) {
    return null;
  }
  return (
    <Alert
      tone="info"
      className={className}
      title={title ?? t('layout.business.newRecords', { count })}
      action={
        <Button size="sm" variant="outline" color="secondary" onClick={onRenew}>
          {actionLabel ?? t('layout.business.showNewRecords')}
        </Button>
      }
    />
  );
}

function SnapshotListError({ error, title }: { readonly error: unknown; readonly title: string }): ReactElement {
  const { t } = useTranslation();
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : t('invocations.business.list.adminRequestFailed');
  return (
    <Alert tone="error" title={title}>
      {message}
    </Alert>
  );
}

export interface SnapshotListProps<T, TQueryKey extends QueryKey = QueryKey> {
  readonly factory: SnapshotQueryFactory<T, TQueryKey>;
  readonly filters: ListFilters;
  readonly renderItems: (items: readonly T[], state: { readonly loading: boolean }) => React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly errorTitle?: string;
  /** Overrides the notice for lists whose arrivals are not new rows. */
  readonly noticeTitle?: (count: number) => string;
  readonly noticeAction?: string;
  /**
   * Changing it opens a new snapshot, as new filters do. A page bumps it after
   * the reader's own insert: a row they just wrote is not news to announce.
   */
  readonly snapshotKey?: number;
  readonly className?: string;
}

export function SnapshotList<T, TQueryKey extends QueryKey = QueryKey>({
  factory,
  filters,
  renderItems,
  actions,
  errorTitle,
  noticeTitle,
  noticeAction,
  snapshotKey = 0,
  className,
}: SnapshotListProps<T, TQueryKey>): React.ReactNode {
  const { t } = useTranslation();
  const { query, data, items, page, pageCount, total, newCount, onPageChange, renew } = useSnapshotPages(
    (position) => factory(filters, position),
    JSON.stringify([filters, snapshotKey]),
  );

  return (
    <div className={cx(css({ '& > :not(:last-child)': { marginBlockEnd: '5' } }), className)}>
      <ListToolbar
        onRefresh={() => {
          if (!query.isFetching) {
            void query.refetch();
          }
        }}
        refreshing={query.isFetching}
      >
        {actions}
      </ListToolbar>
      <SnapshotNotice
        count={newCount}
        onRenew={renew}
        {...(noticeTitle === undefined ? {} : { title: noticeTitle(newCount) })}
        {...(noticeAction === undefined ? {} : { actionLabel: noticeAction })}
      />
      {query.isError ? <SnapshotListError error={query.error} title={errorTitle ?? t('common.requestFailed')} /> : null}
      {query.isPending || data !== undefined ? (
        <div>
          {renderItems(items as readonly T[], { loading: query.isPending })}
          {data === undefined ? null : (
            <ListFooter
              count={total}
              page={page}
              pageCount={pageCount}
              busy={query.isPlaceholderData}
              onPageChange={onPageChange}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
