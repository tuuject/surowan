import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement, ReactNode } from 'react';

/**
 * Bidi boundary rules for the panel.
 *
 * Technical strings (ids, keys, URLs, paths, headers, JSON, timestamps) are
 * left-to-right whatever the UI language is. Dropped into an Arabic sentence
 * unchanged, the bidi algorithm is free to reorder their punctuation
 * (`gpt-4o-mini` next to a colon, a `-1001…` chat id, `/api/models?v=2`), so
 * they are isolated — by markup (`bdi dir="ltr"`), never by invisible control
 * characters, so selecting and copying yields exactly the stored string.
 *
 * Free text of unknown direction (a memo, a Telegram message, a prompt) gets a
 * `dir="auto"` attribute at the element that renders it: the first strong
 * character decides, per string.
 */

const techClass = css({ unicodeBidi: 'isolate' });

/**
 * An isolated LTR technical string. `children` is optional so the component can
 * also be passed to react-i18next's `Trans`, which fills it from the sentence.
 */
export function TechText({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <bdi dir="ltr" className={cx(techClass, className)}>
      {children}
    </bdi>
  );
}
