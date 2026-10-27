import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { mapHits, resultList } from './shared.ts';

/**
 * Exa's `/search` takes a POST with `numResults` and wants the contents it
 * should return; asking for a short `text` keeps the payload small.
 */
export const exa: SearchProviderSpec = {
  rule: searchProviderRule('exa'),
  build: ({ query, count, endpoint, key }) => ({
    url: endpoint,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': key ?? '',
    },
    body: JSON.stringify({
      query,
      numResults: count,
      type: 'auto',
      contents: { text: { maxCharacters: 1_200 } },
    }),
  }),
  parse: (payload) => mapHits(resultList(payload, ['results']), ['text', 'summary', 'snippet']),
};

export default definePlugin({
  id: 'web-search-exa',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, exa)],
});
