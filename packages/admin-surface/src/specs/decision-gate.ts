import type { EndpointSpec } from '../types.ts';

/**
 * The Decisions entry gate's settings page and its read-only decision list.
 * The write patches the global `telegram.decision_gate` section and sends new
 * plaintext keys into the keychain; the list is the audit surface shadow mode
 * is reviewed through, so it stays a plain read.
 */
export const DECISION_GATE_SPECS: readonly EndpointSpec[] = [
  {
    command: 'decision-gate show',
    method: 'GET',
    path: 'decision-gate',
    summary: 'Show the saved and running entry gate settings and whether a key is configured',
  },
  {
    command: 'decision-gate update',
    method: 'PUT',
    path: 'decision-gate',
    body: true,
    revision: 'config',
    summary:
      'Patch the global entry gate: omitted fields are kept, null removes a field, and a new api_key is stored in the keychain',
  },
  {
    command: 'decision-gate decisions',
    method: 'GET',
    path: 'decision-gate/decisions',
    params: ['chat', 'limit', 'offset', 'as-of=as_of'],
    summary: 'List the entry gate decisions, newest first, optionally filtered by Chat',
  },
];
