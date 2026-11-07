import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/errors.ts';

/** Placeholder while the provider view loads. */
export function ModelsPageLoading(): React.ReactElement {
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '6' } })}>
      <Skeleton className={css({ height: '80px', width: '100%', borderRadius: 'xl' })} />
      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: '6',
          '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0,18rem) minmax(0,1fr)' },
        })}
      >
        <Skeleton className={css({ height: '256px', width: '100%', borderRadius: 'xl' })} />
        <Skeleton className={css({ height: '256px', width: '100%', borderRadius: 'xl' })} />
      </div>
    </div>
  );
}

/** The provider view could not be read. */
export function ModelsPageError({ error }: { readonly error: unknown }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className={css({ padding: '6', textAlign: 'center' })}>
      <p className={css({ textStyle: 'label', color: 'error-text' })}>{t('models.models.page.loadFailed')}</p>
      <p className={css({ textStyle: 'body', color: 'text-muted', overflowWrap: 'anywhere' })}>{errorMessage(error)}</p>
    </div>
  );
}
