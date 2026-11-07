import { css, cx } from '@tuuject/koi-react/styled-system/css';
import type * as React from 'react';

const labelClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '2',
  textStyle: 'label',
  lineHeight: 'none',
  color: 'text',
  userSelect: 'none',
  cursor: 'default',
});

/** A plain label with Koi's label typography; controls in Koi Fields still get their own Field label. */
function Label({ className, ...props }: React.ComponentProps<'label'>): React.ReactElement {
  // Some call sites wrap their radio/checkbox directly; the linter can't see that association.
  // biome-ignore lint/a11y/noLabelWithoutControl: a wrapped control is a valid label association
  return <label className={cx(labelClass, className)} {...props} />;
}

export { Label };
