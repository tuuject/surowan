import { Field } from '@tuuject/koi-react/field';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import { sizes } from '@tuuject/koi-tokens/dimensions';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrainIcon, EyeIcon, WrenchIcon } from '@/components/icons';
import { Panel } from '@/components/layout/panel';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import type { ProvidersView } from '@/lib/api/providers.ts';
import { agentModelConfig, isThinkingLevel, modelConfigFor, supportedThinkingLevels } from '@/lib/model-manager.ts';
import { configuredPlaceholder, ModelSelect, modelKey } from './model-select.tsx';
import { toolLevelFor, type useModelRoleWrites } from './writes.ts';

type RoleWrites = ReturnType<typeof useModelRoleWrites>;

// Model option values always contain a slash, so this one can never collide.
const INHERIT = 'inherit';

/**
 * The Models page body: one card per job the bot gives a model. Each card
 * picks the model and, beside it, the thinking effort that model runs at;
 * both save on change. Providers and their model lists live on the Providers
 * page, which this page only reads.
 */
export function RoleCards({
  view,
  writes,
}: {
  readonly view: ProvidersView;
  readonly writes: RoleWrites;
}): React.ReactElement {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '6' })}>
      <AgentCard view={view} writes={writes} />
      <VisionCard view={view} writes={writes} />
      <ToolCard view={view} writes={writes} />
    </div>
  );
}

function AgentCard({ view, writes }: { readonly view: ProvidersView; readonly writes: RoleWrites }) {
  const { t } = useTranslation();
  const config = agentModelConfig(view);
  const current = view.agent.thinking_level;
  const pendingModel = writes.agent.isPending ? writes.agent.variables : undefined;
  const value =
    pendingModel !== undefined
      ? modelKey(pendingModel.alias, pendingModel.model)
      : view.agent.provider === null || view.agent.model === null
        ? null
        : modelKey(view.agent.provider, view.agent.model);
  // Without a resolvable model the current level, if any, is the only one this
  // page can vouch for.
  const levels = config !== null ? supportedThinkingLevels(config) : current === null ? [] : [current];
  return (
    <RoleCard
      icon={BrainIcon}
      title={t('models.models.roles.agent.title')}
      description={t('models.models.roles.agent.description')}
      model={
        <ModelSelect
          view={view}
          accepts="text"
          value={value}
          placeholder={configuredPlaceholder(view.agent.provider, view.agent.model, t('models.models.roles.unset'))}
          disabled={writes.pending.agent}
          onPick={(choice) => {
            if (choice.ref !== null) {
              writes.agent.mutate({ alias: choice.ref.alias, model: choice.ref.config.id });
            }
          }}
        />
      }
      thinking={
        <ThinkingSelect
          levels={levels}
          value={(writes.agentLevel.isPending ? writes.agentLevel.variables : current) ?? null}
          // An unset level must stay pickable even when the model offers just one.
          locked={levels.length === 0 || (levels.length < 2 && current !== null)}
          disabled={writes.pending.agent}
          help={
            config !== null && !config.reasoning
              ? t('models.models.roles.notReasoning')
              : t('models.models.roles.agent.resetsNote')
          }
          onChange={(level) => {
            if (level !== current) {
              writes.agentLevel.mutate(level);
            }
          }}
        />
      }
    />
  );
}

function VisionCard({ view, writes }: { readonly view: ProvidersView; readonly writes: RoleWrites }) {
  const { t } = useTranslation();
  const { provider, model } = view.vision;
  const config = modelConfigFor(view, provider, model);
  const pending = writes.vision.isPending ? writes.vision.variables : undefined;
  const value =
    pending !== undefined
      ? modelKey(pending.alias, pending.model)
      : provider === null || model === null
        ? null
        : modelKey(provider, model);
  const current = view.vision.thinking_level;
  const levels = config !== null ? supportedThinkingLevels(config) : current === null ? [] : [current];
  return (
    <RoleCard
      icon={EyeIcon}
      title={t('models.models.roles.vision.title')}
      description={t('models.models.roles.vision.description')}
      model={
        <ModelSelect
          view={view}
          accepts="image"
          value={value}
          placeholder={configuredPlaceholder(provider, model, t('models.models.roles.unset'))}
          disabled={writes.pending.vision}
          onPick={(choice) => {
            if (choice.ref !== null) {
              // No level: the server keeps the stored one while the new model
              // accepts it, and falls back to the model's default otherwise.
              writes.vision.mutate({ alias: choice.ref.alias, model: choice.ref.config.id });
            }
          }}
        />
      }
      thinking={
        <ThinkingSelect
          levels={levels}
          value={pending?.level ?? current}
          locked={provider === null || model === null || levels.length < 2}
          disabled={writes.pending.vision}
          help={config !== null && !config.reasoning ? t('models.models.roles.notReasoning') : undefined}
          onChange={(level) => {
            if (provider !== null && model !== null && level !== current) {
              writes.vision.mutate({ alias: provider, model, level });
            }
          }}
        />
      }
    />
  );
}

