import { Textarea as KoiTextarea } from '@tuuject/koi-react/textarea';
import type * as React from 'react';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.ReactElement {
  return <KoiTextarea {...props} className={className} />;
}

export { Textarea };
