import {
  type InfiniteData,
  type QueryKey,
  type UndefinedInitialDataInfiniteOptions,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { useRef, useState } from 'react';

interface CursorPosition {
  readonly queryKey: string;
  readonly pageIndex: number;
}

/**
 * Previous/Next state over a keyset timeline (the Playground room history,
 * which grows at its newest end while older pages are read). TanStack may retain fetched pages
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
