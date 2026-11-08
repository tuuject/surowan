import { Button, IconButton } from '@tuuject/koi-react/button';
import { PlusIcon, SearchIcon } from '@tuuject/koi-react/icons';
import { Input } from '@tuuject/koi-react/input';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRing } from '@/components/app-shell/shared';
import { MonoValue, ToneBadge } from '@/components/business';
import { BrainIcon, EyeIcon, RefreshIcon, ResetIcon, WrenchIcon } from '@/components/icons';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { providerUsage } from '@/lib/model-manager.ts';

/** Which slots the provider currently serves, as text badges or bare status icons. */
export function ProviderBadges({
  view,
  provider,
  variant = 'text',
}: {
  readonly view: ProvidersView;
  readonly provider: ProviderView;
  /** `icons` keeps the provider rail compact; the row's description carries the words. */
  readonly variant?: 'text' | 'icons';
}): ReactElement {
  const { t } = useTranslation();
  const usage = providerUsage(view, provider.alias);
  if (variant === 'icons') {
    return (
      <span aria-hidden="true" className={css({ display: 'flex', alignItems: 'center', gap: '1', color: 'text' })}>
        {usage.agent ? <BrainIcon size={sizes.icon} /> : null}
        {usage.vision ? <EyeIcon size={sizes.icon} /> : null}
        {usage.tool ? <WrenchIcon size={sizes.icon} /> : null}
      </span>
    );
  }
  return (
    <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1' })}>
      {/* Neutral, not primary: the provider rows can be the active row, whose fill would swallow a primary badge. */}
      {usage.agent ? <ToneBadge tone="neutral">{t('models.models.page.agentInUse')}</ToneBadge> : null}
      {usage.vision ? <ToneBadge tone="neutral">{t('models.models.page.visionInUse')}</ToneBadge> : null}
      {usage.tool ? <ToneBadge tone="neutral">{t('models.models.page.toolInUse')}</ToneBadge> : null}
    </span>
  );
}

/** Whether the provider backs one of the three configured slots. */
function servesASlot(view: ProvidersView, alias: string): boolean {
  return (
    view.agent.provider === alias ||
    view.vision.provider === alias ||
    (!view.tool_model.inherited && view.tool_model.provider === alias)
  );
}

/**
 * The provider selector: a search box and the registry split into the
 * providers that currently serve a slot and the rest. Selecting a row is the
 * only navigation on the page; the detail beside it owns every write.
 */
export function ProviderRail({
  view,
  listed,
  selected,
  search,
  onSearch,
  onSelect,
  onNewProvider,
  onRefresh,
  refreshing,
}: {
  readonly view: ProvidersView;
  readonly listed: readonly ProviderView[];
  readonly selected: ProviderView | null;
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onSelect: (alias: string) => void;
  readonly onNewProvider: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const serving = listed.filter((provider) => servesASlot(view, provider.alias));
  const idle = listed.filter((provider) => !servesASlot(view, provider.alias));

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '4', minWidth: '0' })}>
      <ProviderSearch search={search} onSearch={onSearch} onRefresh={onRefresh} refreshing={refreshing} />
      <nav aria-label={t('models.models.page.providersTitle')}>
        {listed.length === 0 ? (
          <p className={css({ margin: '0', paddingInline: '4', paddingBlock: '3', color: 'text-muted' })}>
            {view.providers.length === 0
              ? t('models.models.page.noProviders')
              : t('models.models.page.noMatchingProviders')}
          </p>
        ) : (
          <>
            {serving.length === 0 ? null : (
              <ProviderGroup label={t('models.models.page.providerGroupInUse')} count={serving.length}>
                {serving.map((provider) => (
                  <ProviderRow
                    key={provider.alias}
                    view={view}
                    provider={provider}
                    selected={selected?.alias === provider.alias}
                    onSelect={onSelect}
                  />
                ))}
              </ProviderGroup>
            )}
            {idle.length === 0 ? null : (
              <ProviderGroup label={t('models.models.page.providerGroupOther')} count={idle.length}>
                {idle.map((provider) => (
                  <ProviderRow
                    key={provider.alias}
                    view={view}
                    provider={provider}
                    selected={selected?.alias === provider.alias}
                    onSelect={onSelect}
                  />
                ))}
              </ProviderGroup>
            )}
          </>
        )}
      </nav>
      <Button variant="outline" iconStart={<PlusIcon />} onClick={onNewProvider} className={css({ width: '100%' })}>
        {t('models.models.page.newProvider')}
      </Button>
    </div>
  );
}

