import { css, cx } from '@tuuject/koi-react/styled-system/css';
import { empty } from '@tuuject/koi-react/styled-system/recipes';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const rootClass = css({
  display: 'flex',
  minWidth: '0',
  flex: '1',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '3',
  textAlign: 'center',
  textWrap: 'balance',
});

function Empty({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cx(empty({ variant: 'plain' }).root, rootClass, className)} {...props} />;
}

function EmptyHeader({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('flex max-w-sm flex-col items-center gap-2 text-center', className)} {...props} />;
}

function EmptyMedia({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & { readonly variant?: 'default' | 'icon' }): React.ReactElement {
  return (
    <div
      className={cn(
        'mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
        variant === 'icon' && 'bg-muted size-10 rounded-lg [&_svg:not([class*=size-])]:size-6',
        className,
      )}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('text-lg font-medium tracking-tight', className)} {...props} />;
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'p'>): React.ReactElement {
  return <div className={cn('text-muted-foreground text-sm/relaxed', className)} {...props} />;
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      className={cn('flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance', className)}
      {...props}
    />
  );
}

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
