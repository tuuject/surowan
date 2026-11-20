import { allConfiguredChats, hostIntakeSettings } from './platform/config/index.ts';
import type { RawConfig } from './platform/config/index.ts';
import { type DecisionGateSettings, resolveDecisionGate } from './platform/decision-gate.ts';
import { requestDecision } from './platform/decisions.ts';
import { HOST_KINDS } from './platform/im-host/identity.ts';
import type { SecretStore } from './platform/secrets.ts';

/** What the doctor reports about the Decisions entry gate. */
export interface DoctorDecisionGate {
  readonly status: 'disabled' | 'connected';
  readonly model: string | null;
  readonly base_url: string | null;
}

/**
 * The gate's own connectivity probe.
 *
 * A dangling `api_key` reference never fails `check-config` and never fails at
 * runtime either — the gate admits every batch with `secret_unresolved` and goes
 * quiet, which looks exactly like a gate that keeps rejecting. So when the gate
 * is enabled globally or on any Chat, `doctor` resolves the credential and sends
 * one minimal request, and any failure is a doctor failure.
 *
 * `fetchImpl` exists only so tests never reach the real service.
 */
export async function probeDoctorDecisionGate(
  config: RawConfig,
  secrets: SecretStore,
  options: { readonly fetchImpl?: typeof fetch | undefined } = {},
): Promise<DoctorDecisionGate> {
  const settings = enabledSettings(config);
  if (settings === undefined) {
    return { status: 'disabled', model: null, base_url: null };
  }
  if (settings.api_key === undefined) {
    throw new Error('telegram.decision_gate.api_key is required when the gate is enabled');
  }
  let apiKey: string;
  try {
    apiKey = await secrets.resolve(settings.api_key);
  } catch (error) {
    throw new Error(`Decision gate api_key cannot be read: ${messageOf(error)}`);
  }
  const result = await requestDecision({
    apiKey,
    baseUrl: settings.base_url,
    model: settings.model,
    state: {
      bot: { name: 'doctor', username: null },
      history: [],
      pending: [{ from: 'doctor', text: 'A connectivity probe for the entry gate.' }],
    },
    instructions: 'This is a connectivity probe. Answer yes when the probe text is not empty.',
    timeoutMs: settings.timeout_ms,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (!result.ok) {
    const status = result.status === undefined ? '' : ` (HTTP ${result.status})`;
    throw new Error(`Decision gate probe failed: ${result.code}${status}: ${result.detail}`);
  }
  return { status: 'connected', model: settings.model, base_url: settings.base_url };
}

/**
 * The effective settings of the first scope that turns the gate on: a Chat that
 * enables it alone still needs its credential probed, and the connection fields
 * are global, so either scope resolves the same endpoint.
 */
function enabledSettings(config: RawConfig): DecisionGateSettings | undefined {
  for (const { host, chat } of allConfiguredChats(config)) {
    const settings = resolveDecisionGate({ decision_gate: hostIntakeSettings(config, host).decision_gate }, chat);
    if (settings.enabled) {
      return settings;
    }
  }
  const section = HOST_KINDS.map((host) => hostIntakeSettings(config, host).decision_gate).find(
    (candidate) => candidate !== undefined,
  );
  if (section?.enabled !== true) {
    return undefined;
  }
  return resolveDecisionGate({ decision_gate: section });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
