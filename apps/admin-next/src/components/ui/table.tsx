import {
  Table as KoiTable,
  TableBody as KoiTableBody,
  TableCaption as KoiTableCaption,
  TableCell as KoiTableCell,
  TableFooter as KoiTableFooter,
  TableHeader as KoiTableHeader,
  TableRow as KoiTableRow,
  TableHeaderCell,
} from '@tuuject/koi-react/table';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const ALIGN_MAP = {
  left: 'start',
  right: 'end',
  center: 'center',
} as const;

/** Koi's table parts under the old names; row selection and cell alignment keep their native attributes. */
function Table({ className, ...props }: React.ComponentProps<'table'>): React.ReactElement {
  return <KoiTable className={cn(className)} {...props} />;
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>): React.ReactElement {
  return <KoiTableHeader className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>): React.ReactElement {
  return <KoiTableBody className={cn(className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>): React.ReactElement {
  return <KoiTableFooter className={cn(className)} {...props} />;
}

function TableRow({
  className,
  ...props
}: React.ComponentProps<'tr'> & { readonly 'data-state'?: 'selected' | undefined }): React.ReactElement {
  const { 'data-state': dataState, ...rowProps } = props as React.ComponentProps<'tr'> & {
    readonly 'data-state'?: string;
  };
  return <KoiTableRow selected={dataState === 'selected'} className={cn(className)} {...rowProps} />;
}

function TableHead({
  className,
  align,
  ...props
}: Omit<React.ComponentProps<'th'>, 'align'> & { readonly align?: 'left' | 'right' | 'center' }): React.ReactElement {
  return (
    <TableHeaderCell
      className={cn(className)}
      {...(align === undefined ? {} : { align: ALIGN_MAP[align] })}
      {...props}
    />
  );
}

function TableCell({
  className,
  align,
  ...props
}: Omit<React.ComponentProps<'td'>, 'align'> & { readonly align?: 'left' | 'right' | 'center' }): React.ReactElement {
  return (
    <KoiTableCell className={cn(className)} {...(align === undefined ? {} : { align: ALIGN_MAP[align] })} {...props} />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>): React.ReactElement {
  return <KoiTableCaption className={cn(className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
