import type React from 'react';
import { css, cx } from '@tuuject/koi-react/styled-system/css';

/**
 * A plain Koi content section with a title, optional description and action.
 * It deliberately has no Card surface, radius or floating shadow: only query
 * filters use ListFilterCard. `flush` is retained as a layout hint for tables.
 */
export function Panel({
  title,
  description,
  action,
  flush = false,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: React.ReactNode;
  readonly flush?: boolean;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <section
      aria-label={title}
      className={cx(
        css({
          '& > :not(:last-child)': { marginBlockEnd: '4' },
          borderTopWidth: '1px',
          borderColor: 'divider',
          paddingBlockStart: '4',
        }),
        className,
      )}
    >
      <div
        className={css({
          display: 'flex',
          minHeight: 'control-md',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '3',
        })}
      >
        <div className={css({ minWidth: '0', '& > :not(:last-child)': { marginBlockEnd: '1' } })}>
          <h2 className={css({ textStyle: 'heading-3', overflowWrap: 'anywhere' })}>{title}</h2>
          {description === undefined ? null : (
            <p className={css({ textStyle: 'body', color: 'text-muted', overflowWrap: 'anywhere' })}>{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className={cx(flush && css({ minWidth: '0' }))}>{children}</div>
    </section>
  );
}
