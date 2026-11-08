import type { ChatThinkingReset, ModelApplySummary } from '@/lib/api/models.ts';
import { setAgentThinkingLevel, switchAgentModel, switchVisionModel } from '@/lib/api/models.ts';
import { getProviders, type ProvidersView } from '@/lib/api/providers.ts';
import { putToolModel } from '@/lib/api/tools.ts';
import { changedRoles, INHERIT, modelForKey, type RolesDraft, savedRoles } from './draft.ts';
import type { ModelRole } from './writes.ts';

export interface RolesSaveResult {
  /** The roles written in full; on a failure, the ones before it. */
  readonly saved: ReadonlySet<ModelRole>;
  readonly apply: ModelApplySummary;
  /** Per-Chat efforts an Agent model switch reset. */
  readonly resets: readonly ChatThinkingReset[];
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
 * the previous one produced; `PUT /model` is the only one that does not return
 * it, so the view is read once after it.
 *
 * A new Agent model is written first and its effort after: the switch resets
 * the effort on the server, and the second write puts back the one the draft
 * shows when it differs. Vision always sends its level with a new model, so
 * the file ends up holding exactly what the page showed.
 */
export async function saveRoles(view: ProvidersView, draft: RolesDraft): Promise<RolesSaveResult> {
  const saved = savedRoles(view);
  const changed = new Set(changedRoles(view, draft));
  const done = new Set<ModelRole>();
  const applied = new Set<string>();
  const restart = new Set<string>();
  let resets: readonly ChatThinkingReset[] = [];
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
  });

  try {
    if (changed.has('agent')) {
      let level = saved.agent.level;
      const target = modelForKey(view, draft.agent.model);
      if (draft.agent.model !== saved.agent.model && target !== null) {
        const switched = await switchAgentModel({ provider: target.alias, model: target.config.id }, revision);
        record(switched.apply);
        resets = switched.chat_thinking_resets;
        level = switched.current.thinking_level;
        revision = (await getProviders()).revision;
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
