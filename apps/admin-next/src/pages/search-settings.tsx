import { useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Button } from '@tuuject/koi-react/button';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { SearchSettingsForm } from '@/components/search-settings/settings-form.tsx';
import { getSearchConfig, type SearchConfigView } from '@/lib/api/search.ts';
import { errorMessage } from '@/lib/errors';

const searchConfigQuery = {
  queryKey: ['search-config'] as const,
  queryFn: getSearchConfig,
};

export default function SearchSettingsPage(): React.ReactElement {
  const { t } = useTranslation();
  const config = useQuery(searchConfigQuery);
  return (
    <div className={css({ '& > :not(:last-child)': { marginBlockEnd: '5' } })}>
      <ListPageHeader title={t('search.title')} description={t('search.description')} />
      <Alert tone="info" title={t('search.warningTitle')}>
        {t('search.warningBody')}
      </Alert>
      {config.isPending ? (
        <Skeleton className={css({ height: '256px', width: '100%' })} />
      ) : config.isError ? (
        <Alert
          tone="error"
          action={
            <Button size="sm" variant="ghost" color="secondary" onClick={() => void config.refetch()}>
              {t('common.reload')}
            </Button>
          }
        >
          {errorMessage(config.error)}
        </Alert>
      ) : (
        <SearchSettingsForm key={config.data.revision} initial={config.data as SearchConfigView} />
      )}
    </div>
  );
}
