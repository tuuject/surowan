import { Empty } from '@tuuject/koi-react/empty';
import { ErrorIcon, SearchIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { ButtonLink } from '@/components/router-links';
import { ApiError } from '@/lib/api/core.ts';
import { errorMessage } from '@/lib/errors';

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

export function DetailSkeleton(): ReactElement {
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

export function DetailError({ error, notFoundTitle, failedTitle, backTo, backLabel }: DetailErrorProps): ReactElement {
  const apiError = error instanceof ApiError ? error : null;
  const notFound = apiError?.status === 404;
  return (
    <Empty
      icon={notFound ? <SearchIcon /> : <ErrorIcon />}
      title={notFound ? notFoundTitle : failedTitle}
      description={<span className={css({ overflowWrap: 'anywhere' })}>{errorMessage(error)}</span>}
      action={
        <ButtonLink to={backTo} variant="outline" color="secondary">
          {backLabel}
        </ButtonLink>
      }
    />
  );
}
