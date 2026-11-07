import { useTranslation } from 'react-i18next';
import {
  type ColumnSpec,
  ListFooter,
  MonoValue,
  TableShell,
  ToneBadge,
  useClientPagination,
} from '@/components/business';
import { Button } from '@tuuject/koi-react/button';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { providerUsage } from '@/lib/model-manager.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/** Which slots the provider currently serves. */
export function ProviderBadges({
  view,
  provider,
}: {
  readonly view: { readonly agent: { provider: string | null }; readonly vision: { provider: string | null } };
  readonly provider: ProviderView;
}): React.ReactElement {
  const { t } = useTranslation();
  const usage = providerUsage(view, provider.alias);
  return (
    <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
      {usage.agent ? <ToneBadge tone="success">{t('models.models.page.agentInUse')}</ToneBadge> : null}
      {usage.vision ? <ToneBadge tone="info">{t('models.models.page.visionInUse')}</ToneBadge> : null}
    </span>
  );
}

/** Providers use the same table hierarchy as the other configuration lists. */
export function ProviderListPanel({
  view,
  listed,
  selected,
  resetKey,
  onSelect,
}: {
  readonly view: ProvidersView;
  readonly listed: readonly ProviderView[];
  readonly selected: ProviderView | null;
  readonly resetKey: string;
  readonly onSelect: (alias: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const pagination = useClientPagination(listed, resetKey);
  const columns: readonly ColumnSpec<ProviderView>[] = [
    {
      key: 'provider',
      title: t('models.models.page.providerColumn'),
      render: (provider) => {
        const active = selected !== null && selected.alias === provider.alias;
        return (
          <Button
            type="button"
            variant={active ? 'soft' : 'ghost'}
            color="secondary"
            size="sm"
            aria-label={t('models.models.page.providerAria', { alias: provider.alias })}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(provider.alias)}
          >
            <MonoValue value={provider.alias} />
          </Button>
        );
      },
    },
    { key: 'kind', title: t('models.models.page.colType'), render: (provider) => provider.kind },
    {
      key: 'endpoint',
      title: t('models.models.page.colEndpoint'),
      render: (provider) => <MonoValue value={provider.provider ?? provider.base_url} />,
    },
    {
      key: 'usage',
      title: t('models.models.page.colInUse'),
      render: (provider) => (
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <ProviderBadges view={view} provider={provider} />
          <span className={css({ textStyle: 'small', color: 'text-muted', fontVariantNumeric: 'tabular-nums' })}>
            {t(provider.models.length === 1 ? 'models.models.page.oneModel' : 'models.models.page.manyModels', {
              count: provider.models.length,
            })}
          </span>
        </div>
      ),
    },
  ];

  return (
    <>
      <TableShell
        columns={columns}
        data={pagination.items}
        rowKey={(provider) => provider.alias}
        emptyText={
          view.providers.length === 0
            ? t('models.models.page.noProviders')
            : t('models.models.page.noMatchingProviders')
        }
      />
      <ListFooter
        count={pagination.total}
        page={pagination.page}
        pageCount={pagination.pageCount}
        onPageChange={pagination.onPageChange}
      />
    </>
  );
}
