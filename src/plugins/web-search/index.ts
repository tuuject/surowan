import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { defaultSearchBase } from '../../platform/search-vendors.ts';
import { definePlugin } from '../plugin.ts';
import { createWebSearchTool } from './web-search.ts';

/** One configured vendor behind `execute.call`; off unless `web_search` is set. */
export default definePlugin({
  id: 'web-search',
  // Read-only network access is part of the Playground's fixed capability set.
  hosts: ['telegram', 'playground'],
  skills: [join(import.meta.dirname, 'skills', 'web-search')],
  capabilities: ({ audit, config, deadline, resolveSecret }) => {
    const settings = config.web_search;
    if (settings === undefined || settings.enabled === false) {
      return [];
    }
    const vendor = settings.vendor;
    if (vendor === undefined) {
      return [];
    }
    const baseUrl = settings.base_url ?? defaultSearchBase(vendor, settings.api_key !== undefined);
    const reference = settings.api_key;
    return [
      capability(
        createWebSearchTool({
          audit,
          invocationDeadline: deadline,
          vendor,
          baseUrl,
          count: settings.count ?? 5,
          ...(settings.timeout_seconds === undefined ? {} : { timeoutMs: settings.timeout_seconds * 1_000 }),
          ...(reference === undefined
            ? {}
            : {
                apiKey: async () => {
                  if (resolveSecret === undefined) {
                    throw new Error('web_search api_key cannot be resolved in this process');
                  }
                  return await resolveSecret(reference);
                },
              }),
        }),
        false,
      ),
    ];
  },
});
