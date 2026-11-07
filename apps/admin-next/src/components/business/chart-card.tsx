import type React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { formatNumber } from '@/lib/format';
import { css, cx } from '@tuuject/koi-react/styled-system/css';

/**
 * Time-series chart panel for Overview / Usage. A thin recharts wrapper: one
 * x-axis (`date`), one line per series, compact y-axis tick labels. It does not
 * invent totals or aggregate endpoints the API does not provide.
 */

export interface ChartSeries {
  readonly dataKey: string;
  readonly label: string;
  readonly color: string;
}

export type ChartDatum = Readonly<Record<string, string | number>>;

const COMPACT_FORMATTER = new Intl.NumberFormat('en-US', { notation: 'compact' });

function compactNumber(value: number): string {
  return COMPACT_FORMATTER.format(value);
}

const AXIS_TICK = { fontSize: 12, fill: 'var(--muted-foreground)' };

/** Series color marks only the dot; labels and values stay neutral. */
function SeriesDot({ color }: { readonly color: string }): React.ReactElement {
  return (
    <span
      className={css({ width: '8px', height: '8px', flexShrink: '0', borderRadius: 'full' })}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

function ChartTooltip({
  active,
  label,
  payload,
  series,
}: {
  readonly active: boolean;
  readonly label: string | number | undefined;
  readonly payload: TooltipContentProps['payload'];
  readonly series: readonly ChartSeries[];
}): React.ReactNode {
  if (!active || payload.length === 0) {
    return null;
  }
  return (
    <div
      className={css({
        textStyle: 'small',
        bg: 'surface',
        color: 'text',
        '& > :not(:last-child)': { marginBlockEnd: '2' },
        borderRadius: 'xl',
        borderWidth: '1px',
        borderColor: 'border',
        paddingInline: '3',
        paddingBlock: '2',
      })}
    >
      <p className={css({ textStyle: 'label' })}>{label}</p>
      <ul className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' } })}>
        {series.map((entry) => {
          const item = payload.find((candidate) => candidate.dataKey === entry.dataKey);
          return (
            <li key={entry.dataKey} className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
              <SeriesDot color={entry.color} />
              <span className={css({ color: 'text-muted' })}>{entry.label}</span>
              <span
                className={css({
                  textStyle: 'label',
                  marginInlineStart: 'auto',
                  paddingInlineStart: '4',
                  fontVariantNumeric: 'tabular-nums',
                })}
              >
                {typeof item?.value === 'number' ? formatNumber(item.value) : '-'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TimeSeriesChart({
  data,
  series,
  height = 240,
}: {
  readonly data: readonly ChartDatum[];
  readonly series: readonly ChartSeries[];
  readonly height?: number;
}): React.ReactElement {
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '3' } })}>
      <div style={{ height }} className={css({ width: '100%' })}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...data]} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className={css({ stroke: 'divider' })} />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => compactNumber(value)}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)' }}
              content={({ active, label, payload }) => (
                <ChartTooltip active={active} label={label} payload={payload} series={series} />
              )}
            />
            {series.map((entry) => (
              <Line
                key={entry.dataKey}
                type="monotone"
                dataKey={entry.dataKey}
                name={entry.label}
                stroke={entry.color}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul
        className={css({
          textStyle: 'small',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          columnGap: '4',
          rowGap: '1',
        })}
      >
        {series.map((entry) => (
          <li
            key={entry.dataKey}
            className={css({ color: 'text-muted', display: 'flex', alignItems: 'center', gap: '2' })}
          >
            <SeriesDot color={entry.color} />
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartPanel({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cx(css({ '& > :not(:last-child)': { marginBlockEnd: '2' } }), className)}>
      <h3 className={css({ textStyle: 'label', color: 'text-muted' })}>{title}</h3>
      {children}
    </div>
  );
}
