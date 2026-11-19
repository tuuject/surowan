import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { Api, Model, Models, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { RawConfig } from './config/index.ts';

/**
 * The system-wide auxiliary ("tool") model that helper features run on, such as
 * the dictionary-merge suggestion.
 *
 * The tool model is a system capability, not dictionary configuration: it
 * reuses the provider registry, credentials and thinking-level support exactly
 * like the agent, and an unset value inherits the global agent settings — never
 * a per-chat override, because one group's chat model must not change a
 * system-wide helper call.
 */

export interface ToolModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ModelThinkingLevel;
  /** True when nothing is configured and the global agent settings are in use. */
  readonly inherited: boolean;
}

/**
 * Resolves the configured tool model, or the global agent defaults. `undefined`
 * when nothing is configured: the global triple is optional, and an incomplete
 * one means there is no model to inherit.
 */
export function resolveToolModel(config: RawConfig): ToolModelSelection | undefined {
  const configured = config.tool_model;
  if (configured !== undefined) {
    return {
      provider: configured.provider,
      model: configured.model,
      thinkingLevel: configured.thinking_level,
      inherited: false,
    };
  }
  const { provider, model, thinking_level } = config.agent;
  if (provider === undefined || model === undefined || thinking_level === undefined) {
    return undefined;
  }
  return { provider, model, thinkingLevel: thinking_level, inherited: true };
}

/** Builds the caller's own error class, so each feature keeps its codes and name. */
export type ToolModelErrorFactory = (message: string) => Error;

/** Pi's `reasoning` option excludes `off`; the level is chosen at call time. */
export function toolModelReasoningOption(
  level: ModelThinkingLevel,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  return level === 'off' ? undefined : level;
}

/**
 * Resolves the registered model behind a selection, refusing an unusable one.
 * The refusal messages are the shared contract; `error` decides which class a
 * caller reports them as. `input` is the modality the feature needs: text for
 * every tool-model consumer so far, image for the ones that must look at a
 * picture.
 */
export function requireToolModel(
  models: Models,
  selection: ToolModelSelection,
  error: ToolModelErrorFactory,
  input: 'text' | 'image' = 'text',
): Model<Api> {
  const model = models.getModel(selection.provider, selection.model);
  if (model === undefined) {
    throw error(`The tool model ${selection.provider}/${selection.model} is not registered in the running process`);
  }
  if (!model.input.includes(input)) {
    throw error(`The tool model ${selection.provider}/${selection.model} does not accept ${input} input`);
  }
  if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) {
    throw error(
      `The tool model ${selection.provider}/${selection.model} does not support thinking level ${selection.thinkingLevel}`,
    );
  }
  return model;
}

/** The compiled TypeBox validator guarding one reply contract. */
export interface ToolModelReplyValidator<T> {
  Check(value: unknown): value is T;
  Errors(value: unknown): readonly { readonly instancePath: string; readonly message: string }[];
}

/**
 * Extracts the JSON object between the first `{` and the last `}` of a
 * tool-model reply and validates it. `invalidLabel` completes the
 * schema-failure sentence (`The tool model returned <invalidLabel> (<first
 * five validator errors>)`), so each caller names its own contract while the
 * extraction rule stays shared.
 */
export function parseToolModelJson<T>(
  text: string,
  validator: ToolModelReplyValidator<T>,
  error: ToolModelErrorFactory,
  invalidLabel: string,
): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw error('The tool model did not return a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw error('The tool model returned invalid JSON');
  }
  if (!validator.Check(parsed)) {
    const detail = [...validator.Errors(parsed)]
      .slice(0, 5)
      .map((entry) => `${entry.instancePath || '/'}: ${entry.message}`)
      .join('; ');
    throw error(`The tool model returned ${invalidLabel} (${detail})`);
  }
  return parsed;
}
