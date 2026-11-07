import type React from 'react';
import { cn } from '@/lib/utils';

/**
 * A plain Koi content section with a title, optional description and action.
 * It deliberately has no Card surface, radius or floating shadow: only query
 * filters use ListFilterCard. `flush` is retained as a layout hint for tables.
 */
export function Panel({
  title,
  description,
  action,
  flush = false,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: React.ReactNode;
  readonly flush?: boolean;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <section aria-label={title} className={cn('space-y-4 border-t pt-4', className)}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base leading-tight font-semibold break-words">{title}</h2>
          {description === undefined ? null : (
            <p className="text-muted-foreground text-sm break-words">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className={cn(flush && 'min-w-0')}>{children}</div>
    </section>
  );
}
