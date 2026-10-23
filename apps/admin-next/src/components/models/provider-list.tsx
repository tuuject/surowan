import { useTranslation } from 'react-i18next';
import { MonoValue, ToneBadge } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { providerUsage } from '@/lib/model-manager.ts';
import { cn } from '@/lib/utils';
import type { ProviderView, ProvidersView } from '@/lib/api/providers.ts';

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
    <span className="flex flex-wrap items-center gap-1">
      {usage.agent ? <ToneBadge tone="success">{t('models.models.page.agentInUse')}</ToneBadge> : null}
      {usage.vision ? <ToneBadge tone="info">{t('models.models.page.visionInUse')}</ToneBadge> : null}
    </span>
  );
}

/** The provider sidebar: a search box over the providers the config declares. */
export function ProviderListPanel({
  view,
  listed,
  selected,
  search,
  onSearchChange,
  onSelect,
  onNewProvider,
}: {
  readonly view: ProvidersView;
  readonly listed: readonly ProviderView[];
  readonly selected: ProviderView | null;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly onSelect: (alias: string) => void;
  readonly onNewProvider: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Panel
      title={t('models.models.page.providersTitle')}
      className="self-start"
      action={
        <Button type="button" size="sm" onClick={onNewProvider}>
          {t('models.models.page.newProvider')}
        </Button>
      }
    >
      <div className="space-y-3">
        <Input
          aria-label={t('models.models.page.searchProviders')}
          placeholder={t('models.models.page.searchProviders')}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {view.providers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('models.models.page.noProviders')}</p>
        ) : listed.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('models.models.page.noMatchingProviders')}</p>
        ) : (
          <ul className="space-y-0.5">
            {listed.map((provider) => {
              const active = selected !== null && selected.alias === provider.alias;
              return (
                <li key={provider.alias}>
                  {/* No border: the panel is already the frame, and a box per
                      row would nest one inside it. */}
                  <button
                    type="button"
                    aria-label={t('models.models.page.providerAria', { alias: provider.alias })}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'w-full space-y-1 rounded-lg px-3 py-2 text-left transition-colors',
                      active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                    onClick={() => onSelect(provider.alias)}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <MonoValue value={provider.alias} />
                      <span className="text-muted-foreground text-xs">{provider.kind}</span>
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {provider.provider ?? provider.base_url}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ProviderBadges view={view} provider={provider} />
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {t(
                          provider.models.length === 1
                            ? 'models.models.page.oneModel'
                            : 'models.models.page.manyModels',
                          { count: provider.models.length },
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
