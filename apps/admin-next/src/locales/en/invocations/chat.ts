/**
 * Invocation Overview chat strings. English is the source catalog;
 * the other locales' `invocations/chat.ts` mirror it key for key.
 */
export const chat = {
  batch: 'Messages queued',
  batchPending: 'Messages queued, not read yet',
  batchSkipped: 'Messages queued, not handed to the model',
  finished: 'Run finished',
  history_one: '{{count}} earlier message in context',
  history_other: '{{count}} earlier messages in context',
  summaryTools_one: '{{count}} tool call',
  summaryTools_other: '{{count}} tool calls',
  summarySkills_one: '{{count}} skill',
  summarySkills_other: '{{count}} skills',
  summaryFailedModelCalls_one: '{{count}} failed model call',
  summaryFailedModelCalls_other: '{{count}} failed model calls',
  summaryPrivateTexts_one: '{{count}} private note',
  summaryPrivateTexts_other: '{{count}} private notes',
  summarySteps_one: '{{count}} step',
  summarySteps_other: '{{count}} steps',
  summarySeparator: ', ',
  skill: 'Used skill <name>{{name}}</name>',
  tool: 'Used tool <name>{{name}}</name>',
  toolSearch: 'Searched tools for “{{query}}”',
  toolHelp: 'Read how to use <name>{{name}}</name>',
  modelCall: 'Model call <name>{{name}}</name>',
  noResult: 'No result recorded',
  image: 'Generated image',
  file: 'File',
};
