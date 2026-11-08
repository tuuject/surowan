import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatThinkingReset, ThinkingLevel } from '@/lib/api/models.ts';
import { setAgentThinkingLevel, switchAgentModel, switchVisionModel } from '@/lib/api/models.ts';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import { isConfigConflict, supportedThinkingLevels, writeErrorMessage } from '@/lib/model-manager.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/** The three jobs a configured model can be given. */
export type ModelRole = 'agent' | 'vision' | 'tool';

export interface ModelTarget {
  readonly alias: string;
  readonly model: string;
}

export type ToolTarget = { readonly inherit: true } | (ModelTarget & { readonly level: ThinkingLevel });

export type VisionTarget = ModelTarget & { readonly level?: ThinkingLevel };

/** Which roles one provider model fills right now; an inherited Tool Model is not a role of its own. */
export function modelRoles(
  view: ProvidersView,
  alias: string,
  modelId: string,
): { readonly agent: boolean; readonly vision: boolean; readonly tool: boolean } {
  return {
    agent: view.agent.provider === alias && view.agent.model === modelId,
    vision: view.vision.provider === alias && view.vision.model === modelId,
    tool: !view.tool_model.inherited && view.tool_model.provider === alias && view.tool_model.model === modelId,
  };
}

/**
 * The effort a Tool Model switch starts at: the one in use when the new model
 * accepts it, otherwise its weakest level, as an Agent model switch does.
 */
export function toolLevelFor(view: ProvidersView, config: ProviderModelConfig): ThinkingLevel {
  const accepted = supportedThinkingLevels(config);
  const current = view.tool_model.thinking_level;
  return current !== null && accepted.includes(current) ? current : (accepted[0] ?? 'off');
}

/**
 * Every write that gives a model a role or changes a role's thinking effort.
 * The Models page drives them from its role cards, the Providers page from the
 * role buttons on each model row, so both report the same way: an Agent switch
 * resets its effort and may reset per-Chat efforts, which the caller lists in
 * `ThinkingResetDialog`.
 */
export function useModelRoleWrites(view: ProvidersView | undefined) {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const revision = view?.revision ?? '';
  const [thinkingResets, setThinkingResets] = useState<readonly ChatThinkingReset[]>([]);

  const failed = (error: unknown): void => {
    toast.error(writeErrorMessage(error));
    write.failed(error);
  };

  const agent = useMutation({
    mutationFn: ({ alias, model }: ModelTarget) => switchAgentModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      // Models do not share one set of levels, so the switch always resets it.
      write.succeeded(result.apply, t('models.models.page.thinkingReset', { level: result.current.thinking_level }));
      setThinkingResets(result.chat_thinking_resets);
    },
    onError: failed,
  });

  const agentLevel = useMutation({
    mutationFn: (level: ThinkingLevel) => setAgentThinkingLevel(level, revision),
    onSuccess: (result) => write.succeeded(result.apply),
    onError: failed,
  });

  const vision = useMutation({
    mutationFn: ({ alias, model, level }: VisionTarget) =>
      switchVisionModel(
        { provider: alias, model, ...(level === undefined ? {} : { thinking_level: level }) },
        revision,
      ),
    onSuccess: (result) => write.succeeded(result.apply),
    onError: failed,
  });

  const tool = useMutation({
    mutationFn: (target: ToolTarget) =>
      'inherit' in target
        ? putToolModel({ inherit: true }, revision)
        : putToolModel({ provider: target.alias, model: target.model, thinking_level: target.level }, revision),
    onSuccess: (result, target) => {
      const current = view?.tool_model;
      write.succeeded(
        result.apply,
        'inherit' in target
          ? t('models.models.toolModel.savedInherited')
          : current !== undefined &&
              target.alias === current.provider &&
              target.model === current.model &&
              !current.inherited
            ? undefined
            : t('models.models.toolModel.saved', { level: target.level }),
      );
    },
    onError: (error) => {
      write.failed(error);
      toast.error(isConfigConflict(error) ? t('models.models.toolModel.conflict') : writeErrorMessage(error));
    },
  });

  /** One click on a model row: give that model the role, keeping sensible efforts. */
  const assign = (role: ModelRole, alias: string, config: ProviderModelConfig): void => {
    switch (role) {
      case 'agent':
        agent.mutate({ alias, model: config.id });
        return;
      case 'vision':
        vision.mutate({ alias, model: config.id });
        return;
      case 'tool':
        if (view !== undefined) {
          tool.mutate({ alias, model: config.id, level: toolLevelFor(view, config) });
        }
        return;
    }
  };

  const pending: Readonly<Record<ModelRole, boolean>> = {
    agent: agent.isPending || agentLevel.isPending,
    vision: vision.isPending,
    tool: tool.isPending,
  };

  return {
    agent,
    agentLevel,
    vision,
    tool,
    assign,
    pending,
    thinkingResets,
    closeThinkingResets: () => setThinkingResets([]),
  };
}
