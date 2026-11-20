/**
 * The Decisions entry gate settings page. English is the source catalog;
 * `zh-CN/decision-gate.ts` mirrors this structure key for key.
 *
 * Copy stays to labels, placeholders and state: how the gate works and its
 * limits are documented once in the user guide, not repeated on the page.
 */
export const decisionGate = {
  behaviourTitle: 'Behaviour',
  connectionTitle: 'Connection',
  enabled: 'Enabled',
  mode: 'Mode',
  modeShadow: 'Record only',
  modeEnforce: 'Enforce',
  threshold: 'Threshold',
  historyMessages: 'History messages',
  pendingMessages: 'Pending messages',
  instructions: 'Question',
  useDefaultQuestion: 'Use the default question',
  questionResetHint: 'The default question is restored when you save.',
  model: 'Model',
  baseUrl: 'Address',
  apiKey: 'API key',
  timeout: 'Timeout (ms)',
  keyFromEntry: 'Using the keychain entry {{name}}',
  on: 'On',
  off: 'Off',
  running: 'Running: {{value}}',
  loadFailed: 'Failed to load the entry gate settings',
  errors: {
    integer: 'Enter a whole number',
    number: 'Enter a number',
    min: 'Must be at least {{limit}}',
    max: 'Must be at most {{limit}}',
    required: 'Required',
    option: 'Choose one of the listed options',
  },
  unchanged: 'No unsaved changes',
  pending_one: '{{count}} unsaved change',
  pending_other: '{{count}} unsaved changes',
  invalid: 'Fix the highlighted fields before saving.',
  save: 'Save and apply',
  saving: 'Saving…',
  discard: 'Discard changes',
  conflictTitle: 'The configuration changed elsewhere',
  conflictBody:
    'The settings changed elsewhere after this page loaded, so nothing was saved. Reload to edit the current settings; unsaved changes here are lost.',
};
