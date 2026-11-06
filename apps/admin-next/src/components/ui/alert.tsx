import { Alert as KoiAlert } from '@tuuject/koi-react/alert';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Koi Alert under the old composition API. The destructive variant maps to
 * Koi's error tone; AlertTitle / AlertDescription stay plain blocks because
 * the existing call sites compose arbitrary interactive content inside them.
 */
function Alert({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & { readonly variant?: 'default' | 'destructive' }): React.ReactElement {
  // The pre-Koi alert was always role="alert"; keep that for inline page errors
  // and make the tone only change the palette.
  return (
    <KoiAlert tone={variant === 'destructive' ? 'error' : 'info'} role="alert" className={cn(className)} {...props} />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
