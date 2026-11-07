import { Card } from '@tuuject/koi-react/card';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { useId } from 'react';

/**
 * One area of a dashboard, settings or detail page: a Koi Card (outlined,
 * 24px corners, no shadow) with an `h2` title, an optional one-line
 * description and the area's own controls on the right, as the template's
 * settings card and sectioned-form sections do. A list page's table sits on
 * the page instead; only a table that shares the page with other areas goes
 * in here. Never nest one Panel in another. The title names the Card as a
 * region, so assistive tech can jump between areas.
 */
export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} className={cx(css({ minWidth: '0' }), className)}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5', minWidth: '0' })}>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '3' })}>
          <div
            className={css({ display: 'flex', flexDirection: 'column', gap: '1', flex: '1 1 240px', minWidth: '0' })}
          >
            <h2
              id={titleId}
              className={css({ margin: '0', textStyle: 'heading-3', color: 'text', overflowWrap: 'anywhere' })}
            >
              {title}
            </h2>
            {description === undefined ? null : (
              <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted', overflowWrap: 'anywhere' })}>
                {description}
              </p>
            )}
          </div>
          {action === undefined ? null : (
            <div
              className={css({
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '2',
                flex: '0 1 auto',
                minWidth: '0',
              })}
            >
              {action}
            </div>
          )}
        </div>
        {children === null || children === undefined || children === false ? null : (
          <div className={css({ minWidth: '0' })}>{children}</div>
        )}
      </div>
    </Card>
  );
}
