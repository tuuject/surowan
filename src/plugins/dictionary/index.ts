import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createDictionaryTools } from './dictionary.ts';
import { createDictionaryInjector } from './injection.ts';
import { DictionaryStore } from './dictionary-store.ts';

/**
 * The chat dictionary: entries injected into context per batch, plus the three
 * `execute` capabilities (lookup/add/update). Its tables, config section and
 * Admin routes stay in the core; see agent-doc/design/20261014 for the split.
 */
export default definePlugin({
  id: 'dictionary',
  hosts: ['telegram'],
  skills: [join(import.meta.dirname, 'skills', 'dictionary')],
  capabilities: (scope) =>
    // Dictionary scopes are Telegram chats. A room's chat id is internal and
    // must never be read as one, so the tools are not offered to a room.
    scope.context.hostKind === 'telegram'
      ? createDictionaryTools({
          store: new DictionaryStore(scope.orm),
          orm: scope.orm,
          invocationId: scope.context.invocationId,
          chatId: scope.context.chatId,
          privateChat: scope.context.chatId > 0n,
        }).map((tool) => capability(tool, true))
      : [],
  contextInjectors: [createDictionaryInjector()],
});
