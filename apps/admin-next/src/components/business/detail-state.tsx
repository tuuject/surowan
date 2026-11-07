import { Link } from '@tanstack/react-router';
import type React from 'react';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { ApiError } from '@/lib/api/core.ts';
import { errorMessage } from '@/lib/errors';
import { css } from '@tuuject/koi-react/styled-system/css';

/**
 * Shared detail-page state contract. The three detail pages
 * (invocation-detail, context-detail, message-detail) share the loading
 * skeleton and error state from here; the third state (data) stays with each
 * page, which renders its own fields once the query resolves.
 *
 * The state machine each detail page keeps using is unchanged:
 *
 *   isPending  -> <DetailSkeleton />
 *   isError    -> <DetailError error={error} ... />
 *   data is undefined -> <DetailError error={new Error('... data is missing')} ... />
 *   else       -> page content
 */

export function DetailSkeleton(): React.ReactElement {
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '4' } })}>
      <Skeleton className={css({ height: '160px', width: '100%', borderRadius: 'xl' })} />
      <Skeleton className={css({ height: '320px', width: '100%', borderRadius: 'xl' })} />
    </div>
  );
}

export interface DetailErrorProps {
  readonly error: unknown;
  readonly notFoundTitle: string;
  readonly failedTitle: string;
  readonly backTo: string;
  readonly backLabel: string;
}

export function DetailError({
  error,
  notFoundTitle,
  failedTitle,
  backTo,
  backLabel,
}: DetailErrorProps): React.ReactElement {
  const apiError = error instanceof ApiError ? error : null;
  const notFound = apiError?.status === 404;
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '2' }, padding: '6', textAlign: 'center' })}>
      <p className={css({ textStyle: 'label', color: 'error-text' })}>{notFound ? notFoundTitle : failedTitle}</p>
      <p className={css({ textStyle: 'body', color: 'text-muted', overflowWrap: 'anywhere' })}>{errorMessage(error)}</p>
      <Link
        to={backTo}
        className={css({
          textStyle: 'body',
          color: 'text-brand',
          display: 'inline-block',
          textUnderlineOffset: '4px',
          _hover: { textDecorationLine: 'underline' },
        })}
      >
        {backLabel}
      </Link>
    </div>
  );
}
