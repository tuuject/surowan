import { useQuery } from '@tanstack/react-query';
import { Alert } from '@tuuject/koi-react/alert';
import { Empty } from '@tuuject/koi-react/empty';
import { PlusIcon } from '@tuuject/koi-react/icons';
import { Skeleton } from '@tuuject/koi-react/skeleton';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { ListPageHeader } from '@/components/business';
import { ModelsPageError } from '@/components/models/models-page-states';
import { ProvidersRestartBanner } from '@/components/models/restart-banner';
import { RoleCards } from '@/components/models/roles/cards';
import { ThinkingResetDialog } from '@/components/models/roles/thinking-reset-dialog';
import { useModelRoleWrites } from '@/components/models/roles/writes';
import { ButtonLink } from '@/components/router-links';
import { errorMessage } from '@/lib/errors.ts';
import { providersQuery } from '@/lib/queries.ts';

/**
 * The Models page: which model does each of the bot's jobs (Agent, Vision,
 * Tool) and the thinking effort it runs at. It only reads the provider list;
 * adding providers and models happens on the Providers page.
 */
export default function ModelsPage(): React.ReactElement {
  const { t } = useTranslation();
  const providers = useQuery(providersQuery);
  const view = providers.data;
  const writes = useModelRoleWrites(view);

  const manageProviders = (
    <ButtonLink to="/providers" variant="outline" color="secondary">
      {t('models.models.roles.manageProviders')}
    </ButtonLink>
  );

  return (
    <div className={css({ maxWidth: '768px', marginInline: 'auto', '& > * + *': { marginBlockStart: '6' } })}>
      <ListPageHeader
        title={t('layout.nav.models')}
        description={t('models.models.roles.pageDescription')}
        actions={view === undefined || view.providers.length === 0 ? undefined : manageProviders}
      />
      {providers.isPending ? (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '6' })}>
          {['agent', 'vision', 'tool'].map((key) => (
            <Skeleton key={key} className={css({ height: '176px', width: '100%', borderRadius: 'panel' })} />
          ))}
        </div>
      ) : view === undefined ? (
        <ModelsPageError error={providers.error} />
      ) : (
        <>
          {providers.isError ? <Alert tone="error">{errorMessage(providers.error)}</Alert> : null}
          <ProvidersRestartBanner view={view} />
          {view.providers.length === 0 ? (
            <Empty
              title={t('models.models.roles.noProvidersTitle')}
              description={t('models.models.roles.noProvidersDescription')}
              action={
                <ButtonLink to="/providers" iconStart={<PlusIcon />}>
                  {t('models.models.roles.addProvider')}
                </ButtonLink>
              }
            />
          ) : (
            <RoleCards view={view} writes={writes} />
          )}
          <ThinkingResetDialog resets={writes.thinkingResets} onClose={writes.closeThinkingResets} />
        </>
      )}
    </div>
  );
}
