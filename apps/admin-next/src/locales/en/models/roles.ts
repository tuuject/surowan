export const roles = {
  pageDescription:
    "Choose the model for each of the bot's jobs and how hard it thinks. Saved changes apply right away.",
  form: {
    pending_one: '{{count}} unsaved change',
    pending_other: '{{count}} unsaved changes',
    unchanged: 'No unsaved changes',
    saved: 'All changes saved',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard changes',
    partial: 'Saved in part. {{message}} The rest of your changes are still here.',
    refreshFailed:
      'Your changes were sent, but the page could not reload the configuration: {{message}} Reload the page before saving again.',
    missingModel: '{{model}} is no longer configured. Choose another model and save again.',
    cardChanged: 'Unsaved changes',
  },
  manageProviders: 'Manage providers',
  addProvider: 'Add a provider',
  noProvidersTitle: 'No providers yet',
  noProvidersDescription:
    'Add a provider and the models you want on the Providers page, then come back to give them jobs.',
  modelLabel: 'Model',
  thinkingLabel: 'Thinking effort',
  levelUnset: 'Not set',
  unset: 'Not set',
  notReasoning: 'This model has no thinking effort to adjust',
  searchModels: 'Search models',
  noMatchingModels: 'No model matches this search.',
  useAs: 'Use as',
  useAsAria: 'Use {{model}} as',
  agent: {
    title: 'Agent model',
    short: 'Agent',
    description: 'The main model that reads chats and decides how to reply. Without it, the bot does not reply.',
    resetsNote: 'Resets to the weakest level when the model changes',
  },
  vision: {
    title: 'Vision model',
    short: 'Vision',
    description:
      "Describes images and stickers: the Agent's image reading and sticker indexing rely on it. Without it, both are unavailable.",
  },
  tool: {
    title: 'Tool Model',
    short: 'Tool',
    description:
      'Runs background tasks such as dictionary merges and group memory. Follows the Agent model unless set.',
    defaultGroup: 'Default',
    inherit: 'Inherit Agent model',
    levelInherited: 'Follows the Agent model',
  },
};

export const kind = {
  builtin: 'Built-in',
  custom: 'Custom',
};

export const apiFormat = {
  openaiCompletions: 'OpenAI (Chat Completions)',
  openaiResponses: 'OpenAI (Responses)',
  anthropicMessages: 'Anthropic',
  googleGenerativeAi: 'Google',
};

export const modality = {
  text: 'Text',
  image: 'Image',
};

export const toolModel = {
  savedInherited: 'Tool Model now inherits the Agent model',
  saved: 'Tool Model switched; thinking effort is {{level}}',
  conflict: 'The settings changed elsewhere while you were editing. The page has refreshed; choose again.',
};
