import type { ChatThinkingReset, ModelApplySummary } from '@/lib/api/models.ts';
import { setAgentThinkingLevel, switchAgentModel, switchVisionModel } from '@/lib/api/models.ts';
import type { ProvidersView } from '@/lib/api/providers.ts';
import i18n from '@/lib/i18n.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import { changedRoles, INHERIT, modelForKey, type RolesDraft, savedRoles } from './draft.ts';
import type { ModelRole } from './writes.ts';

export interface RolesSaveResult {
  /** The roles written in full; on a failure, the ones before it. */
  readonly saved: ReadonlySet<ModelRole>;
  readonly apply: ModelApplySummary;
  /** Per-Chat efforts an Agent model switch reset. */
  readonly resets: readonly ChatThinkingReset[];
  /** Invocations the Agent model switch stopped because they still ran on the old model. */
  readonly aborted: number;
}

/** A save that stopped part way: what went through is kept, the rest stays in the draft. */
export class RolesSaveError extends Error {
  readonly result: RolesSaveResult;

  constructor(cause: unknown, result: RolesSaveResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RolesSaveError';
    this.result = result;
  }
}

/**
 * Writes the changed roles one endpoint after another, Agent first so an
 * inherited Tool Model already follows it. Every write must carry the revision
 * the previous one produced, never one read back from the view: a read could
 * return another admin's write and let the rest of this save run over it.
 *
 * A new Agent model is written first and its effort after: the switch resets
 * the effort on the server, and the second write puts back the one the draft
 * shows when it differs. Vision always sends its level with a new model, so
 * the file ends up holding exactly what the page showed.
 *
 * A drafted model that is no longer in the view (removed elsewhere, then a
 * refetch) stops the save before anything is written: skipping it would report
 * a role as saved that was never sent.
 *
 * A new Agent model that Invocations are still running on is refused with
 * `model_in_use` before anything is written, since Agent goes first; the caller
 * asks the admin and saves again with `abortRunning`.
 */
export async function saveRoles(
  view: ProvidersView,
  draft: RolesDraft,
  options: { readonly abortRunning?: boolean } = {},
): Promise<RolesSaveResult> {
  const saved = savedRoles(view);
  const changed = new Set(changedRoles(view, draft));
  const done = new Set<ModelRole>();
  const applied = new Set<string>();
  const restart = new Set<string>();
  let resets: readonly ChatThinkingReset[] = [];
  let aborted = 0;
  let revision = view.revision;
  const record = (apply: ModelApplySummary): void => {
    for (const path of apply.applied) {
      applied.add(path);
    }
    for (const path of apply.restart_required) {
      restart.add(path);
    }
  };
  const result = (): RolesSaveResult => ({
    saved: done,
    apply: { applied: [...applied], restart_required: [...restart] },
    resets,
    aborted,
  });

  for (const role of changed) {
    const key = draft[role].model;
    if (key !== null && key !== INHERIT && modelForKey(view, key) === null) {
      throw new RolesSaveError(new Error(i18n.t('models.models.roles.form.missingModel', { model: key })), result());
    }
  }

  try {
    if (changed.has('agent')) {
      let level = saved.agent.level;
      const target = modelForKey(view, draft.agent.model);
      if (draft.agent.model !== saved.agent.model && target !== null) {
        const switched = await switchAgentModel(
          {
            provider: target.alias,
            model: target.config.id,
            ...(options.abortRunning === true ? { abort_running: true } : {}),
          },
          revision,
        );
        record(switched.apply);
        resets = switched.chat_thinking_resets;
        aborted = switched.aborted_invocations;
        level = switched.current.thinking_level;
        revision = switched.revision;
      }
      if (draft.agent.level !== null && draft.agent.level !== level) {
        const leveled = await setAgentThinkingLevel(draft.agent.level, revision);
        record(leveled.apply);
        revision = leveled.revision;
      }
      done.add('agent');
    }

    const vision = modelForKey(view, draft.vision.model);
    if (changed.has('vision') && vision !== null) {
      const written = await switchVisionModel(
        {
          provider: vision.alias,
          model: vision.config.id,
          ...(draft.vision.level === null ? {} : { thinking_level: draft.vision.level }),
        },
        revision,
      );
      record(written.apply);
      revision = written.revision;
      done.add('vision');
    }

    const tool = modelForKey(view, draft.tool.model);
    if (changed.has('tool') && (draft.tool.model === INHERIT || tool !== null)) {
      const written =
        draft.tool.model === INHERIT || tool === null
          ? await putToolModel({ inherit: true }, revision)
          : await putToolModel(
              { provider: tool.alias, model: tool.config.id, thinking_level: draft.tool.level ?? 'off' },
              revision,
            );
      record(written.apply);
      revision = written.revision;
      done.add('tool');
    }
  } catch (error) {
    throw new RolesSaveError(error, result());
  }
  return result();
}
