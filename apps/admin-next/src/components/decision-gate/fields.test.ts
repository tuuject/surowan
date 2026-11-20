import { describe, expect, test } from 'vitest';
import type { DecisionGateValues } from '../../lib/api/decision-gate.ts';
import { DECISION_GATE_FIELDS, type DraftValue, draftOf, parseDraft } from './fields.ts';

/**
 * The draft-to-patch conversion. The form compares raw drafts, so untouched
 * whitespace (the server keeps it) is not an edit, while a touched text field
 * is normalised before it is sent.
 */
const saved: DecisionGateValues = {
  enabled: false,
  mode: 'shadow',
  threshold: 0.57,
  history_messages: 10,
  pending_messages: 10,
  instructions: '\nQuestion?\n',
  model: 'typesafe/jev-1.14',
  base_url: 'https://openrouter.ai/api/alpha',
  timeout_ms: 3_000,
};

describe('decision gate draft', () => {
  test('an untouched draft with padding around the question is not a change', () => {
    expect(parseDraft(draftOf(saved), saved)).toEqual({ changes: {}, errors: {} });
  });

  test('editing another field leaves the untouched question out of the patch', () => {
    const draft: Record<string, DraftValue> = { ...draftOf(saved), threshold: '0.7' };
    expect(parseDraft(draft, saved).changes).toEqual({ threshold: 0.7 });
  });

  test('editing the question sends the normalised text', () => {
    const draft: Record<string, DraftValue> = { ...draftOf(saved), instructions: '  Question?  ' };
    expect(parseDraft(draft, saved).changes).toEqual({ instructions: 'Question?' });
  });

  test('a number written with trailing zeroes is not a change', () => {
    const draft: Record<string, DraftValue> = { ...draftOf(saved), threshold: '0.570' };
    expect(parseDraft(draft, saved).changes).toEqual({});
  });

  test('an invalid edit is not in the patch but still counts as an edit', () => {
    const draft: Record<string, DraftValue> = { ...draftOf(saved), threshold: '' };
    const parsed = parseDraft(draft, saved);
    expect(parsed.changes).toEqual({});
    expect(parsed.errors.threshold).toBeDefined();
    const initial = draftOf(saved);
    expect(DECISION_GATE_FIELDS.filter((spec) => draft[spec.key] !== initial[spec.key])).toHaveLength(1);
  });
});
