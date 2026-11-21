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
import { useCoalescedRefetch } from '@/hooks/use-coalesced-refetch';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import type { SnapshotPosition } from '@/lib/queries';
import { useUiStore } from '@/stores/ui';

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

interface PositionState<TPage> extends SnapshotPosition {
  readonly resetKey: string;
  /**
   * The page-1 rows of the snapshot a live renewal replaced. They are that
   * request's placeholder, so an arrival does not drop the table it just left.
   */
  readonly carried: TPage | null;
  /** The snapshot `carried` was taken from; it is only a placeholder for that one. */
  readonly carriedFor: number;
  /** This snapshot counted arrivals the reader has not seen yet, on any page. */
  readonly arrivals: boolean;
}

let snapshots = 0;

function nextSnapshot(): number {
  snapshots += 1;
  return snapshots;
}

/**
 * The renewal's placeholder. TanStack's `placeholderData` is typed as
 * `NonFunctionGuard<TPage>`, which an unresolved type parameter cannot satisfy
 * (it could still be callable), so the options object is asserted: the value is
 * always a `Page` payload, never a function.
 */
function withPlaceholder<TPage extends Page<unknown>, TQueryKey extends QueryKey>(
  options: SnapshotQueryOptions<TPage, TQueryKey>,
  carried: TPage,
): SnapshotQueryOptions<TPage, TQueryKey> {
  return { ...options, placeholderData: carried } as SnapshotQueryOptions<TPage, TQueryKey>;
}

function openingPosition<TPage>(resetKey: string): PositionState<TPage> {
  return { resetKey, snapshot: nextSnapshot(), asOf: null, page: 1, carried: null, carriedFor: 0, arrivals: false };
}

/**
 * Page state over a snapshot listing. A `resetKey` change (new filters), the
 * notice's `renew` and a live renewal open a new snapshot on page 1;
 * `onPageChange` and the query's own polling stay on the current one and only
 * refresh its rows and `new_count`.
 *
 * `renewOnArrival` makes the renewal declarative for a live list with Auto
 * refresh on: whenever this snapshot reports rows the reader has not seen and
 * the reader is on page 1, the hook moves to a new snapshot during render,
 * carrying the rows on screen as that request's placeholder. Doing this in the
 * render pass rather than in the change callback is what keeps it honest — the
 * decision always uses the position and filters the reader is in right now, it
 * also fires when a reader comes back to page 1 after counting arrivals on
 * page 2, and the carried rows replace `withinSnapshot`'s missing placeholder
 * for exactly this renewal.
 */
export function useSnapshotPages<TPage extends Page<unknown>, TQueryKey extends QueryKey = QueryKey>(
  options: (position: SnapshotPosition) => SnapshotQueryOptions<TPage, TQueryKey>,
  resetKey: string,
  renewOnArrival = false,
) {
  const [state, setState] = useState<PositionState<TPage>>(() => openingPosition<TPage>(resetKey));
  let position = state;
  if (position.resetKey !== resetKey) {
    position = openingPosition<TPage>(resetKey);
    setState(position);
  }
  const base = options(position);
  // A renewal keeps the previous page-1 rows as its placeholder; every other
  // request keeps the factory's own placeholder (`withinSnapshot`).
  const carried = position.carried;
  const carrying = carried !== null && position.carriedFor === position.snapshot && position.page === 1;
  const query = useQuery(carrying && carried !== null ? withPlaceholder(base, carried) : base);
  const data = query.isPlaceholderData ? undefined : query.data;
  if (position.asOf === null && data !== undefined) {
    // The opening response names the snapshot; the query key already names it
    // by id, so pinning the token does not refetch.
    position = { ...position, asOf: data.as_of };
    setState(position);
  }
  if (carrying && data !== undefined) {
    // The snapshot this placeholder belonged to has answered; from here on the
    // query's own data (and `withinSnapshot` for later pages) is the real one.
    position = { ...position, carried: null, carriedFor: 0 };
    setState(position);
  }
  const arrivals = position.arrivals || (data !== undefined && data.new_count > 0);
  if (!position.arrivals && data !== undefined && data.new_count > 0) {
    // Arrivals are counted on whichever page noticed them, so a reader who
    // comes back to page 1 still learns about them.
    position = { ...position, arrivals: true };
    setState(position);
  }
  if (renewOnArrival && position.page === 1 && arrivals && data !== undefined) {
    const snapshot = nextSnapshot();
    position = {
      resetKey,
      snapshot,
      asOf: null,
      page: 1,
      carried: data ?? null,
      carriedFor: data === undefined ? 0 : snapshot,
      arrivals: false,
    };
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
      setState(openingPosition<TPage>(resetKey));
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

/** What a live list needs to know about its change channel. */
export interface SnapshotLiveOptions {
  /** The event-stream endpoint; every event means "refetch what this list shows". */
  readonly url: string;
  /**
   * On page 1, open a new snapshot for every event so arrivals are already at
   * the top when the reader looks. Later pages never do that: their rows
   * refresh, and arrivals stay counted in the notice so pages do not shift.
   */
  readonly renewOnPageOne?: boolean;
}

export interface SnapshotListProps<T, TQueryKey extends QueryKey = QueryKey> {
  readonly factory: SnapshotQueryFactory<T, TQueryKey>;
  readonly filters: ListFilters;
  /**
   * Follows the server's change stream while the panel's Auto refresh
   * preference is on. Lists without it behave exactly as before.
   */
  readonly live?: SnapshotLiveOptions;
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
  live,
  renderItems,
  actions,
  errorTitle,
  noticeTitle,
  noticeAction,
  snapshotKey = 0,
  className,
}: SnapshotListProps<T, TQueryKey>): React.ReactNode {
  const { t } = useTranslation();
  const autoRefresh = useUiStore((state) => state.invocationAutoRefresh);
  // Page 1 of a live list renews its own snapshot on arrival (inside
  // `useSnapshotPages`), so a notice there would only ever be a one-frame flash
  // of rows that are already on screen.
  const renewsOnArrival = live !== undefined && autoRefresh && live.renewOnPageOne === true;
  const { query, data, items, page, pageCount, total, newCount, onPageChange, renew } = useSnapshotPages(
    (position) => factory(filters, position),
    JSON.stringify([filters, snapshotKey]),
    renewsOnArrival,
  );
  // Every event refreshes the rows in place; the hook moves the snapshot itself
  // only once a response reports arrivals. Coalesced so a slow fetch is not
  // cancelled by the next event before it can deliver.
  useLiveRefresh({
    url: live === undefined ? null : live.url,
    enabled: live !== undefined && autoRefresh,
    onChange: useCoalescedRefetch(query.refetch),
  });

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
        count={renewsOnArrival && page === 1 ? 0 : newCount}
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
