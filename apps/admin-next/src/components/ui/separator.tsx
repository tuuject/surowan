import { Divider } from '@tuuject/koi-react/divider';
import type * as React from 'react';

function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  readonly orientation?: 'horizontal' | 'vertical';
  readonly decorative?: boolean;
}): React.ReactElement {
  return (
    <Divider
      orientation={orientation}
      {...(className === undefined ? {} : { className })}
      {...(props as React.ComponentProps<typeof Divider>)}
    />
  );
}

export { Separator };
