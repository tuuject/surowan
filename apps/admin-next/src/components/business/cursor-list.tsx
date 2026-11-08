import {
  type InfiniteData,
  type QueryKey,
  type UndefinedInitialDataInfiniteOptions,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { type ReactElement, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFooter, ListToolbar } from '@/components/business/list-page';
import type { ListFilters, Page } from '@/lib/api/core.ts';
import { ApiError } from '@/lib/api/core.ts';

export type CursorQueryOptions<T, TQueryKey extends QueryKey = QueryKey> = UndefinedInitialDataInfiniteOptions<
  Page<T>,
  Error,
  InfiniteData<Page<T>>,
  TQueryKey,
  string | null
>;

export type CursorQueryFactory<T> = (filters: ListFilters) => CursorQueryOptions<T>;

export interface CursorRenderState {
  readonly loading: boolean;
}

export interface CursorListProps<T, TQueryKey extends QueryKey = QueryKey> {
  readonly factory: (filters: ListFilters) => CursorQueryOptions<T, TQueryKey>;
  readonly filters: ListFilters;
  readonly renderItems: (items: readonly T[], state: CursorRenderState) => React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly errorTitle?: string;
  readonly className?: string;
}

interface CursorPosition {
  readonly queryKey: string;
  readonly pageIndex: number;
}

/**
 * Real Previous/Next state over a keyset API. TanStack may retain fetched pages
 * for cache/back navigation, but only the current page is ever returned for
 * rendering. A filter/query-key change resets to the first cursor immediately.
 */
export function useCursorPages<
  TPage extends { readonly items: readonly unknown[] },
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(options: UndefinedInitialDataInfiniteOptions<TPage, Error, InfiniteData<TPage>, TQueryKey, TPageParam>) {
  const query = useInfiniteQuery(options);
  const queryKey = JSON.stringify(options.queryKey);
  const [position, setPosition] = useState<CursorPosition>({ queryKey, pageIndex: 0 });
  const navigation = useRef(0);
  const pages = query.data?.pages ?? [];
  const pageIndex = position.queryKey === queryKey ? Math.min(position.pageIndex, Math.max(0, pages.length - 1)) : 0;
  if (position.queryKey !== queryKey) {
    navigation.current += 1;
    setPosition({ queryKey, pageIndex: 0 });
  } else if (position.pageIndex !== pageIndex) {
    setPosition({ queryKey, pageIndex });
  }
  const currentPage = pages[pageIndex];
  const items: TPage['items'] = currentPage?.items ?? [];
  const pageCount = Math.max(1, pages.length + (query.hasNextPage ? 1 : 0));

  const onPageChange = async (oneBasedPage: number): Promise<void> => {
    const nextIndex = Math.max(0, Math.trunc(oneBasedPage) - 1);
    if (nextIndex < pages.length) {
      navigation.current += 1;
      setPosition({ queryKey, pageIndex: nextIndex });
      return;
    }
    if (nextIndex !== pages.length || !query.hasNextPage || query.isFetchingNextPage) {
      return;
    }
    const request = ++navigation.current;
    const result = await query.fetchNextPage();
    if (navigation.current === request && result.data?.pages[nextIndex] !== undefined) {
      setPosition({ queryKey, pageIndex: nextIndex });
    }
  };

  return {
    query,
    pages,
    currentPage,
    items,
    page: pageIndex + 1,
    pageCount,
    onPageChange,
  };
}

function CursorListError({ error, title }: { readonly error: unknown; readonly title: string }): ReactElement {
  const { t } = useTranslation();
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : t('invocations.business.cursorList.adminRequestFailed');
  return (
    <Alert tone="error" title={title}>
      {message}
    </Alert>
  );
}

export function CursorList<T, TQueryKey extends QueryKey = QueryKey>({
  factory,
  filters,
  renderItems,
  actions,
  errorTitle,
  className,
}: CursorListProps<T, TQueryKey>): React.ReactNode {
  const { t } = useTranslation();
  const { query, items, page, pageCount, onPageChange } = useCursorPages<Page<T>, TQueryKey, string | null>(
    factory(filters),
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
      {query.isError ? <CursorListError error={query.error} title={errorTitle ?? t('common.requestFailed')} /> : null}
      {query.isPending || query.data !== undefined ? (
        <div>
          {renderItems(items, { loading: query.isPending })}
          {query.data === undefined ? null : (
            <ListFooter
              count={items.length}
              cursor
              page={page}
              pageCount={pageCount}
              busy={query.isFetching}
              onPageChange={(next) => void onPageChange(next)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
