import type { ThinkingLevel } from '@/lib/api/models.ts';
import type { ProviderModelConfig, ProvidersView } from '@/lib/api/providers.ts';
import { supportedThinkingLevels } from '@/lib/model-manager.ts';
import type { ModelRole } from './writes.ts';

/** The Tool Model choice that follows the Agent model. Model keys always contain a slash, so it never collides. */
export const INHERIT = 'inherit';

export const ROLES: readonly ModelRole[] = ['agent', 'vision', 'tool'];

/** One role as the page shows it: the model key (`alias/id`, or `inherit` for the Tool Model) and its effort. */
export interface RoleSlot {
  readonly model: string | null;
  readonly level: ThinkingLevel | null;
}

export type RolesDraft = Readonly<Record<ModelRole, RoleSlot>>;

/**
 * What the admin changed and has not saved. Only touched values are kept, so a
 * refetch that changes an untouched role shows through instead of being saved
 * back over. Picking a model drops that role's level edit: the level is then
 * derived from the new model, the same way the server would derive it.
 */
export type RoleEdits = Readonly<
  Partial<Record<ModelRole, { readonly model?: string; readonly level?: ThinkingLevel }>>
>;

/** The option value of one provider model; the alias never contains a slash, the id may. */
export function modelKey(alias: string, modelId: string): string {
  return `${alias}/${modelId}`;
}

export function modelForKey(
  view: ProvidersView,
  key: string | null,
): { readonly alias: string; readonly config: ProviderModelConfig } | null {
  if (key === null || key === INHERIT) {
    return null;
  }
  const slash = key.indexOf('/');
  const alias = key.slice(0, slash);
  const id = key.slice(slash + 1);
  const config = view.providers.find((provider) => provider.alias === alias)?.models.find((model) => model.id === id);
  return config === undefined ? null : { alias, config };
}

/** What the file holds now, in the page's shape. */
export function savedRoles(view: ProvidersView): RolesDraft {
  const pair = (provider: string | null, model: string | null): string | null =>
    provider === null || model === null ? null : modelKey(provider, model);
  return {
    agent: { model: pair(view.agent.provider, view.agent.model), level: view.agent.thinking_level },
    vision: { model: pair(view.vision.provider, view.vision.model), level: view.vision.thinking_level },
    tool: {
      model: view.tool_model.inherited ? INHERIT : pair(view.tool_model.provider, view.tool_model.model),
      level: view.tool_model.thinking_level,
    },
  };
}

/** Mirrors the server's `defaultVisionThinkingLevel`: `low` where offered, else the weakest effort above `off`. */
function defaultVisionLevel(levels: readonly ThinkingLevel[]): ThinkingLevel {
  return levels.includes('low') ? 'low' : (levels.find((level) => level !== 'off') ?? 'off');
}

/**
 * The effort a newly picked model starts at, before the admin touches it:
 * the Agent model resets to its weakest level (as `PUT /model` does); the
 * Tool model keeps the effort in use when the new model accepts it, else takes
 * the weakest. Vision keeps a reasoning model's effort the same way, but a
 * model that does not reason only ever reads `off`, so after one the new model
 * starts at its own default instead of being pinned to no thinking.
 */
function levelAfterSwitch(
  role: ModelRole,
  previous: ThinkingLevel | null,
  previousConfig: ProviderModelConfig | undefined,
  config: ProviderModelConfig,
): ThinkingLevel {
  const levels = supportedThinkingLevels(config);
  const keep = previous !== null && levels.includes(previous);
  switch (role) {
    case 'agent':
      return levels[0] ?? 'off';
    case 'tool':
      return keep && previous !== null ? previous : (levels[0] ?? 'off');
    case 'vision':
      return keep && previous !== null && previousConfig?.reasoning === true ? previous : defaultVisionLevel(levels);
  }
}

/** The saved roles with the edits on top: what the page shows and what a save writes. */
export function draftRoles(view: ProvidersView, edits: RoleEdits): RolesDraft {
  const saved = savedRoles(view);
  const slot = (role: ModelRole): RoleSlot => {
    const edit = edits[role];
    const model = edit?.model ?? saved[role].model;
    if (edit?.level !== undefined) {
      return { model, level: edit.level };
    }
    const config = modelForKey(view, model)?.config;
    if (model === saved[role].model || config === undefined) {
      return { model, level: saved[role].level };
    }
    const previousConfig = modelForKey(view, saved[role].model)?.config;
    return { model, level: levelAfterSwitch(role, saved[role].level, previousConfig, config) };
  };
  const agent = slot('agent');
  const tool = slot('tool');
  return {
    agent,
    vision: slot('vision'),
    // An inherited Tool Model runs at the Agent's level, including an unsaved one.
    tool: tool.model === INHERIT ? { model: INHERIT, level: agent.level } : tool,
  };
}

/** The roles whose model or effort differ from the file; an inherited Tool Model's level is the Agent's. */
export function changedRoles(view: ProvidersView, draft: RolesDraft): readonly ModelRole[] {
  const saved = savedRoles(view);
  return ROLES.filter(
    (role) =>
      draft[role].model !== saved[role].model ||
      (draft[role].level !== saved[role].level && !(role === 'tool' && draft.tool.model === INHERIT)),
  );
}

/** How many values a save would change: a model and its effort count separately. */
export function changeCount(view: ProvidersView, draft: RolesDraft): number {
  const saved = savedRoles(view);
  let count = 0;
  for (const role of ROLES) {
    if (draft[role].model !== saved[role].model) {
      count += 1;
    }
    if (draft[role].level !== saved[role].level && !(role === 'tool' && draft.tool.model === INHERIT)) {
      count += 1;
    }
  }
  return count;
}

/** Records a picked model; picking the saved one again clears the edit, and either way the level edit goes. */
export function editModel(view: ProvidersView, edits: RoleEdits, role: ModelRole, model: string): RoleEdits {
  const next = { ...edits };
  if (model === savedRoles(view)[role].model) {
    delete next[role];
  } else {
    next[role] = { model };
  }
  return next;
}

/**
 * The edits left after a save. The roles that went through give way to the
 * file. The ones that did not are pinned to exactly what the save was sending:
 * an effort derived from the old file (a Tool Model keeping the Agent's level,
 * say) would otherwise be derived again from the half-saved one and change
 * under the admin before the retry.
 */
export function editsAfterSave(
  edits: RoleEdits,
  snapshot: ProvidersView,
  target: RolesDraft,
  saved: ReadonlySet<ModelRole>,
): RoleEdits {
  const next = { ...edits };
  for (const role of saved) {
    delete next[role];
  }
  for (const role of changedRoles(snapshot, target)) {
    const { model, level } = target[role];
    if (saved.has(role) || model === null) {
      continue;
    }
    next[role] = model === INHERIT || level === null ? { model } : { model, level };
  }
  return next;
}

export function editLevel(edits: RoleEdits, role: ModelRole, level: ThinkingLevel): RoleEdits {
  return { ...edits, [role]: { ...edits[role], level } };
}
