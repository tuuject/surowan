import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The panel surface: Koi's semantic colours and panel radius (mapped onto the
 * Tailwind theme variables in globals.css) with the layout spacing the existing
 * pages already declare. Kept as composition-friendly slots because the pages
 * use CardHeader/CardContent independently; Koi's Card component owns its
 * padding and cannot host those variants without changing every call site.
 */
function Card({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      data-slot="card"
      className={cn(
        'border-border bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('flex flex-col gap-2 px-6', className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('text-base leading-tight font-semibold', className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('text-muted-foreground text-sm', className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('px-6', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  return <div className={cn('flex items-center px-6', className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
