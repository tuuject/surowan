import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/errors.ts';

/** Placeholder while the provider view loads. */
export function ModelsPageLoading(): React.ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** The provider view could not be read. */
export function ModelsPageError({ error }: { readonly error: unknown }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="p-6 text-center">
      <p className="text-destructive font-medium">{t('models.models.page.loadFailed')}</p>
      <p className="text-muted-foreground text-sm break-words">{errorMessage(error)}</p>
    </div>
  );
}
