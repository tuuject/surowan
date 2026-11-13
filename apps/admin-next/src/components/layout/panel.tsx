import { Card } from '@tuuject/koi-react/card';
import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import { type ReactElement, useId } from 'react';

/**
 * One named area of a dashboard, settings or detail page. Independent summaries
 * and settings groups use a Koi Card; sections of one continuous workspace use
 * the plain variant and let spacing or dividers establish their hierarchy.
 * Never nest Cards. The title names the region for assistive navigation.
 */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  headingTabIndex,
  variant = 'card',
}: {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly className?: string;
  readonly headingTabIndex?: number;
  readonly variant?: 'card' | 'plain';
}): ReactElement {
  const titleId = useId();
  const Root = variant === 'plain' ? 'section' : Card;
  return (
    <Root role="region" aria-labelledby={titleId} className={cx(css({ minWidth: '0' }), className)}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '5', minWidth: '0' })}>
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3' })}>
          <div
            className={css({ display: 'flex', flexDirection: 'column', gap: '1', flex: '1 1 240px', minWidth: '0' })}
          >
            <h2
              id={titleId}
              tabIndex={headingTabIndex}
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
    </Root>
  );
}
