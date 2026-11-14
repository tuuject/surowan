export const developer = {
  debugTitle: 'Debug payloads',
  debugDescription: 'Enable only when investigating model calls.',
  recordLabel: 'Record raw request payloads for debugging',
  recordDescription:
    'Saves the raw requests and responses of model calls, for troubleshooting and replay on the invocation page. Can use a lot of database space.',
  recordHint: 'Off by default. Changes apply to new model calls; turning it off does not clear existing payloads.',
  thinkingLabel: 'Record model thinking',
  thinkingDescription:
    'Saves the model thinking separately, so it can be expanded in the transcript and the timeline. Uses more database space.',
  thinkingHint: 'Off by default. Applies to model replies from now on.',
  stateMismatch:
    'The file setting differs from the running state ({{status}}). Apply the configuration file on the Settings page.',
  historyTitle: 'Payload history',
  historyDescription:
    'Clear saved model requests and responses. Other audit records are kept; affected invocations can no longer be replayed.',
  clearButton: 'Clear payloads',
  cleared: 'Cleared debug payloads for {{count}} model calls.',
  confirmTitle: 'Clear previously recorded raw request payloads?',
  confirmDescription:
    'This cannot be undone. Model requests and responses are cleared and other audit records are kept; affected invocations can no longer be replayed.',
  confirmClear: 'Confirm clear',
  modelsDevTitle: 'Model details source',
  modelsDevDescription:
    'Where context length, max output, accepted input and prices are looked up when models are added on the Providers page.',
  modelsDevLabel: 'Catalog address',
  modelsDevHint: 'Leave empty to use {{url}}. A mirror must serve the same format. Applies to the next lookup.',
  modelsDevReset: 'Use the default',
  modelsDevMismatch:
    'The file setting differs from the running state, which still looks up {{url}}. Apply the configuration file on the Settings page.',
};
