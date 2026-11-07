import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** Plain Koi table spacing; list content never gets a floating Card frame. */
export const FLUSH_TABLE_CLASS =
  '[&_td:first-child]:ps-6 [&_td:last-child]:pe-6 [&_th:first-child]:ps-6 [&_th:last-child]:pe-6';

export const LIST_TABLE_CLASS =
  '[&_td:first-child]:ps-4 [&_td:last-child]:pe-4 [&_th]:text-muted-foreground [&_th:first-child]:ps-4 [&_th:last-child]:pe-4';

export interface ColumnSpec<T> {
  readonly key: string;
  readonly title: string;
  readonly align?: 'left' | 'right';
  readonly width?: number | string;
  readonly className?: string;
  readonly render: (row: T) => React.ReactNode;
}

export interface TableShellProps<T> {
  readonly columns: readonly ColumnSpec<T>[];
  readonly data: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly expandedRender?: (row: T) => React.ReactNode;
  readonly isExpandable?: (row: T) => boolean;
  readonly emptyText?: React.ReactNode;
  readonly className?: string;
  readonly frame?: boolean;
  readonly caption?: string;
  readonly loading?: boolean;
  readonly skeletonRows?: number;
}

/**
 * Koi's order-table structure with the panel's existing optional inline detail
 * rows. Loading and empty states stay inside the table, so the header and the
 * real column hierarchy never disappear between queries.
 */
export function TableShell<T>({
  columns,
  data,
  rowKey,
  expandedRender,
  isExpandable,
  emptyText,
  className,
  frame = true,
  caption,
  loading = false,
  skeletonRows = 6,
}: TableShellProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const empty = emptyText ?? t('invocations.business.cursorList.noRecordsDescription');
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());

  const toggleRow = (key: string): void => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const hasExpand = expandedRender !== undefined;
  const columnCount = columns.length + (hasExpand ? 1 : 0);
  const skeleton = Array.from({ length: skeletonRows }, (_, index) => index);

  return (
    <div className={cn('overflow-x-auto', frame && 'border-y', className)}>
      <Table aria-busy={loading || undefined}>
        {caption === undefined ? null : <TableCaption>{caption}</TableCaption>}
        <TableHeader>
          <TableRow>
            {hasExpand ? <TableHead className="w-9" aria-label={t('layout.business.rowDetails')} /> : null}
            {columns.map((column) => (
              <TableHead
                key={column.key}
                {...(column.width !== undefined ? { style: { width: column.width } } : {})}
                className={cn(column.align === 'right' && 'text-right', column.className)}
              >
                {column.title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            skeleton.map((key) => (
              <TableRow key={key}>
                {hasExpand ? (
                  <TableCell className="w-9">
                    <Skeleton className="block size-4" />
                  </TableCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell key={column.key} className={cn(column.align === 'right' && 'text-right')}>
                    <Skeleton className="block h-4 w-24 max-w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="text-muted-foreground h-24 text-center">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row) => {
              const key = rowKey(row);
              const expandable = hasExpand && (isExpandable?.(row) ?? true);
              const open = expandable && expandedKeys.has(key);
              return (
                <Fragment key={key}>
                  <TableRow data-state={open ? 'selected' : undefined}>
                    {hasExpand ? (
                      <TableCell className="w-9">
                        {expandable ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-expanded={open}
                            aria-label={t('layout.business.toggleRowDetails')}
                            onClick={() => toggleRow(key)}
                          >
                            {open ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(column.align === 'right' ? 'text-right' : '', column.className)}
                      >
                        {column.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {open ? (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="bg-muted/30 p-4 align-top">
                        {expandedRender?.(row)}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
