import { call, writeHeaders } from './core.ts';
import type { SecretInput, SecretSource } from './keychain.ts';
import type { ModelApplySummary } from './models.ts';

/**
 * The Decisions entry gate's settings surface. Every field the file may leave
 * out reports the value the runtime actually uses, and the credential never
 * travels back: the view says whether a key is configured (and, for a panel
 * session, where it comes from).
 */

/** The values as the runtime resolves them; absent file fields already hold their default. */
export interface DecisionGateValues {
  readonly enabled: boolean;
  readonly mode: 'shadow' | 'enforce';
  readonly threshold: number;
  readonly history_messages: number;
  readonly pending_messages: number;
  readonly instructions: string;
  readonly model: string;
  readonly base_url: string;
  readonly timeout_ms: number;
}

export interface DecisionGateView {
  readonly revision: string;
  /** The file on disk. */
  readonly saved: DecisionGateValues;
  /** The configuration the running process uses. */
  readonly active: DecisionGateValues;
  /** Whether the global section names a credential; never the credential itself. */
  readonly key_configured: boolean;
  /** Panel sessions only: the keychain entry, environment variable or command the reference names. */
  readonly key_source?: SecretSource;
}

/** The six fields a Chat may override; the connection fields are global only. */
export type DecisionGateChatField =
  | 'enabled'
  | 'mode'
  | 'threshold'
  | 'history_messages'
  | 'pending_messages'
  | 'instructions';

/** One patch: an absent field is kept, `null` removes it from the file. */
export type DecisionGatePatch = { readonly [K in keyof DecisionGateValues]?: DecisionGateValues[K] | null } & {
  /** A fresh key (string or `{ value, name? }`) or an existing entry. */
  readonly api_key?: SecretInput | null;
};

export interface DecisionGateResult extends DecisionGateView {
  readonly apply: ModelApplySummary & { readonly outside_serve: readonly string[] };
}

export function getDecisionGate(): Promise<DecisionGateView> {
  return call<DecisionGateView>('/decision-gate');
}

export function updateDecisionGate(patch: DecisionGatePatch, revision: string): Promise<DecisionGateResult> {
  return call<DecisionGateResult>('/decision-gate', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(patch),
  });
}
