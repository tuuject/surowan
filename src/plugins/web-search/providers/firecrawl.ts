import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { asRecord, mapHits, resultList } from './shared.ts';

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
  // v1 answers `data: [...]`, v2 `data: { web: [...] }`; a v2 answer with no
  // web hits may drop the list but keeps `success: true` and its `data` object.
  parse: (payload) =>
    mapHits(
      resultList(
        payload,
        ['data', 'data.web', 'web', 'results'],
        (record) => record.success === true && asRecord(record.data) !== undefined,
      ),
      ['description', 'snippet', 'markdown'],
    ),
};

export default definePlugin({
  id: 'web-search-firecrawl',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, firecrawl)],
});
