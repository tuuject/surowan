import { css } from '@tuuject/koi-react/styled-system/css';
import type React from 'react';
import type { ReactElement } from 'react';
import { ProviderBadges } from '@/components/models/provider-list';
import type { ProvidersView, ProviderView } from '@/lib/api/providers.ts';
import { providerKindLabel } from '@/lib/model-manager.ts';

/**
 * The selected provider's title bar. Actions on the whole provider sit here,
 * apart from the sections' own Save and model actions, and the hairline below
 * sets the provider above its sections.
 */
export function ProviderDetailHeader({
  view,
  provider,
  action,
}: {
  readonly view: ProvidersView;
  readonly provider: ProviderView;
  readonly action?: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '3',
        minWidth: '0',
        paddingBlockEnd: '6',
        borderBottomWidth: '1px',
        borderColor: 'divider',
      })}
    >
      <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3', minWidth: '0' })}>
        <h2 className={css({ margin: '0', textStyle: 'heading-2', overflowWrap: 'anywhere' })}>{provider.alias}</h2>
        <span className={css({ color: 'text-muted' })}>{providerKindLabel(provider.kind)}</span>
        <ProviderBadges view={view} provider={provider} />
      </div>
      {action === undefined ? null : (
        <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>{action}</div>
      )}
    </div>
  );
}
