import { ErrorIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';

export function SectionMarks({
  invalid,
  changed,
  labels,
}: {
  readonly invalid: boolean;
  readonly changed: boolean;
  readonly labels: { readonly invalid: string; readonly changed: string };
}) {
  return (
    <>
      {invalid ? (
        <>
          <ErrorIcon size={sizes['icon-sm']} className={css({ flex: 'none', color: 'error-text' })} />
          <span className={css({ srOnly: true })}>{labels.invalid}</span>
        </>
      ) : null}
      {changed ? (
        <>
          <span
            aria-hidden="true"
            className={css({ flex: 'none', width: '6px', height: '6px', borderRadius: 'full', bg: 'text-brand' })}
          />
          <span className={css({ srOnly: true })}>{labels.changed}</span>
        </>
      ) : null}
    </>
  );
}
