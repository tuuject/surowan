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

export interface ModelApplySummary {
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
}

export interface ModelSwitchResponse extends ModelState {
  readonly apply: ModelApplySummary;
}

/** Pi's thinking levels, weakest first. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function switchAgentModel(request: ModelSwitchRequest, revision: string): Promise<ModelSwitchResponse> {
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

export function switchVisionModel(request: ModelSwitchRequest, revision: string): Promise<ProviderWriteResponse> {
  return call<ProviderWriteResponse>('/vision', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(request),
  });
}
