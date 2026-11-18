import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { KvList, LazyDetails, TableShell, type TableShellProps } from '@/components/business';
import { useMediaQuery } from '@/hooks/use-media-query';

interface AuditRecordsProps<T>
  extends Pick<TableShellProps<T>, 'columns' | 'data' | 'rowKey' | 'expandedRender' | 'isExpandable'> {
  readonly summaryKeys: readonly [title: string, subtitle: string];
}

const recordClass = css({
  borderBlockEndWidth: '1px',
  borderColor: 'divider',
  '& > summary': { display: 'flex', minHeight: '12', paddingBlock: '2' },
  '&[open]': { paddingBlockEnd: '4' },
});

const summaryClass = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  flex: '1',
  minWidth: '0',
  gap: '3',
  color: 'text',
  overflowWrap: 'anywhere',
});

const fieldsClass = css({
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 8rem), 1fr))',
  gap: '3',
});

export function AuditRecords<T>({ summaryKeys, ...table }: AuditRecordsProps<T>): ReactElement {
  const desktop = useMediaQuery('(min-width: 768px)');
  if (desktop) {
    return <TableShell {...table} />;
  }

  const { columns, data, rowKey, expandedRender, isExpandable } = table;
  const [titleKey, subtitleKey] = summaryKeys;
  const title = columns.find((column) => column.key === titleKey);
  const subtitle = columns.find((column) => column.key === subtitleKey);
  const state = columns.find((column) => column.key === 'state');
  const fields = columns.filter((column) => column !== title && column !== subtitle && column !== state);

  return (
    <div>
      {data.map((row) => (
        <LazyDetails
          key={rowKey(row)}
          className={recordClass}
          summary={
            <span className={summaryClass}>
              <span>
                <span>{title?.render(row)}</span>
                {subtitle ? (
                  <span className={css({ display: 'block', color: 'text-muted', textStyle: 'small' })}>
                    {subtitle.title} {subtitle.render(row)}
                  </span>
                ) : null}
              </span>
              <span>{state?.render(row)}</span>
            </span>
          }
        >
          <KvList
            columns={1}
            className={fieldsClass}
            items={fields.map((column) => ({ label: column.title, value: column.render(row) }))}
          />
          {expandedRender !== undefined && (isExpandable?.(row) ?? true) ? (
            <div className={css({ marginBlockStart: '4' })}>{expandedRender(row)}</div>
          ) : null}
        </LazyDetails>
      ))}
    </div>
  );
}
