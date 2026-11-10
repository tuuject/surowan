import { SelectGroup, SelectItem, SelectPanel } from '@tuuject/koi-react/select-panel';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { isImageCapable, isTextCapable } from '@/lib/model-manager.ts';
import { modelKey } from './draft.ts';

/** One row of the picker: a provider model, or a caller-supplied choice such as "Inherit". */
export interface ModelChoice {
  readonly value: string;
  /** What the search box matches: the readable name and the exact `alias/id`. */
  readonly label: string;
  readonly ref: { readonly alias: string; readonly config: ProviderModelConfig } | null;
}

interface ChoiceGroup {
  readonly label: string;
  readonly items: ModelChoice[];
}

/**
 * A searchable model picker over every configured provider, grouped by
 * provider and limited to the models that can do the job (`text` for the
 * Agent and Tool models, `image` for Vision). `onPick` reports the choice; the
 * caller decides whether it saves at once or goes into a draft.
 */
export function ModelSelect({
  view,
  accepts,
  value,
  leading,
  placeholder,
  disabled,
  onPick,
}: {
  readonly view: ProvidersView;
  readonly accepts: 'text' | 'image';
  /** The selected option's value, or `null` when nothing is configured. */
  readonly value: string | null;
  /** Extra choices listed before the providers. */
  readonly leading?: ChoiceGroup;
  readonly placeholder: ReactNode;
  readonly disabled: boolean;
  readonly onPick: (choice: ModelChoice) => void;
}): ReactElement {
  const { t } = useTranslation();
  // Rebuilt per render: a few providers' model lists, cheaper than keeping a memo in sync.
  const groups: ChoiceGroup[] = leading === undefined ? [] : [leading];
  for (const provider of view.providers) {
    const items: ModelChoice[] = [];
    for (const model of provider.models) {
      if (!(accepts === 'image' ? isImageCapable(model) : isTextCapable(model))) {
        continue;
      }
      const key = modelKey(provider.alias, model.id);
      items.push({
        value: key,
        label: model.name === undefined || model.name.length === 0 ? key : `${model.name} ${key}`,
        ref: { alias: provider.alias, config: model },
      });
    }
    if (items.length > 0) {
      groups.push({ label: provider.alias, items });
    }
  }

  return (
    <SelectPanel
      // The template's settings forms cap a field at 480px; the panel keeps its own width.
      className={css({ width: '100%', maxWidth: '480px' })}
      items={groups}
      value={value}
      disabled={disabled}
      searchable
      searchPlaceholder={t('models.models.roles.searchModels')}
      emptyText={t('models.models.roles.noMatchingModels')}
      placeholder={placeholder}
      renderValue={(option) =>
        option.ref === null ? option.label : <ModelValueLabel alias={option.ref.alias} config={option.ref.config} />
      }
      onChange={(next) => {
        if (next === null || next === value) {
          return;
        }
        const choice = groups.flatMap((group) => group.items).find((item) => item.value === next);
        if (choice !== undefined) {
          onPick(choice);
        }
      }}
    >
      {(items) =>
        items.map((group) => (
          <SelectGroup key={group.label} label={group.label}>
            {group.items.map((option) => (
              <SelectItem key={option.value} value={option.value} label={option.label}>
                {option.ref === null ? option.label : <ModelChoiceLabel config={option.ref.config} />}
              </SelectItem>
            ))}
          </SelectGroup>
        ))
      }
    </SelectPanel>
  );
}

function hasDisplayName(config: ProviderModelConfig): boolean {
  return config.name !== undefined && config.name.length > 0;
}

/** The trigger's one line: a named model by its name alone, an unnamed one by its exact `alias / id`. */
function ModelValueLabel({
  alias,
  config,
}: {
  readonly alias: string;
  readonly config: ProviderModelConfig;
}): ReactElement {
  return (
    <span className={css({ minWidth: '0', truncate: true })}>
      {hasDisplayName(config) ? config.name : <MonoValue value={`${alias} / ${config.id}`} />}
    </span>
  );
}

/**
 * A menu option: the readable name, then the exact id as a muted second line,
 * like the provider rail's rows. Without a name the id is the only line, so it
 * keeps the label's size and color. The group heading already names the provider.
 */
function ModelChoiceLabel({ config }: { readonly config: ProviderModelConfig }): ReactElement {
  const named = hasDisplayName(config);
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1', minWidth: '0' })}>
      {named ? <span>{config.name}</span> : null}
      <span
        className={css({
          minWidth: '0',
          truncate: true,
          textStyle: named ? 'small' : 'body',
          color: named ? 'text-muted' : 'text',
        })}
      >
        <MonoValue value={config.id} />
      </span>
    </span>
  );
}

/** The trigger text when the configured pair is not one of the options (or nothing is configured). */
export function configuredPlaceholder(provider: string | null, model: string | null, unset: string): ReactNode {
  return provider === null || model === null ? unset : <MonoValue value={`${provider} / ${model}`} />;
}
