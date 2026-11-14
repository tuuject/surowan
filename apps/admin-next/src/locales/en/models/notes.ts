export const feedback = {
  savedRestartRequired: 'Saved, restart required',
  restartWaiting_one: '{{count}} setting takes effect after a restart.',
  restartWaiting_other: '{{count}} settings take effect after a restart.',
  appliedAndWaiting_one: '{{applied}} applied; {{count}} takes effect after a restart.',
  appliedAndWaiting_other: '{{applied}} applied; {{count}} take effect after a restart.',
  applied: 'Applied',
  appliedDetail_one: '{{count}} setting applied.',
  appliedDetail_other: '{{count}} settings applied.',
  saved: 'Saved',
  savedDescription: 'Saved to the configuration file',
  writeConflict: 'The configuration changed while you were editing. It has been reloaded; try once more.',
};

export const match = {
  matched: 'Details based on {{model}} from {{provider}} on models.dev',
  crossProviderNote: ' (listed under another provider)',
  fuzzyNote: ' (similar but not identical name; check every item)',
};

export const source = {
  missing: 'not found',
  from: 'from {{source}}',
  crossProvider: 'models.dev (listed under another provider)',
  fuzzy: 'models.dev (similar model name)',
  highestPrice: 'models.dev (highest listed price)',
  reasoningDefault: 'not found; added as not thinking',
  costDefault: 'not found; added as 0',
};

export const switchConfirm = {
  title: 'Stop running invocations and switch?',
  description:
    "Invocations still running on the current model: {{count}}. Switching stops them now, and the messages they are answering won't get a reply. Delegated tasks are not affected, and new messages go to the new model.",
  confirm: 'Stop and switch',
  stopped_one: 'Stopped {{count}} running invocation.',
  stopped_other: 'Stopped {{count}} running invocations.',
};

export const validation = {
  idRequired: 'Model ID is required',
  inputRequired: 'Select at least one input: text or image',
  positiveInteger: 'Enter a positive whole number',
  maxTokensExceeds: "Max output can't exceed the context length",
  costRequired: 'Fill in all four prices (use 0 if free)',
};
