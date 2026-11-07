import { Button } from '@tuuject/koi-react/button';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement, ReactNode } from 'react';
import { SAFE_BOTTOM } from '@/components/app-shell/shared';

/** Above the page, below the sticky header (40) and Koi's overlays: the template's sectioned-form layer. */
const STICKY_Z_INDEX = 30;

/**
 * The save bar at the bottom of a long settings form, drawn like the Koi admin
 * template's FormActionBar: sticky rather than fixed, so it floats over the
 * sections while they scroll and settles into its own space after the last
 * one; floating chrome (glass tint, `float` shadow, 24px corners concentric
 * with its 16px padding around md buttons).
 */
export function FormActionBar({
  status,
  error,
  submitLabel,
  submittingLabel,
  submitting,
  submitDisabled = false,
  submitType = 'submit',
  onSubmit,
  discardLabel,
  onDiscard,
  discardDisabled = false,
}: {
  /** What is pending: "3 unsaved changes", "Nothing to save", a validation hint. */
  readonly status: ReactNode;
  /** Why the last save failed; the edits stay in the form. */
  readonly error?: ReactNode;
  readonly submitLabel: string;
  readonly submittingLabel?: string;
  readonly submitting: boolean;
  readonly submitDisabled?: boolean;
  readonly submitType?: 'submit' | 'button';
  readonly onSubmit?: () => void;
  readonly discardLabel?: string;
  readonly onDiscard?: () => void;
  readonly discardDisabled?: boolean;
}): ReactElement {
  return (
    <div
      className={css({
        position: 'sticky',
        bottom: `calc(token(spacing.4) + ${SAFE_BOTTOM})`,
        zIndex: STICKY_Z_INDEX,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '2',
        marginBlockStart: '6',
        padding: '4',
        borderRadius: 'panel',
        bg: 'surface-glass-tint',
        backdropFilter: 'blur(var(--blurs-float))',
        boxShadow: 'float',
      })}
    >
      <div className={css({ flex: '1 1 auto', minWidth: '0', paddingInline: '4' })}>
        {/* Always mounted, so screen readers hear the status change. */}
        <span role="status" className={css({ color: 'text-muted' })}>
          {status}
        </span>
        {error === undefined || error === null ? null : (
          <p role="alert" className={css({ margin: '0', color: 'error-fg', overflowWrap: 'anywhere' })}>
            {error}
          </p>
        )}
      </div>
      <div className={css({ display: 'flex', gap: '2', marginInlineStart: 'auto' })}>
        {discardLabel === undefined || onDiscard === undefined ? null : (
          <Button variant="ghost" color="secondary" disabled={discardDisabled || submitting} onClick={onDiscard}>
            {discardLabel}
          </Button>
        )}
        <Button
          type={submitType}
          loading={submitting}
          {...(submittingLabel === undefined ? {} : { loadingLabel: submittingLabel })}
          disabled={submitDisabled}
          {...(onSubmit === undefined ? {} : { onClick: onSubmit })}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
