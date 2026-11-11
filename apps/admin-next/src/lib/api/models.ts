import { call, writeHeaders } from './core.ts';
import type { ProviderWriteResponse } from './providers.ts';

export interface ModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
}

export interface CurrentModel extends ModelOption {
  readonly context_window: number;
  readonly max_tokens: number;
  /** Live level; switching the agent model resets it to the new model's weakest one. */
  readonly thinking_level: ThinkingLevel | null;
}

export interface ModelState {
  readonly current: CurrentModel;
  readonly options: readonly ModelOption[];
}

export interface ModelSwitchRequest {
  readonly provider: string;
  readonly model: string;
}

/**
 * Confirms stopping the Invocations still running on the model being replaced.
 * Without it, a switch they would outlive is refused with `model_in_use`.
 */
export interface AbortRunningOption {
  readonly abort_running?: boolean;
}

export interface ModelApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
}

export interface ChatThinkingReset {
  readonly chat_id: string;
  readonly previous: ThinkingLevel;
  readonly current: ThinkingLevel;
}

export interface ModelSwitchResponse extends ModelState {
  /** The file's revision after the switch; the next write in a chain carries it. */
  readonly revision: string;
  /** Invocations stopped because they still ran on the replaced model. */
  readonly aborted_invocations: number;
  readonly apply: ModelApplySummary;
  readonly chat_thinking_resets: readonly ChatThinkingReset[];
}

/** Pi's thinking levels, weakest first. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function switchAgentModel(
  request: ModelSwitchRequest & AbortRunningOption,
  revision: string,
): Promise<ModelSwitchResponse> {
  return call<ModelSwitchResponse>('/model', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(request),
  });
}

/** Hot: the next invocation runs with the new level. */
export function setAgentThinkingLevel(thinkingLevel: ThinkingLevel, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/thinking-level', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ thinking_level: thinkingLevel }),
  });
}

/**
 * Without `thinking_level` the stored effort stays while the new model accepts
 * it; otherwise the server drops it and the model's default applies.
 */
export function switchVisionModel(
  request: ModelSwitchRequest & { readonly thinking_level?: ThinkingLevel },
  revision: string,
): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/vision', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(request),
  });
}
