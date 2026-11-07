import { TrashIcon } from '@tuuject/koi-react/icons';
import { useTranslation } from 'react-i18next';
import { ProviderBadges } from '@/components/models/provider-list';
import { Button } from '@tuuject/koi-react/button';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { providerUsage } from '@/lib/model-manager.ts';
import { css } from '@tuuject/koi-react/styled-system/css';

/** The selected provider's title row, with the delete action that removes it. */
export function ProviderDetailHeader({
  view,
  provider,
  onDelete,
}: {
  readonly view: ProvidersView;
  readonly provider: ProviderView;
  readonly onDelete: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={css({
        display: 'flex',
        minHeight: 'control-md',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '3',
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
        <h2 className={css({ textStyle: 'heading-3', fontFamily: 'mono' })}>{provider.alias}</h2>
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>{provider.kind}</span>
        <ProviderBadges view={view} provider={provider} />
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        color="secondary"
        className={css({ color: 'text-muted', _hover: { color: 'error-text' } })}
        disabled={providerUsage(view, provider.alias).agent || providerUsage(view, provider.alias).vision}
        onClick={onDelete}
        iconStart={<TrashIcon />}
      >
        {t('models.models.page.deleteProvider')}
      </Button>
    </div>
  );
}
