import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement } from 'react';
import { ProviderBadges } from '@/components/models/provider-list';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';

/** The selected provider's title row; the destructive action sits at the bottom of the detail. */
export function ProviderDetailHeader({
  view,
  provider,
}: {
  readonly view: ProvidersView;
  readonly provider: ProviderView;
}): ReactElement {
  return (
    <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3', minWidth: '0' })}>
      <h2 className={css({ margin: '0', textStyle: 'heading-2', overflowWrap: 'anywhere' })}>{provider.alias}</h2>
      <span className={css({ color: 'text-muted' })}>{provider.kind}</span>
      <ProviderBadges view={view} provider={provider} />
    </div>
  );
}