function ToolCard({ view, writes }: { readonly view: ProvidersView; readonly writes: RoleWrites }) {
  const { t } = useTranslation();
  const tool = view.tool_model;
  // While a save is in flight the controls show where it is going, not where
  // the file still is; the refetch that follows makes it the real value.
  const pending = writes.tool.isPending ? writes.tool.variables : undefined;
  const value =
    pending !== undefined
      ? 'inherit' in pending
        ? INHERIT
        : modelKey(pending.alias, pending.model)
      : tool.inherited
        ? INHERIT
        : tool.provider === null || tool.model === null
          ? null
          : modelKey(tool.provider, tool.model);
  const inherited = value === INHERIT;
  const level = pending !== undefined && !('inherit' in pending) ? pending.level : tool.thinking_level;
  const config = modelConfigFor(view, tool.provider, tool.model);
  const levels = config !== null && !inherited ? supportedThinkingLevels(config) : level === null ? [] : [level];
  return (
    <RoleCard
      icon={WrenchIcon}
      title={t('models.models.roles.tool.title')}
      description={t('models.models.roles.tool.description')}
      model={
        <ModelSelect
          view={view}
          accepts="text"
          value={value}
          leading={{
            label: t('models.models.roles.tool.defaultGroup'),
            items: [{ value: INHERIT, label: t('models.models.roles.tool.inherit'), ref: null }],
          }}
          placeholder={configuredPlaceholder(tool.provider, tool.model, t('models.models.roles.unset'))}
          disabled={writes.pending.tool}
          onPick={(choice) => {
            if (choice.ref === null) {
              writes.tool.mutate({ inherit: true });
            } else {
              writes.tool.mutate({
                alias: choice.ref.alias,
                model: choice.ref.config.id,
                level: toolLevelFor(view, choice.ref.config),
              });
            }
          }}
        />
      }
      thinking={
        <ThinkingSelect
          levels={levels}
          value={level}
          // An inherited level belongs to the Agent card; changing it here
          // would silently pin the Tool Model.
          locked={inherited || levels.length < 2}
          disabled={writes.pending.tool}
          help={
            inherited
              ? t('models.models.roles.tool.levelInherited')
              : config !== null && !config.reasoning
                ? t('models.models.roles.notReasoning')
                : undefined
          }
          onChange={(next) => {
            if (next !== tool.thinking_level && tool.provider !== null && tool.model !== null) {
              writes.tool.mutate({ alias: tool.provider, model: tool.model, level: next });
            }
          }}
        />
      }
    />
  );
}

/**
 * One role: what the job is, then its model and thinking effort side by side,
 * so the effort reads as a setting of that model. The two columns stack on a
 * narrow card. The controls take their names from the Field labels; the card's
 * region name tells the three "Model" fields apart.
 */
function RoleCard({
  icon: Icon,
  title,
  description,
  model,
  thinking,
}: {
  readonly icon: ComponentType<{ size?: number }>;
  readonly title: string;
  readonly description: string;
  readonly model: ReactNode;
  readonly thinking: ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Panel
      title={
        <span className={css({ display: 'inline-flex', alignItems: 'center', gap: '2' })}>
          <span aria-hidden className={css({ display: 'inline-flex', color: 'text-muted' })}>
            <Icon size={sizes.icon} />
          </span>
          {title}
        </span>
      }
      description={description}
    >
      <div
        className={css({
          display: 'grid',
          gap: '4',
          alignItems: 'start',
          '@media (min-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr) 200px' },
        })}
      >
        <Field label={t('models.models.roles.modelLabel')}>{model}</Field>
        {thinking}
      </div>
    </Panel>
  );
}

function ThinkingSelect({
  levels,
  value,
  locked,
  disabled,
  help,
  onChange,
}: {
  readonly levels: readonly ThinkingLevel[];
  readonly value: ThinkingLevel | null;
  /** Nothing to choose between: the model offers one level, or there is no model. */
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly help: string | undefined;
  readonly onChange: (level: ThinkingLevel) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  // The value in use stays listed even when the model no longer declares it.
  const options = value === null || levels.includes(value) ? levels : [...levels, value];
  return (
    <Field label={t('models.models.roles.thinkingLabel')} {...(help === undefined ? {} : { help })}>
      <Select
        placeholder={t('models.models.roles.levelUnset')}
        value={value ?? ''}
        disabled={disabled || locked}
        onChange={(event) => {
          const next = event.target.value;
          if (isThinkingLevel(next)) {
            onChange(next);
          }
        }}
      >
        {options.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </Select>
    </Field>
  );
}
