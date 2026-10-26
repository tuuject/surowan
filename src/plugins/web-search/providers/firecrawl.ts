import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { asRecord, asArray, firstArray, mapHits } from './shared.ts';

/**
 * Firecrawl's v2 search returns `{ success, data: { web: [...] } }`; older
 * deployments answer with a bare `data` array, so both shapes are read.
 */
export const firecrawl: SearchProviderSpec = {
  rule: searchProviderRule('firecrawl'),
  build: ({ query, count, endpoint, key }) => ({
    url: endpoint,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${key ?? ''}`,
    },
    body: JSON.stringify({ query, limit: count, sources: ['web'] }),
  }),
  parse: (payload) => {
    const data = asRecord(payload)?.data;
    const array = asArray(data);
    return mapHits(array ?? firstArray(payload, ['data.web', 'web', 'results']) ?? [], [
      'description',
      'snippet',
      'markdown',
    ]);
  },
};

export default definePlugin({
  id: 'web-search-firecrawl',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, firecrawl)],
});
