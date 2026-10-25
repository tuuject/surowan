import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
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
