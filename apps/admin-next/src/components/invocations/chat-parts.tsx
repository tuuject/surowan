import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { NextIcon } from '@/components/icons.tsx';

/**
 * The shared anatomy of an Overview item below its content: one meta line (the
 * time first, then the facts, then the toggles) and, under it, the panels the
 * toggles opened. Every message, reply and step uses it, so their meta lines
 * share one size, one gap and one edge.
 */

export interface DisclosurePart {
  readonly key: string;
  readonly label: string;
  readonly render: () => ReactNode;
}

const metaRowClass = css({
  textStyle: 'small',
  color: 'text-muted',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: '3',
  rowGap: '1',
  minWidth: '0',
  // A 36px icon control (copy an id) must not make its line taller than the
  // others, nor leave a wider gap after it than before it.
  '& button:not([aria-expanded])': { marginBlock: '-2', marginInlineEnd: '-2' },
});

const toggleClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '1',
  color: 'text-muted',
  cursor: 'pointer',
  borderRadius: 'lg',
  transitionProperty: 'color',
  transitionDuration: 'fast',
  _hover: { color: 'text' },
  _focusVisible: { outline: '2px solid', outlineColor: 'focus-ring', outlineOffset: '2px' },
  '&[aria-expanded=true]': { color: 'text' },
});

// Closed it points along the reading direction, open it points down; `rotate`
// composes with the RTL mirror, which is a transform.
const chevronClass = css({
  flexShrink: '0',
  transitionProperty: 'rotate',
  transitionDuration: 'token(durations.check)',
  transitionTimingFunction: 'token(easings.spring)',
  '[aria-expanded=true] > &': { rotate: '90deg' },
  '[dir="rtl"] [aria-expanded=true] > &': { rotate: '-90deg' },
  '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
});

/**
 * A meta line with its toggles and their panels. A panel mounts on its first
 * open and stays mounted while closed, so an expanded JSON tree keeps its state.
 */
export function ItemMeta({
  meta,
  parts = [],
  align = 'start',
}: {
  readonly meta: ReactNode;
  readonly parts?: readonly DisclosurePart[];
  readonly align?: 'start' | 'end';
}): ReactElement {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string): void => {
    const next = new Set(open);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      setMounted(new Set(mounted).add(key));
    }
    setOpen(next);
  };
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '2', width: '100%', minWidth: '0' })}>
      <div className={cx(metaRowClass, css({ justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }))}>
        {meta}
        {parts.map((part) => (
          <button
            key={part.key}
            type="button"
            className={toggleClass}
            aria-expanded={open.has(part.key)}
            aria-controls={`${id}-${part.key}`}
            onClick={() => toggle(part.key)}
          >
            <NextIcon size={sizes['icon-xs']} className={chevronClass} />
            {part.label}
          </button>
        ))}
      </div>
      {parts.map((part) =>
        mounted.has(part.key) ? (
          <section
            key={part.key}
            id={`${id}-${part.key}`}
            aria-label={part.label}
            hidden={!open.has(part.key)}
            className={cx(
              css({ width: '100%', minWidth: '0' }),
              // On the bot's side a panel hangs under its reply, as wide as a bubble can be.
              align === 'end' ? css({ alignSelf: 'flex-end', maxWidth: '480px' }) : undefined,
            )}
          >
            {part.render()}
          </section>
        ) : null,
      )}
    </div>
  );
}
