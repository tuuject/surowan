import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { webSearchAvailable } from '../../platform/web-search.ts';
import { definePlugin } from '../plugin.ts';
import { WEB_SEARCH_PROVIDERS } from './extension.ts';
import { createWebSearchTool } from './web-search.ts';

/**
 * The web-search core: the capability, its shared request handling and the
 * extension point every provider plugin contributes to. It owns nothing
 * provider-specific, and it disappears entirely while search is off or no
 * engine is enabled — capability and skill alike.
 */
export default definePlugin({
  id: 'web-search',
  // Search reads the public web exactly like web_fetch does, so both hosts
  // that mount network capabilities mount it.
  hosts: ['telegram', 'playground'],
  extensionPoints: [WEB_SEARCH_PROVIDERS],
  skills: [join(import.meta.dirname, 'skills', 'web-search')],
  available: (config, extensions) =>
    webSearchAvailable(
      config,
      extensions(WEB_SEARCH_PROVIDERS).map((provider) => provider.rule),
    ),
  capabilities: (scope) => {
    const providers = [...scope.extensions(WEB_SEARCH_PROVIDERS)];
    if (providers.length === 0) {
      return [];
    }
    return [
      capability(
        createWebSearchTool({
          audit: scope.audit,
          invocationDeadline: scope.deadline,
          readConfig: scope.readConfig,
          providers,
          ...(scope.secrets === undefined ? {} : { secrets: scope.secrets }),
          ...(scope.steer === undefined ? {} : { steer: scope.steer }),
        }),
        false,
      ),
    ];
  },
});
