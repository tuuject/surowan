import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProviderBadges } from '@/components/models/provider-list';
import { Button } from '@/components/ui/button';

import { providerUsage } from '@/lib/model-manager.ts';
import type { ProviderView, ProvidersView } from '@/lib/api/providers.ts';

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
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-base font-semibold">{provider.alias}</h2>
        <span className="text-muted-foreground text-xs">{provider.kind}</span>
        <ProviderBadges view={view} provider={provider} />
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        disabled={providerUsage(view, provider.alias).agent || providerUsage(view, provider.alias).vision}
        onClick={onDelete}
      >
        <Trash2 />
        {t('models.models.page.deleteProvider')}
      </Button>
    </div>
  );
}
