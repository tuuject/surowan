import { Switch as KoiSwitch } from '@tuuject/koi-react/switch';
import type * as React from 'react';

interface SwitchProps
  extends Omit<
    React.ComponentProps<'button'>,
    'children' | 'onChange' | 'value' | 'defaultValue' | 'type' | 'name' | 'form' | 'required'
  > {
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly name?: string;
}

function Switch({ onCheckedChange, ...props }: SwitchProps): React.ReactElement {
  return <KoiSwitch {...props} {...(onCheckedChange !== undefined ? { onCheckedChange } : {})} />;
}

export { Switch };
