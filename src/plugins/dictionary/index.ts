import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createDictionaryTools, DictionaryStore } from './dictionary.ts';
import { createDictionaryInjector } from './injection.ts';

/**
 * The chat dictionary: entries injected into context per batch, plus the three
 * `execute` capabilities (lookup/add/update). Its tables, config section and
 * Admin routes stay in the core; see agent-doc/design/20261014 for the split.
 */
export default definePlugin({
  id: 'dictionary',
  skills: [join(import.meta.dirname, 'skills', 'dictionary')],
  capabilities: (scope) =>
    createDictionaryTools({
      store: new DictionaryStore(scope.orm),
      orm: scope.orm,
      invocationId: scope.context.invocationId,
      chatId: scope.context.chatId,
      privateChat: scope.context.chatId > 0n,
    }).map((tool) => capability(tool, true)),
  contextInjectors: [createDictionaryInjector()],
});
