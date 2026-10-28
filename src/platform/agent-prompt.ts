import { PERSONA_PROMPT } from './agent-protocol.ts';
import { stripHtmlComments } from './prompt-markdown.ts';
import { renderPromptTemplate, type PromptTemplateValues, validatePromptTemplate } from './prompt-template.ts';

/** One global/group replay override, bounded like the configuration prompt files. */
export const MAX_PROMPT_OVERRIDE_CHARS = 65_536;

/**
 * The ordered layers of the stable system prompt. `prefix` is runtime-owned
 * text (core protocol, conversation mode, product knowledge, capabilities and
 * skill index and media/sticker handling) and is never replaceable; `global`
 * and `group` are the raw comment-stripped templates of `agent.system_prompt`
 * and the chat's `instructions`. Composition adds the runtime-owned persona
 * section header only when the final rendered templates contain a persona.
 */
export interface AgentPromptLayers {
  readonly prefix: string;
  readonly global: string;
  readonly group: string;
}

/** Which replaceable layer an override targets. */
export type PromptLayer = 'global' | 'group';

export class PromptOverrideError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PromptOverrideError';
    this.code = code;
  }
}

/**
 * Rebuilds a system prompt from its layers exactly as `ContextBuilder` does:
 * fixed runtime prefix, optional persona header, rendered global template,
 * rendered group template. Empty segments are dropped and the rest joined by
 * a blank line. Templates use the caller's pinned runtime configuration.
 */
export function composeAgentPrompt(layers: AgentPromptLayers, values: PromptTemplateValues): string {
  const global = renderPromptTemplate(layers.global, values);
  const group = renderPromptTemplate(layers.group, values);
  // Replay replaces the templates after building the prefix; decide the
  // boundary here so temporary overrides match the same saved configuration.
  return [layers.prefix, global.length > 0 || group.length > 0 ? PERSONA_PROMPT : '', global, group]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * Validates and normalizes one replay prompt override. It goes through the same
 * boundary as the configuration loader's prompt files — HTML comments stripped
 * before the text reaches the model — plus BOM and NUL checks and the template
 * variable allowlist. The returned text is a raw template: rendering happens
 * later against the values from the active configuration.
 */
export function preparePromptOverride(value: string, layer: PromptLayer): string {
  if (value.length > MAX_PROMPT_OVERRIDE_CHARS) {
    throw new PromptOverrideError(
      'replay_prompt_too_large',
      `${layer} prompt must be at most ${MAX_PROMPT_OVERRIDE_CHARS} characters`,
    );
  }
  if (value.includes('\u0000')) {
    throw new PromptOverrideError('replay_prompt_invalid', `${layer} prompt contains a NUL character`);
  }
  if (value.includes('\uFEFF')) {
    throw new PromptOverrideError('replay_prompt_invalid', `${layer} prompt contains a BOM character`);
  }
  const template = stripHtmlComments(value);
  if (layer === 'global' && template.trim().length === 0) {
    throw new PromptOverrideError(
      'replay_prompt_empty',
      'global prompt must not be empty; the global layer cannot be removed, only the group layer can',
    );
  }
  try {
    validatePromptTemplate(template, `${layer} prompt`);
  } catch {
    throw new PromptOverrideError(
      'replay_prompt_invalid',
      `${layer} prompt contains an unsupported template variable or a malformed template expression`,
    );
  }
  return template;
}
