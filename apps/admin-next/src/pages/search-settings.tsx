import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SearchSettingsForm } from '@/components/search-settings/settings-form.tsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/errors';
import { getSearchConfig, type SearchConfigView } from '@/lib/api/search.ts';

const searchConfigQuery = {
  queryKey: ['search-config'] as const,
  queryFn: getSearchConfig,
};

export default function SearchSettingsPage(): React.ReactElement {
  const { t } = useTranslation();
  const config = useQuery(searchConfigQuery);
  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{t('search.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('search.description')}</p>
      </div>
      <Alert>
        <AlertTitle>{t('search.warningTitle')}</AlertTitle>
        <AlertDescription>{t('search.warningBody')}</AlertDescription>
      </Alert>
      {config.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : config.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{errorMessage(config.error)}</p>
          <Button variant="outline" onClick={() => void config.refetch()}>
            {t('common.reload')}
          </Button>
        </div>
      ) : (
        <SearchSettingsForm key={config.data.revision} initial={config.data as SearchConfigView} />
      )}
    </div>
  );
}
