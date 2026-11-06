import { Skeleton as KoiSkeleton } from '@tuuject/koi-react/skeleton';
import type * as React from 'react';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <KoiSkeleton className={className} {...props} />;
}

export { Skeleton };
