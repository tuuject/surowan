import { IconButton } from '@tuuject/koi-react/button';
import { Checkbox } from '@tuuject/koi-react/checkbox';
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
import { Fragment, type ReactElement, useState } from 'react';
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

/** Row selection, drawn as the template's leading Checkbox column (DataTable deliberately leaves it out). */
export interface TableSelection<T> {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (row: T, checked: boolean) => void;
  readonly onToggleAll: (checked: boolean) => void;
  /** Accessible names: the header box and each row's box. */
  readonly allLabel: string;
  readonly rowLabel: (row: T) => string;
  readonly isSelectable?: (row: T) => boolean;
  /** Freezes every box, e.g. while a batch run reads the current selection. */
  readonly disabled?: boolean;
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
  readonly selection?: TableSelection<T>;
  /** The row the rest of the page is showing (a master-detail pick): filled like a selected row. */
  readonly activeRowKey?: string | null;
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
  selection,
  activeRowKey = null,
}: TableShellProps<T>): ReactElement {
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
  const hasSelection = selection !== undefined;
  const columnCount = columns.length + (hasExpand ? 1 : 0) + (hasSelection ? 1 : 0);
  const selectable = selection === undefined ? [] : data.filter((row) => selection.isSelectable?.(row) ?? true);
  const allSelected =
    selection !== undefined && selectable.length > 0 && selectable.every((row) => selection.selected.has(rowKey(row)));
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
          {selection === undefined ? null : (
            <TableHeaderCell align="center" style={{ width: 48 }}>
              <Checkbox
                checked={allSelected}
                disabled={loading || selectable.length === 0 || selection.disabled === true}
                onCheckedChange={(checked) => selection.onToggleAll(checked)}
                aria-label={selection.allLabel}
              />
            </TableHeaderCell>
          )}
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
              {hasSelection ? <TableCell /> : null}
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
            {emptyText ?? t('invocations.business.list.noRecordsDescription')}
          </TableEmpty>
        ) : (
          data.map((row) => {
            const key = rowKey(row);
            const expandable = hasExpand && (isExpandable?.(row) ?? true);
            const open = expandable && expandedKeys.has(key);
            return (
              <Fragment key={key}>
                <TableRow
                  selected={open || key === activeRowKey || (selection?.selected.has(key) ?? false)}
                  {...(key === activeRowKey ? { 'aria-current': 'true' as const } : {})}
                >
                  {selection === undefined ? null : (
                    <TableCell align="center">
                      {(selection.isSelectable?.(row) ?? true) ? (
                        <Checkbox
                          checked={selection.selected.has(key)}
                          disabled={selection.disabled === true}
                          onCheckedChange={(checked) => selection.onToggle(row, checked)}
                          aria-label={selection.rowLabel(row)}
                        />
                      ) : null}
                    </TableCell>
                  )}
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
