import { IconButton } from '@tuuject/koi-react/button';
import { ChevronDownIcon, ChevronRightIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableEmpty,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@tuuject/koi-react/table';
import type React from 'react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ColumnSpec<T> {
  readonly key: string;
  readonly title: string;
  readonly align?: 'left' | 'center' | 'right';
  /**
   * px or any CSS length. Give every fixed-content column (IDs, counts, status,
   * timestamps, actions) a width that fits its longest value plus the cell's
   * 16px sides; leave two or more free-text columns without one so the spare
   * room splits between them (Koi Table spec).
   */
  readonly width?: number | string;
  /** `none` for a cell of 36px controls (icon-only row actions), so the row stays 48px. */
  readonly paddingBlock?: 'none';
  /** Sample content sizing the loading placeholder; defaults to the column title. */
  readonly skeleton?: React.ReactNode;
  readonly className?: string;
  readonly render: (row: T) => React.ReactNode;
}

export interface TableShellProps<T> {
  readonly columns: readonly ColumnSpec<T>[];
  readonly data: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly expandedRender?: (row: T) => React.ReactNode;
  readonly isExpandable?: (row: T) => boolean;
  /** The empty row's title. */
  readonly emptyText?: React.ReactNode;
  readonly emptyDescription?: React.ReactNode;
  readonly emptyAction?: React.ReactNode;
  /** Columns stop squeezing below this; the table's own container scrolls sideways instead. */
  readonly minWidth?: number | string;
  readonly layout?: 'fixed' | 'auto';
  readonly className?: string;
  readonly caption?: string;
  readonly loading?: boolean;
  readonly skeletonRows?: number;
}

const ALIGN = { left: 'start', center: 'center', right: 'end' } as const;

const skeletonClass = css({ display: 'inline-block', maxWidth: '100%', verticalAlign: 'middle', borderRadius: 'sm' });

/**
 * Koi's composed table, as on the template's order list: fixed layout sized by
 * the column widths, skeleton rows shaped like the content while a query
 * loads, and Koi's TableEmpty row. Optional inline detail rows open from a
 * leading toggle column.
 */
export function TableShell<T>({
  columns,
  data,
  rowKey,
  expandedRender,
  isExpandable,
  emptyText,
  emptyDescription,
  emptyAction,
  minWidth,
  layout = 'fixed',
  className,
  caption,
  loading = false,
  skeletonRows = 6,
}: TableShellProps<T>): React.ReactElement {
  const { t } = useTranslation();
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
  const align = (column: ColumnSpec<T>) => (column.align === undefined ? {} : { align: ALIGN[column.align] });

  return (
    <Table
      aria-busy={loading || undefined}
      layout={layout}
      {...(className === undefined ? {} : { className })}
      {...(minWidth === undefined ? {} : { style: { minWidth } })}
    >
      {caption === undefined ? null : <TableCaption>{caption}</TableCaption>}
      <TableHeader>
        <TableRow>
          {hasExpand ? (
            <TableHeaderCell style={{ width: 52 }}>
              <span className={css({ srOnly: true })}>{t('layout.business.rowDetails')}</span>
            </TableHeaderCell>
          ) : null}
          {columns.map((column) => (
            <TableHeaderCell
              key={column.key}
              {...align(column)}
              {...(column.width === undefined ? {} : { style: { width: column.width } })}
            >
              {column.title}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          Array.from({ length: skeletonRows }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder
            <TableRow key={index}>
              {hasExpand ? <TableCell /> : null}
              {columns.map((column) => (
                <TableCell key={column.key} {...align(column)}>
                  <Skeleton as="span" className={skeletonClass}>
                    {column.skeleton ?? column.title}
                  </Skeleton>
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : data.length === 0 ? (
          <TableEmpty
            colSpan={columnCount}
            {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
            {...(emptyAction === undefined ? {} : { action: emptyAction })}
          >
            {emptyText ?? t('invocations.business.cursorList.noRecordsDescription')}
          </TableEmpty>
        ) : (
          data.map((row) => {
            const key = rowKey(row);
            const expandable = hasExpand && (isExpandable?.(row) ?? true);
            const open = expandable && expandedKeys.has(key);
            return (
              <Fragment key={key}>
                <TableRow selected={open}>
                  {hasExpand ? (
                    <TableCell paddingBlock="none">
                      {expandable ? (
                        <IconButton
                          variant="ghost"
                          color="secondary"
                          aria-expanded={open}
                          label={t('layout.business.toggleRowDetails')}
                          icon={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                          onClick={() => toggleRow(key)}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      {...align(column)}
                      {...(column.paddingBlock === undefined ? {} : { paddingBlock: column.paddingBlock })}
                      {...(column.className === undefined ? {} : { className: column.className })}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
                {open ? (
                  <TableRow>
                    <TableCell
                      colSpan={columnCount}
                      className={css({ bg: 'surface-muted', whiteSpace: 'normal', verticalAlign: 'top' })}
                    >
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
  );
}
