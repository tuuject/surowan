import { activeVisionModel } from './config-resolve.ts';
import type { RawConfig } from './config.ts';

/**
 * The warning catalog is the stable contract between runtime modules and the
 * Admin Panel. A module records an event warning by code plus a JSON `variables`
 * object; the panel picks the template for that code and never evaluates the
 * variables as markup or code. Standing warnings are derived from the active
 * configuration on every read and are never persisted as history.
 */

export type WarningSeverity = 'warning' | 'critical';

export type WarningCategory = 'developer' | 'models' | 'runtime' | 'security';

export type WarningKind = 'standing' | 'event';

export interface WarningDefinition {
  readonly kind: WarningKind;
  readonly category: WarningCategory;
  readonly severity: WarningSeverity;
}

export const WARNING_DEFINITIONS = {
  developer_payload_recording: { kind: 'standing', category: 'developer', severity: 'warning' },
  agent_model_missing: { kind: 'standing', category: 'models', severity: 'critical' },
  vision_model_missing: { kind: 'standing', category: 'models', severity: 'warning' },
  invocation_failure_rate: { kind: 'event', category: 'runtime', severity: 'critical' },
  admin_login_failures: { kind: 'event', category: 'security', severity: 'warning' },
} as const satisfies Record<string, WarningDefinition>;

export type WarningCode = keyof typeof WARNING_DEFINITIONS;

export type EventWarningCode = {
  [Code in WarningCode]: (typeof WARNING_DEFINITIONS)[Code]['kind'] extends 'event' ? Code : never;
}[WarningCode];

export function warningDefinition(code: WarningCode): WarningDefinition {
  return WARNING_DEFINITIONS[code];
}

export function isEventWarningCode(code: WarningCode): code is EventWarningCode {
  return WARNING_DEFINITIONS[code].kind === 'event';
}

export interface StandingWarning {
  readonly kind: 'standing';
  readonly code: WarningCode;
  readonly category: WarningCategory;
  readonly severity: WarningSeverity;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly updated_at: string;
}

/** The number of recent terminal invocations the failure-rate warning samples. */
export const INVOCATION_FAILURE_SAMPLE_SIZE = 100;
/** Failure rate above this fraction raises `invocation_failure_rate`. */
export const INVOCATION_FAILURE_RATE_THRESHOLD = 0.5;
/** Consecutive username/password failures that raise `admin_login_failures`. */
export const LOGIN_FAILURE_THRESHOLD = 5;
/** Default days a read warning is retained before cleanup. */
export const WARNING_READ_RETENTION_DAYS = 30;

const AGENT_MODEL_FIELDS = ['provider', 'model', 'thinking_level'] as const;
const VISION_MODEL_FIELDS = ['provider', 'model'] as const;

/**
 * Conditions that are true right now, in display order. A condition that clears
 * simply stops being returned; there is no resolved/opened history.
 */
export function standingWarnings(config: RawConfig, now = new Date()): StandingWarning[] {
  const updatedAt = now.toISOString();
  const standing: StandingWarning[] = [];
  const entry = (code: WarningCode, variables: Readonly<Record<string, unknown>>): StandingWarning => {
    const definition = warningDefinition(code);
    return {
      kind: 'standing',
      code,
      category: definition.category,
      severity: definition.severity,
      variables,
      updated_at: updatedAt,
    };
  };
  if (config.developer.record_model_payloads) {
    standing.push(entry('developer_payload_recording', { enabled: true }));
  }
  const missingAgentFields = AGENT_MODEL_FIELDS.filter((field) => config.agent[field] === undefined);
  if (missingAgentFields.length > 0) {
    standing.push(entry('agent_model_missing', { missing_fields: missingAgentFields }));
  }
  if (activeVisionModel(config.vision) === undefined) {
    const missingVisionFields = VISION_MODEL_FIELDS.filter((field) => config.vision[field] === undefined);
    standing.push(entry('vision_model_missing', { missing_fields: missingVisionFields }));
  }
  return standing;
}
