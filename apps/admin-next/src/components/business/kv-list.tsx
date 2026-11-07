import type React from 'react';
import { css, cx } from '@tuuject/koi-react/styled-system/css';

/**
 * Key/value detail list for detail-page diagnostic fields. Null or empty
 * values should use `TextValue` so they render as a placeholder instead of
 * disappearing.
 */

export interface KvItem {
  readonly label: string;
  readonly value: React.ReactNode;
}

export function KvList({
  items,
  className,
}: {
  readonly items: readonly KvItem[];
  readonly className?: string;
}): React.ReactElement {
  return (
    <dl
      className={cx(
        css({
          display: 'grid',
          columnGap: '6',
          rowGap: '3',
          md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
        }),
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className={css({ minWidth: '0' })}>
          <dt className={css({ textStyle: 'small', color: 'text-muted' })}>{item.label}</dt>
          <dd className={css({ textStyle: 'body', marginBlockStart: '1', overflowWrap: 'anywhere' })}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Nullable text with a muted placeholder; never renders empty. */
export function TextValue({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}): React.ReactElement {
  if (value === null || value.length === 0) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return <span className={cx(css({ overflowWrap: 'anywhere' }), className)}>{value}</span>;
}

/** Nullable monospace ID text (bigint-string fields stay strings). */
export function MonoValue({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}): React.ReactElement {
  if (value === null || value.length === 0) {
    return <span className={css({ color: 'text-muted' })}>—</span>;
  }
  return (
    <code
      className={cx(
        // Plain fixed-width text in the surrounding size and color: a filled chip on every ID turns a
        // table into a field of pills.
        css({ fontFamily: 'mono', wordBreak: 'break-all' }),
        className,
      )}
    >
      {value}
    </code>
  );
}
