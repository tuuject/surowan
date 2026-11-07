import { Button } from '@tuuject/koi-react/button';
import { TrashIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { ProviderBadges } from '@/components/models/provider-list';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { providerUsage } from '@/lib/model-manager.ts';

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
  const usage = providerUsage(view, provider.alias);
  return (
    <div
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '3',
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3', minWidth: '0' })}>
        <h2 className={css({ margin: '0', textStyle: 'heading-2', overflowWrap: 'anywhere' })}>{provider.alias}</h2>
        <span className={css({ color: 'text-muted' })}>{provider.kind}</span>
        <ProviderBadges view={view} provider={provider} />
      </div>
      <Button
        variant="ghost"
        color="error"
        disabled={usage.agent || usage.vision}
        onClick={onDelete}
        iconStart={<TrashIcon />}
      >
        {t('models.models.page.deleteProvider')}
      </Button>
    </div>
  );
}
