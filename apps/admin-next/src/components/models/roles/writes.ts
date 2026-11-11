import { useIsFetching, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatThinkingReset, ThinkingLevel } from '@/lib/api/models.ts';
import { switchAgentModel, switchVisionModel } from '@/lib/api/models.ts';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import { isConfigConflict, modelInUseCount, supportedThinkingLevels, writeErrorMessage } from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { toast } from '@/lib/toast.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/** The three jobs a configured model can be given. */
export type ModelRole = 'agent' | 'vision' | 'tool';

export interface ModelTarget {
  readonly alias: string;
  readonly model: string;
}

/** An Agent switch, once the admin agreed to stop the Invocations still on the old model. */
type AgentTarget = ModelTarget & { readonly abortRunning?: boolean };

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
 * The one-click role writes behind the Providers page's "Use as" toggles: each
 * saves at once. An Agent switch resets its effort and may reset per-Chat
 * efforts, which the caller lists in `ThinkingResetDialog`. An Agent switch that
 * Invocations are still running on is refused until the admin agrees to stop
 * them, which the caller asks through `ModelSwitchConfirmDialog` with
 * `agentInUse`. The Models page edits a draft instead and saves it through
 * `saveRoles`.
 */
export function useModelRoleWrites(view: ProvidersView | undefined) {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const revision = view?.revision ?? '';
  const [thinkingResets, setThinkingResets] = useState<readonly ChatThinkingReset[]>([]);
  // Opening is its own flag: closing only hides the dialog so the rows survive the
  // exit transition, and the next switch replaces both.
  const [thinkingResetsOpen, setThinkingResetsOpen] = useState(false);
  const [agentInUse, setAgentInUse] = useState<{ readonly count: number; readonly target: ModelTarget } | null>(null);
  const [agentInUseOpen, setAgentInUseOpen] = useState(false);

  const failed = (error: unknown): void => {
    toast.error(writeErrorMessage(error));
    write.failed(error);
  };

  const agent = useMutation({
    mutationFn: ({ alias, model, abortRunning }: AgentTarget) =>
      switchAgentModel({ provider: alias, model, ...(abortRunning === true ? { abort_running: true } : {}) }, revision),
    onSuccess: (result) => {
      setAgentInUseOpen(false);
      // Models do not share one set of levels, so the switch always resets it.
      const reset = t('models.models.page.thinkingReset', { level: result.current.thinking_level });
      write.succeeded(
        result.apply,
        result.aborted_invocations > 0
          ? `${reset} ${t('models.models.switchConfirm.stopped', { count: result.aborted_invocations })}`
          : reset,
      );
      setThinkingResets(result.chat_thinking_resets);
      setThinkingResetsOpen(result.chat_thinking_resets.length > 0);
    },
    onError: (error, target) => {
      const running = modelInUseCount(error);
      if (running !== null) {
        setAgentInUse({ count: running, target: { alias: target.alias, model: target.model } });
        setAgentInUseOpen(true);
        return;
      }
      setAgentInUseOpen(false);
      failed(error);
    },
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

  /** What a Tool Model write changed beyond the model itself; nothing when the same model was kept. */
  const toolSavedNote = (target: ToolTarget): string | undefined => {
    if ('inherit' in target) {
      return t('models.models.toolModel.savedInherited');
    }
    const current = view?.tool_model;
    const unchanged =
      current !== undefined &&
      !current.inherited &&
      target.alias === current.provider &&
      target.model === current.model;
    return unchanged ? undefined : t('models.models.toolModel.saved', { level: target.level });
  };

  const tool = useMutation({
    mutationFn: (target: ToolTarget) =>
      'inherit' in target
        ? putToolModel({ inherit: true }, revision)
        : putToolModel({ provider: target.alias, model: target.model, thinking_level: target.level }, revision),
    onSuccess: (result, target) => {
      write.succeeded(result.apply, toolSavedNote(target));
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

  // Every role write carries the one config revision, so they run one at a
  // time: a second one sent before the first has landed and the view has come
  // back with the new revision would only be refused as a conflict.
  const refreshing = useIsFetching({ queryKey: providersQuery.queryKey }) > 0;
  const busy = agent.isPending || vision.isPending || tool.isPending || refreshing;
  const pending: Readonly<Record<ModelRole, boolean>> = { agent: busy, vision: busy, tool: busy };

  return {
    assign,
    pending,
    thinkingResets,
    thinkingResetsOpen,
    closeThinkingResets: () => setThinkingResetsOpen(false),
    agentInUse: {
      open: agentInUseOpen,
      count: agentInUse?.count ?? 0,
      pending: agent.isPending,
      confirm: () => {
        if (agentInUse !== null) {
          agent.mutate({ ...agentInUse.target, abortRunning: true });
        }
      },
      cancel: () => setAgentInUseOpen(false),
    },
  };
}
