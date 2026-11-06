import { Input as KoiInput } from '@tuuject/koi-react/input';
import type * as React from 'react';

/**
 * Koi's Input under the old call-site name. Koi wraps the native input so
 * width/height classes land on the wrapper; the control itself supplies the
 * Koi border, focus ring and invalid state.
 */
function Input({ className, ...props }: Omit<React.ComponentProps<'input'>, 'size'>): React.ReactElement {
  return (
    <KoiInput
      {...(props as unknown as React.ComponentProps<typeof KoiInput>)}
      {...(className === undefined ? {} : { className })}
    />
  );
}

export { Input };
