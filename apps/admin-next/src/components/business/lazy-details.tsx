import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import type React from 'react';
import { type ReactElement, useState } from 'react';
import { disclosureChevronClass, NextIcon } from '@/components/icons';

/**
 * Native `<details>` disclosure whose children are mounted only after the first
 * expansion. A plain `<details>` renders its subtree eagerly (the browser just
 * hides it), which is expensive for heavy payloads such as `JsonViewer` trees
 * or long tool registries. The children stay mounted once opened so viewer
 * state (tree/text mode, expanded nodes) survives collapsing.
 *
 * The summary is a quiet muted row with a chevron that turns over on the
 * spring curve, like NavMenu's group toggles.
 */

export interface LazyDetailsProps {
  readonly summary: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export function LazyDetails({ summary, children, className }: LazyDetailsProps): ReactElement {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className={cx(css({ minWidth: '0' }), className)}
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
        }
      }}
    >
      <summary
        className={css({
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2',
          maxWidth: '100%',
          color: 'text-muted',
          cursor: 'pointer',
          listStyle: 'none',
          borderRadius: 'lg',
          transitionProperty: 'color',
          transitionDuration: 'fast',
          '&::-webkit-details-marker': { display: 'none' },
          _hover: { color: 'text' },
          _focusVisible: { outline: '2px solid', outlineColor: 'focus-ring', outlineOffset: '2px' },
        })}
      >
        <NextIcon size={sizes['icon-sm']} className={disclosureChevronClass} />
        {summary}
      </summary>
      {opened ? (
        <div className={css({ marginBlockStart: '2', minWidth: '0', overflowWrap: 'anywhere' })}>{children}</div>
      ) : null}
    </details>
  );
}
