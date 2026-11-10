import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, type ReactNode, useId } from 'react';

/**
 * A setting that applies on its own (a Switch, a short Select): label and
 * description on the left, the control on the right, as a Koi Field would
 * stack them but laid out for a list of toggles. The control gets the label
 * through `htmlFor` and the description through `aria-describedby`.
 */
export function SettingRow({
  label,
  description,
  hint,
  children,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** Small print under the description: defaults, side effects. */
  readonly hint?: ReactNode;
  readonly children: (ids: { readonly id: string; readonly describedBy: string | undefined }) => ReactNode;
}): ReactElement {
  const id = useId();
  const descriptionId = `${id}-description`;
  const hasText = description !== undefined || hint !== undefined;
  return (
    <div className={css({ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6' })}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', minWidth: '0' })}>
        <label htmlFor={id} className={css({ textStyle: 'label', color: 'text' })}>
          {label}
        </label>
        {hasText ? (
          <div id={descriptionId} className={css({ display: 'flex', flexDirection: 'column', gap: '1' })}>
            {description === undefined ? null : (
              <p className={css({ margin: '0', color: 'text-muted' })}>{description}</p>
            )}
            {hint === undefined ? null : (
              <p className={css({ margin: '0', textStyle: 'small', color: 'text-muted' })}>{hint}</p>
            )}
          </div>
        ) : null}
      </div>
      <div className={css({ flex: 'none', display: 'flex', alignItems: 'center', minHeight: 'control-sm' })}>
        {children({ id, describedBy: hasText ? descriptionId : undefined })}
      </div>
    </div>
  );
}
