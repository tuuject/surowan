import { useMutation } from '@tanstack/react-query';
import { Badge } from '@tuuject/koi-react/badge';
import { Button } from '@tuuject/koi-react/button';
import { Select } from '@tuuject/koi-react/select';
import { css } from '@tuuject/koi-react/styled-system/css';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { ToolModelPicker } from '@/components/models/tool-model-picker';
import type { ThinkingLevel } from '@/lib/api/models.ts';
import { setAgentThinkingLevel } from '@/lib/api/models.ts';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import {
  agentModelConfig,
  isConfigConflict,
  isThinkingLevel,
  modelConfigFor,
  supportedThinkingLevels,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/**
 * The models the bot runs on right now: Agent and Vision, the Agent's thinking
 * effort, and the auxiliary Tool Model. Each slot is one row with a readable
 * model name and its `provider / id` underneath; only the effort and the Tool
 * Model have controls here, the two main models are switched from their rows.
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
  const [pickerOpen, setPickerOpen] = useState(false);
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
    mutationFn: (
      target:
        | { readonly inherit: true }
        | { readonly alias: string; readonly model: string; readonly level: ThinkingLevel },
    ) =>
      'inherit' in target
        ? putToolModel({ inherit: true }, revision)
        : putToolModel({ provider: target.alias, model: target.model, thinking_level: target.level }, revision),
    onSuccess: (result, target) => {
      setPickerOpen(false);
      write.succeeded(result.apply);
      toast.success(
        'inherit' in target ? t('models.models.toolModel.savedInherited') : t('models.models.toolModel.saved'),
      );
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        setPickerOpen(false);
        toast.error(t('models.models.toolModel.conflict'));
      }
    },
  });

  return (
    <Panel
      title={t('models.models.inUse.title')}
      description={t('models.models.inUse.description')}
      action={
        <>
          {tool.inherited ? null : (
            <Button
              variant="ghost"
              color="secondary"
              disabled={saveTool.isPending}
              onClick={() => saveTool.mutate({ inherit: true })}
            >
              {t('models.models.toolModel.inherit')}
            </Button>
          )}
          <Button variant="outline" disabled={saveTool.isPending} onClick={() => setPickerOpen(true)}>
            {t('models.models.toolModel.select')}
          </Button>
        </>
      }
    >
      <div
        className={css({
          '& > :not(:last-child)': { borderBottomWidth: '1px', borderColor: 'divider' },
          '& > *': { paddingBlock: '4' },
          '& > :first-child': { paddingBlockStart: '0' },
          '& > :last-child': { paddingBlockEnd: '0' },
        })}
      >
        <SummaryRow label={t('models.models.inUse.agentModel')}>
          <ModelValue provider={view.agent.provider} model={view.agent.model} config={agentModel} />
        </SummaryRow>

        <SummaryRow
          label={t('models.models.inUse.thinkingEffort')}
          action={
            <Select
              className={css({ width: '160px' })}
              aria-label={t('models.models.inUse.thinkingEffort')}
              placeholder={t('models.models.inUse.levelUnset')}
              value={current ?? ''}
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
          }
        >
          <span className={css({ textStyle: 'small', color: 'text-muted' })}>
            {t('models.models.inUse.resetsNote')}
          </span>
        </SummaryRow>

        <SummaryRow label={t('models.models.inUse.visionModel')}>
          <ModelValue
            provider={view.vision.provider}
            model={view.vision.model}
            config={modelConfigFor(view, view.vision.provider, view.vision.model)}
          />
        </SummaryRow>

        <SummaryRow label={t('models.models.toolModel.label')}>
          <ModelValue
            provider={tool.provider}
            model={tool.model}
            config={modelConfigFor(view, tool.provider, tool.model)}
          />
          <span className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>
            {tool.thinking_level === null ? null : <Badge>{tool.thinking_level}</Badge>}
            {tool.inherited ? (
              <span className={css({ textStyle: 'small', color: 'text-muted' })}>
                {t('models.models.toolModel.inherited')}
              </span>
            ) : null}
          </span>
          {saveTool.isError && !isConfigConflict(saveTool.error) ? (
            <p className={css({ margin: '0', textStyle: 'body', color: 'error-text', overflowWrap: 'anywhere' })}>
              {writeErrorMessage(saveTool.error)}
            </p>
          ) : null}
        </SummaryRow>
      </div>

      {pickerOpen ? (
        <ToolModelPicker
          open
          view={view}
          pending={saveTool.isPending}
          current={tool}
          onClose={() => {
            if (!saveTool.isPending) {
              setPickerOpen(false);
            }
          }}
          onSubmit={(alias, model, level) => saveTool.mutate({ alias, model, level })}
        />
      ) : null}
    </Panel>
  );
}

function SummaryRow({
  label,
  children,
  action,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}): React.ReactElement {
  return (
    <div
      className={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '4',
      })}
    >
      <div className={css({ display: 'flex', flexDirection: 'column', gap: '1', minWidth: '0' })}>
        <span className={css({ textStyle: 'small', color: 'text-muted' })}>{label}</span>
        {children}
      </div>
      {action === undefined ? null : (
        <div className={css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2' })}>{action}</div>
      )}
    </div>
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
