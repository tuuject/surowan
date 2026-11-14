export const headers = {
  header: 'Header name',
  value: 'Value',
  keepPlaceholder: 'Saved; leave empty to keep it',
  valuesRequired: 'After changing the API address, enter every header value again',
  add: 'Add header',
  needsName: 'Every header needs a name',
  listedTwice: 'Header {{name}} is listed twice',
  needsValue: 'Header {{name}} needs a value',
};

export const connection = {
  title: 'Connection',
  test: 'Test',
  baseUrl: 'API address',
  baseUrlHint: "The API address from the provider's docs, usually ending in /v1.",
  builtinHint: 'Built-in providers come with the address and format preset; only the API key is needed.',
  api: 'API format',
  apiHint: 'Not sure? Pick OpenAI (Chat Completions); most services support it.',
  responsesWarning: "Most providers don't support this API format. If you're not sure, pick OpenAI (Chat Completions).",
  builtinProvider: 'Built-in provider',
  apiKey: 'API Key',
  keepHint: 'Saved; leave empty to keep it',
  keepHintChanged: 'enter it again after changing the API address',
  headersTitle: 'Custom headers',
  headersHint: 'Only needed when the provider asks for it, such as an extra token some relay services require.',
  changedWarning:
    'For safety, changing the API address requires entering the API key and every header value again in the same save.',
  staleWarning:
    'The configuration changed since you started editing. Reload to edit the current version; your unsaved changes here will be discarded.',
  needsApiKey: 'Enter the API key again after changing the API address',
  headerRemoved: "Headers can't be removed while the API address changes: {{names}}",
};

export const wizard = {
  stepConnection: 'Connection',
  stepCredentials: 'API key',
  stepModels: 'Models',
  title: 'New provider: {{step}}',
  description: 'The provider takes effect as soon as it is created.',
  kind: 'Type',
  builtinKind: 'Built-in provider (pick from a list)',
  customKind: 'Custom (enter the address yourself, for relays or self-hosted services)',
  alias: 'Name',
  aliasHint:
    "Identifies the provider in the panel and can't be changed later. Start with a letter; use only letters, digits, underscores and hyphens, up to 64 characters.",
  aliasInvalid: 'Start with a letter and use only letters, digits, underscores or hyphens.',
  piProvider: 'Provider',
  loadingPresets: 'Loading built-in providers…',
  pickPreset: 'Pick a built-in provider',
  presetBaseUrl: 'API address: ',
  googleNote: 'Include the version in the address, for example ending in /v1beta.',
  apiKeyHint: "Create it in the provider's console. It is used to list and call models.",
  headersOptional: 'Custom headers (optional)',
  tempModeNote:
    "The provider isn't created yet, so the list is fetched with the API key you just entered. Only the models you select are added.",
  fetch: 'Fetch models',
  idsLabel: 'Or enter model IDs by hand (one per line, or separated by commas)',
  lookup: 'Look up model details',
  enterApiKeyFirst: 'Enter the API key first',
  enterModelId: 'Enter at least one model ID',
  confirmTitle: 'Confirm {{model}}',
  confirmDescription:
    'These details were looked up automatically and may be off. Check every item marked “to confirm” before saving.',
  next: 'Next',
  createProvider: 'Create provider',
};
