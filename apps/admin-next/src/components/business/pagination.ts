import { useState } from 'react';

export const CLIENT_PAGE_SIZE = 10;
export const OFFSET_PAGE_SIZE = 20;

export interface ClientPagination<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly onPageChange: (page: number) => void;
}

export interface OffsetPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
  readonly pageCount: (total: number | undefined) => number;
  readonly onPageChange: (page: number) => void;
}

interface PagePosition {
  readonly key: string;
  readonly page: number;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}

/**
 * Paginates a complete response without changing the source array. Callers keep
 * using that full array for conflicts, permissions and cross-row validation;
 * only `items` is the page-local render slice.
 */
export function useClientPagination<T>(
  source: readonly T[],
  resetKey: string,
  pageSize = CLIENT_PAGE_SIZE,
): ClientPagination<T> {
  const [position, setPosition] = useState<PagePosition>({ key: resetKey, page: 1 });
  const pageCount = Math.max(1, Math.ceil(source.length / pageSize));
  const page = position.key === resetKey ? clampPage(position.page, pageCount) : 1;
  if (position.key !== resetKey || position.page !== page) {
    // Persist both filter resets and clamping after a deletion. Otherwise an
    // old position becomes active again when Back returns to its reset key.
    setPosition({ key: resetKey, page });
  }
  const start = (page - 1) * pageSize;
  return {
    items: source.slice(start, start + pageSize),
    total: source.length,
    page,
    pageCount,
    pageSize,
    onPageChange: (next) => setPosition({ key: resetKey, page: clampPage(next, pageCount) }),
  };
}

/**
 * Page state for APIs that expose a real `offset` and `total`. The total only
 * exists after the response, so `pageCount` is evaluated from that response
 * rather than being assumed while constructing the query.
 */
export function useOffsetPagination(resetKey: string, pageSize = OFFSET_PAGE_SIZE): OffsetPagination {
  const [position, setPosition] = useState<PagePosition>({ key: resetKey, page: 1 });
  const page = position.key === resetKey ? Math.max(1, position.page) : 1;
  if (position.key !== resetKey) {
    setPosition({ key: resetKey, page: 1 });
  }
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    pageCount: (total) => Math.max(1, Math.ceil((total ?? 0) / pageSize)),
    onPageChange: (next) => setPosition({ key: resetKey, page: Math.max(1, Math.trunc(next)) }),
  };
}