/** Applied conditions stay in the URL; the field edits a draft until Enter. */
function ProviderSearch({
  search,
  onSearch,
  onRefresh,
  refreshing,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(search);
  const [seen, setSeen] = useState(search);
  if (search !== seen) {
    setSeen(search);
    setDraft(search);
  }

  return (
    <form
      className={css({ display: 'flex', alignItems: 'center', gap: '2' })}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft);
      }}
    >
      <Input
        className={css({ flex: '1', minWidth: '0' })}
        aria-label={t('models.models.page.searchProviders')}
        placeholder={t('models.models.page.searchProviders')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        iconStart={<SearchIcon />}
      />
      {search.length === 0 ? null : (
        <IconButton
          type="button"
          variant="ghost"
          color="secondary"
          label={t('layout.business.clearFilter')}
          icon={<ResetIcon />}
          onClick={() => {
            setDraft('');
            onSearch('');
          }}
        />
      )}
      <IconButton
        type="button"
        variant="ghost"
        color="secondary"
        label={t('layout.business.refreshList')}
        icon={<RefreshIcon />}
        disabled={refreshing}
        onClick={onRefresh}
      />
    </form>
  );
}

function ProviderGroup({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly children: React.ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className={css({ paddingBlock: '1' })}>
      <p
        id={id}
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '2',
          margin: '0',
          paddingInline: '3',
          paddingBlock: '1',
          textStyle: 'small',
          color: 'text-muted',
        })}
      >
        <span>{label}</span>
        <span className={css({ fontVariantNumeric: 'tabular-nums' })}>{count}</span>
      </p>
      <ul className={css({ display: 'flex', flexDirection: 'column', gap: '1', margin: '0', padding: '0' })}>
        {children}
      </ul>
    </section>
  );
}

function ProviderRow({
  view,
  provider,
  selected,
  onSelect,
}: {
  readonly view: ProvidersView;
  readonly provider: ProviderView;
  readonly selected: boolean;
  readonly onSelect: (alias: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const usage = providerUsage(view, provider.alias);
  const usageText = [
    usage.agent ? t('models.models.page.agentInUse') : null,
    usage.vision ? t('models.models.page.visionInUse') : null,
    usage.tool ? t('models.models.page.toolInUse') : null,
  ]
    .filter((item): item is string => item !== null)
    .join(', ');
  const usageId = useId();
  return (
    <li className={css({ listStyle: 'none' })}>
      <button
        type="button"
        aria-label={t('models.models.page.providerAria', { alias: provider.alias })}
        aria-describedby={usageText.length === 0 ? undefined : usageId}
        aria-pressed={selected}
        onClick={() => onSelect(provider.alias)}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '1',
          width: '100%',
          padding: '3',
          border: 'none',
          borderRadius: 'xl',
          bg: 'transparent',
          color: 'nav-item-text',
          textAlign: 'left',
          cursor: 'pointer',
          transitionProperty: 'background-color, color',
          transitionDuration: 'fast',
          _hover: { bg: 'nav-item-hover' },
          _focusVisible: focusRing,
          '&[aria-pressed=true]': { bg: 'nav-item-active', color: 'text' },
        })}
      >
        <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
          <span className={css({ minWidth: '0', overflowWrap: 'anywhere' })}>
            <MonoValue value={provider.alias} />
          </span>
          <ProviderBadges view={view} provider={provider} variant="icons" />
        </span>
        <span
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: '2',
            rowGap: '1',
            textStyle: 'small',
            color: 'text-muted',
          })}
        >
          <span>{provider.kind}</span>
          <span>
            {t(provider.models.length === 1 ? 'models.models.page.oneModel' : 'models.models.page.manyModels', {
              count: provider.models.length,
            })}
          </span>
        </span>
      </button>
      {usageText.length === 0 ? null : (
        <span id={usageId} className={css({ srOnly: true })}>
          {usageText}
        </span>
      )}
    </li>
  );
}
