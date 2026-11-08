import { Button } from '@tuuject/koi-react/button';
import { CheckIcon } from '@tuuject/koi-react/icons';
import { css } from '@tuuject/koi-react/styled-system/css';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BrainIcon, EyeIcon, WrenchIcon } from '@/components/icons';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { isImageCapable, isTextCapable } from '@/lib/model-manager.ts';
import { type ModelRole, modelRoles } from './writes.ts';

const ROLES: readonly ModelRole[] = ['agent', 'vision', 'tool'];

const ROLE_ICONS = { agent: BrainIcon, vision: EyeIcon, tool: WrenchIcon } as const;

/**
 * "Use as" on a provider model row: one toggle per role the model can fill.
 * A pressed toggle is the role the model fills now; pressing another hands
 * that role to this model in one click. A role is taken away only by giving it
 * to another model (or, for the Tool Model, on the Models page), so pressing a
 * pressed toggle does nothing.
 */
export function RoleButtons({
  view,
  alias,
  config,
  pending,
  onAssign,
}: {
  readonly view: ProvidersView;
  readonly alias: string;
  readonly config: ProviderModelConfig;
  readonly pending: Readonly<Record<ModelRole, boolean>>;
  readonly onAssign: (role: ModelRole, alias: string, config: ProviderModelConfig) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const labelId = useId();
  const roles = modelRoles(view, alias, config.id);
  const capable: Readonly<Record<ModelRole, boolean>> = {
    agent: isTextCapable(config),
    vision: isImageCapable(config),
    tool: isTextCapable(config),
  };
  const offered = ROLES.filter((role) => capable[role]);
  if (offered.length === 0) {
    return null;
  }
  return (
    // A fieldset, so the toggles are announced as one named group; the name is
    // the span, since a legend does not lay out as a flex item.
    <fieldset
      aria-labelledby={labelId}
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '2',
        minWidth: '0',
        margin: '0',
        padding: '0',
        border: 'none',
      })}
    >
      <span id={labelId} className={css({ textStyle: 'small', color: 'text-muted', paddingInlineEnd: 2 })}>
        <span aria-hidden>{t('models.models.roles.useAs')}</span>
        <span className={css({ srOnly: true })}>{t('models.models.roles.useAsAria', { model: config.id })}</span>
      </span>
      {offered.map((role) => {
        const active = roles[role];
        const Icon = ROLE_ICONS[role];
        return (
          <Button
            key={role}
            size="sm"
            variant={active ? 'soft' : 'ghost'}
            color={active ? 'primary' : 'secondary'}
            aria-pressed={active}
            disabled={!active && pending[role]}
            iconStart={active ? <CheckIcon /> : <Icon />}
            onClick={() => {
              if (!active) {
                onAssign(role, alias, config);
              }
            }}
          >
            {t(`models.models.roles.${role}.short`)}
          </Button>
        );
      })}
    </fieldset>
  );
}
