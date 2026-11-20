import type { DecisionGatePatch, DecisionGateValues } from '@/lib/api/decision-gate.ts';

/**
 * Field metadata for the entry gate forms. The bounds mirror the configuration
 * schema so a typo is caught before the round trip; the server still validates
 * every value (and the address and cross-field rules only there). Numbers are
 * edited as text so a half-typed value is not coerced away.
 */
export interface DecisionGateFieldSpec {
  readonly key: keyof DecisionGateValues;
  readonly kind: 'boolean' | 'mode' | 'integer' | 'number' | 'text';
  /** A text field whose empty value removes the field from the file. */
  readonly nullable?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
}

export const DECISION_GATE_FIELDS: readonly DecisionGateFieldSpec[] = [
  { key: 'enabled', kind: 'boolean' },
  { key: 'mode', kind: 'mode', options: ['shadow', 'enforce'] },
  { key: 'threshold', kind: 'number', min: 0, max: 1 },
  { key: 'history_messages', kind: 'integer', min: 0, max: 50 },
  { key: 'pending_messages', kind: 'integer', min: 1, max: 50 },
  { key: 'instructions', kind: 'text', nullable: true },
  { key: 'model', kind: 'text' },
  { key: 'base_url', kind: 'text' },
  { key: 'timeout_ms', kind: 'integer', min: 500, max: 10_000 },
];

/** The global section's fields a Chat override may also set. */
export const DECISION_GATE_BEHAVIOR_FIELDS = DECISION_GATE_FIELDS.slice(0, 6);

export function fieldSpec(key: keyof DecisionGateValues): DecisionGateFieldSpec {
  const spec = DECISION_GATE_FIELDS.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    throw new Error(`Unknown decision gate field ${key}`);
  }
  return spec;
}

export type DraftValue = string | boolean;

export interface DraftError {
  /** Key below `decisionGate.errors`. */
  readonly key: 'integer' | 'number' | 'min' | 'max' | 'required' | 'option';
  readonly limit?: number;
}

export function draftOf(values: DecisionGateValues): Record<string, DraftValue> {
  const draft: Record<string, DraftValue> = {};
  for (const spec of DECISION_GATE_FIELDS) {
    const value = values[spec.key];
    draft[spec.key] = typeof value === 'boolean' ? value : String(value);
  }
  return draft;
}

/** One field's draft text as a value, or the reason it does not parse. */
export function parseField(
  spec: DecisionGateFieldSpec,
  raw: DraftValue,
): string | number | boolean | null | DraftError {
  if (spec.kind === 'boolean') {
    return raw === true;
  }
  const text = String(raw).trim();
  if (spec.kind === 'mode') {
    return spec.options?.includes(text) === true ? text : { key: 'option' };
  }
  if (spec.kind === 'text') {
    if (text.length > 0) {
      return text;
    }
    return spec.nullable === true ? null : { key: 'required' };
  }
  if (text.length === 0) {
    return { key: 'number' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { key: 'number' };
  }
  if (spec.kind === 'integer' && !Number.isInteger(value)) {
    return { key: 'integer' };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { key: 'min', limit: spec.min };
  }
  if (spec.max !== undefined && value > spec.max) {
    return { key: 'max', limit: spec.max };
  }
  return value;
}

/**
 * How many fields the raw draft changed, including values that do not parse.
 * The form uses this for its dirty state and its discard action: an invalid
 * edit is still an edit the user must be able to undo.
 */
export function draftChangeCount(
  draft: Readonly<Record<string, DraftValue>>,
  initial: Readonly<Record<string, DraftValue>>,
): number {
  return DECISION_GATE_FIELDS.filter((spec) => draft[spec.key] !== initial[spec.key]).length;
}

/**
 * Splits a draft into the patch fields that differ from the saved file and the
 * fields that do not parse. Only changed fields are sent: the write is a patch,
 * so an untouched field keeps whatever the file (or another editor) holds.
 *
 * A field whose raw draft is still the draft the form started with is not an
 * edit, even when parsing would normalise it: the server keeps whitespace, so
 * trimming an untouched question on every unrelated save would rewrite it.
 */
export function parseDraft(
  draft: Readonly<Record<string, DraftValue>>,
  saved: DecisionGateValues,
  initial: Readonly<Record<string, DraftValue>> = draftOf(saved),
): {
  readonly changes: Omit<DecisionGatePatch, 'api_key'>;
  readonly errors: Record<string, DraftError>;
} {
  const changes: Record<string, unknown> = {};
  const errors: Record<string, DraftError> = {};
  for (const spec of DECISION_GATE_FIELDS) {
    const raw = draft[spec.key];
    if (raw === undefined) {
      continue;
    }
    const value = parseField(spec, raw);
    if (typeof value === 'object' && value !== null) {
      errors[spec.key] = value as DraftError;
      continue;
    }
    if (raw === initial[spec.key]) {
      continue;
    }
    if (value !== saved[spec.key]) {
      changes[spec.key] = value;
    }
  }
  return { changes: changes as Omit<DecisionGatePatch, 'api_key'>, errors };
}
