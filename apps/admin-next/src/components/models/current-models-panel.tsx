import { useMutation } from '@tanstack/react-query';
import { Select } from '@tuuject/koi-react/select';
import { SelectGroup, SelectItem, SelectPanel } from '@tuuject/koi-react/select-panel';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import { setAgentThinkingLevel } from '@/lib/api/models.ts';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import {
  agentModelConfig,
  isConfigConflict,
  isTextCapable,
  isThinkingLevel,
  modelConfigFor,
  supportedThinkingLevels,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

// Model options are keyed `${alias}/${id}`, which always contains a slash, so a
// slash-free value can never collide with a model.
const INHERIT = 'inherit';

type ToolTarget =
  | { readonly inherit: true }
  | { readonly alias: string; readonly model: string; readonly level: ThinkingLevel };

interface ToolOption {
  readonly value: string;
  /** What the search box matches: the readable name and the exact `alias/id`. */
  readonly label: string;
  readonly ref: { readonly alias: string; readonly config: ProviderModelConfig } | null;
}

/**
 * The models the bot runs on right now. Agent and Tool Model rows carry their
 * own thinking effort in a right-hand column, so the level reads as a setting
 * of that model; Vision has none. The Agent model is switched from the model
 * rows below, while the Tool Model is picked and saved right here.
 */
export function CurrentModelsPanel({
  view,
  revision,
}: {
  readonly view: ProvidersView;
  readonly revision: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const agentModel = agentModelConfig(view);
  const current = view.agent.thinking_level;
  // Without a resolvable agent model the current level, if any, is the only one
  // this page can vouch for.
  const levels = agentModel !== null ? supportedThinkingLevels(agentModel) : current === null ? [] : [current];
  // An unset level must stay pickable even when the model offers just one.
  const levelLocked = levels.length === 0 || (levels.length < 2 && current !== null);

  const setLevel = useMutation({
    mutationFn: (level: ThinkingLevel) => setAgentThinkingLevel(level, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  const tool = view.tool_model;
  const saveTool = useMutation({
    mutationFn: (target: ToolTarget) =>
      'inherit' in target
        ? putToolModel({ inherit: true }, revision)
        : putToolModel({ provider: target.alias, model: target.model, thinking_level: target.level }, revision),
    onSuccess: (result, target) => {
      write.succeeded(
        result.apply,
        'inherit' in target
          ? t('models.models.toolModel.savedInherited')
          : target.alias === tool.provider && target.model === tool.model && !tool.inherited
            ? undefined
            : t('models.models.toolModel.saved', { level: target.level }),
      );
    },
    onError: (error) => {
      write.failed(error);
      toast.error(isConfigConflict(error) ? t('models.models.toolModel.conflict') : writeErrorMessage(error));
    },
  });

  const toolOptions = useMemo(() => {
    const groups: { readonly label: string; readonly items: ToolOption[] }[] = [
      {
        label: t('models.models.toolModel.defaultGroup'),
        items: [{ value: INHERIT, label: t('models.models.toolModel.inherit'), ref: null }],
      },
    ];
    for (const provider of view.providers) {
      const items: ToolOption[] = [];
      for (const model of provider.models) {
        if (!isTextCapable(model)) {
          continue;
        }
        const key = `${provider.alias}/${model.id}`;
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
    return groups;
  }, [view, t]);

  // While a save is in flight the controls show where it is going, not where
  // the file still is; the refetch that follows makes it the real value.
  const pendingTool = saveTool.isPending ? saveTool.variables : undefined;
  const toolValue =
    pendingTool !== undefined
      ? 'inherit' in pendingTool
        ? INHERIT
        : `${pendingTool.alias}/${pendingTool.model}`
      : tool.inherited
        ? INHERIT
        : tool.provider === null || tool.model === null
          ? null
          : `${tool.provider}/${tool.model}`;
  const toolInherited = toolValue === INHERIT;
  const toolLevel = pendingTool !== undefined && !('inherit' in pendingTool) ? pendingTool.level : tool.thinking_level;
  const toolConfig = modelConfigFor(view, tool.provider, tool.model);
  const toolLevels =
    toolConfig !== null && !toolInherited ? supportedThinkingLevels(toolConfig) : toolLevel === null ? [] : [toolLevel];

  const pickTool = (value: string | null): void => {
    if (value === null || value === toolValue) {
      return;
    }
    if (value === INHERIT) {
      saveTool.mutate({ inherit: true });
      return;
    }
    const ref = toolOptions.flatMap((group) => group.items).find((option) => option.value === value)?.ref;
    if (ref === undefined || ref === null) {
      return;
    }
    const accepted = supportedThinkingLevels(ref.config);
    // Keep the effort in use when the new model accepts it; otherwise start
    // from its weakest level, as an Agent model switch does.
    const level =
      tool.thinking_level !== null && accepted.includes(tool.thinking_level) ? tool.thinking_level : accepted[0];
    saveTool.mutate({ alias: ref.alias, model: ref.config.id, level: level ?? 'off' });
  };

  return (
    <Panel title={t('models.models.inUse.title')} description={t('models.models.inUse.description')}>
      <div
        className={css({
          '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' },
          '& > *': { paddingBlock: '4' },
          '& > :first-child': { paddingBlockStart: '0' },
          '& > :last-child': { paddingBlockEnd: '0' },
        })}
      >
        <SummaryRow
          label={t('models.models.inUse.agentModel')}
          thinking={
            <ThinkingField note={t('models.models.inUse.resetsNote')}>
              <Select
                aria-label={t('models.models.inUse.agentThinking')}
                placeholder={t('models.models.inUse.levelUnset')}
                value={(setLevel.isPending ? setLevel.variables : current) ?? ''}
                disabled={setLevel.isPending || levelLocked}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isThinkingLevel(value) && value !== current) {
                    setLevel.mutate(value);
                  }
                }}
              >
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </ThinkingField>
          }
        >
          <ModelValue provider={view.agent.provider} model={view.agent.model} config={agentModel} />
        </SummaryRow>

        <SummaryRow label={t('models.models.inUse.visionModel')}>
          <ModelValue
            provider={view.vision.provider}
            model={view.vision.model}
            config={modelConfigFor(view, view.vision.provider, view.vision.model)}
          />
        </SummaryRow>

        <SummaryRow
          label={t('models.models.toolModel.label')}
          thinking={
            <ThinkingField note={toolInherited ? t('models.models.toolModel.levelInherited') : undefined}>
              <Select
                aria-label={t('models.models.toolModel.thinking')}
                placeholder={t('models.models.inUse.levelUnset')}
                value={toolLevel ?? ''}
                // An inherited level belongs to the Agent row; changing it here
                // would silently pin the Tool Model.
                disabled={saveTool.isPending || toolInherited || toolLevels.length < 2}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    isThinkingLevel(value) &&
                    value !== tool.thinking_level &&
                    tool.provider !== null &&
                    tool.model !== null
                  ) {
                    saveTool.mutate({ alias: tool.provider, model: tool.model, level: value });
                  }
                }}
              >
                {toolLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </ThinkingField>
          }
        >
          <div className={css({ width: '100%' })}>
            <SelectPanel
              aria-label={t('models.models.toolModel.label')}
              items={toolOptions}
              value={toolValue}
              disabled={saveTool.isPending}
              searchable
              searchPlaceholder={t('models.models.toolModel.search')}
              emptyText={t('models.models.toolModel.empty')}
              placeholder={
                tool.provider === null || tool.model === null ? (
                  t('models.models.inUse.notConfigured')
                ) : (
                  <MonoValue value={`${tool.provider} / ${tool.model}`} />
                )
              }
              renderValue={(option) =>
                option.ref === null ? (
                  option.label
                ) : (
                  <ToolOptionLabel alias={option.ref.alias} config={option.ref.config} withAlias />
                )
              }
              onChange={pickTool}
            >
              {(groups) =>
                groups.map((group) => (
                  <SelectGroup key={group.label} label={group.label}>
                    {group.items.map((option) => (
                      <SelectItem key={option.value} value={option.value} label={option.label}>
                        {option.ref === null ? (
                          option.label
                        ) : (
                          <ToolOptionLabel alias={option.ref.alias} config={option.ref.config} />
                        )}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))
              }
            </SelectPanel>
          </div>
        </SummaryRow>
      </div>
    </Panel>
  );
}

/**
 * One slot of the summary: label and value in a fixed-width column, and for
 * models that think, their effort right beside it. Both columns keep their
 * width on every row, so the effort lines up across rows and stays next to
 * the model it belongs to instead of drifting to the card's far edge.
 */
function SummaryRow({
  label,
  children,
  thinking,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly thinking?: ReactNode;
}): React.ReactElement {
  return (
    <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: '6', rowGap: '3' })}>
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', flex: '0 1 420px', minWidth: '0' })}>
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>{label}</span>
        {children}
      </div>
      {thinking === undefined ? null : (
        <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', flex: '0 1 200px', minWidth: '0' })}>
          {thinking}
        </div>
      )}
    </div>
  );
}

function ThinkingField({
  note,
  children,
}: {
  readonly note: string | undefined;
  readonly children: ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <span aria-hidden className={css({ textStyle: 'small', color: 'text-muted' })}>
        {t('models.models.inUse.thinkingEffort')}
      </span>
      {children}
      {note === undefined ? null : <span className={css({ textStyle: 'small', color: 'text-muted' })}>{note}</span>}
    </>
  );
}

/** A Tool Model option: its readable name, then the exact id (with the alias in the trigger). */
function ToolOptionLabel({
  alias,
  config,
  withAlias = false,
}: {
  readonly alias: string;
  readonly config: ProviderModelConfig;
  readonly withAlias?: boolean;
}): React.ReactElement {
  const hasName = config.name !== undefined && config.name.length > 0;
  return (
    <span className={css({ display: 'flex', alignItems: 'baseline', gap: '2', minWidth: '0' })}>
      {hasName ? <span className={css({ flexShrink: '0' })}>{config.name}</span> : null}
      <span className={css({ minWidth: '0', truncate: true, color: hasName ? 'text-muted' : 'text' })}>
        <MonoValue value={withAlias ? `${alias} / ${config.id}` : config.id} />
      </span>
    </span>
  );
}

/** A readable model name with the exact `provider / id` underneath. */
function ModelValue({
  provider,
  model,
  config,
}: {
  readonly provider: string | null;
  readonly model: string | null;
  readonly config: ProviderModelConfig | null;
}): React.ReactElement {
  const { t } = useTranslation();
  if (provider === null || model === null) {
    return (
      <span className={css({ textStyle: 'body', color: 'text-muted' })}>{t('models.models.inUse.notConfigured')}</span>
    );
  }
  return (
    <span
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: '2',
        rowGap: '1',
        minWidth: '0',
      })}
    >
      {config?.name === undefined || config.name.length === 0 ? null : (
        <span className={css({ textStyle: 'label' })}>{config.name}</span>
      )}
      <span className={css({ textStyle: 'small', color: 'text-muted' })}>
        <MonoValue value={`${provider} / ${model}`} />
      </span>
    </span>
  );
}
