import { call, writeHeaders } from './core.ts';
import type { ModelApplySummary } from './models.ts';

export interface RestartResponse {
  readonly status: string;
}

export interface ConfigErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly generation: number;
  readonly active_hash: string;
  readonly file_hash: string;
  readonly restart_required: readonly string[];
  readonly last_error: ConfigErrorDetail | null;
}

export interface ConfigApplyResponse {
  readonly status: string;
  readonly applied: readonly string[];
  readonly restart_required: readonly string[];
  readonly outside_serve: readonly string[];
  readonly generation: number;
  readonly active_hash: string;
  readonly file_hash: string;
}

/** Asks a supervised deployment to restart; the process exits with code 75. */
export function restartServer(): Promise<RestartResponse> {
  return call<RestartResponse>('/restart', { method: 'POST' });
}

export function getConfigStatus(): Promise<ConfigStatus> {
  return call<ConfigStatus>('/config/status');
}

export interface DeveloperSettings {
  readonly revision: string;
  readonly record_model_payloads: boolean;
  readonly active_record_model_payloads: boolean;
  readonly record_agent_thinking: boolean;
  readonly active_record_agent_thinking: boolean;
}

export interface DeveloperUpdate {
  readonly record_model_payloads?: boolean;
  readonly record_agent_thinking?: boolean;
}

export function getDeveloperSettings(): Promise<DeveloperSettings> {
  return call<DeveloperSettings>('/developer');
}

export function updateDeveloperSettings(
  body: DeveloperUpdate,
  revision: string,
): Promise<DeveloperSettings & { readonly apply: ModelApplySummary }> {
  return call('/developer', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

/** Harness field values keyed by their dotted path below `agent`; `null` is an unset optional field. */
export type HarnessValues = Readonly<Record<string, number | boolean | null>>;

export interface HarnessSettings {
  readonly revision: string;
  /** The file on disk, with absent optional fields resolved to what the runtime uses. */
  readonly saved: HarnessValues;
  /** The configuration the running process uses. */
  readonly active: HarnessValues;
}

export function getHarnessSettings(): Promise<HarnessSettings> {
  return call<HarnessSettings>('/harness');
}

export function updateHarnessSettings(
  values: HarnessValues,
  revision: string,
): Promise<HarnessSettings & { readonly apply: ModelApplySummary }> {
  return call('/harness', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify({ values }),
  });
}

export function clearModelPayloads(): Promise<{ readonly cleared_model_calls: number }> {
  return call('/developer/model-payloads', { method: 'DELETE' });
}

export function applyConfigFile(): Promise<ConfigApplyResponse> {
  return call<ConfigApplyResponse>('/config/apply', { method: 'POST' });
}
