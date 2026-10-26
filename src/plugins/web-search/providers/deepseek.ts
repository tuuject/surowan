import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { mapHits, resultList } from './shared.ts';

/**
 * DeepSeek's search tool API (`POST /v1/tools/search`) takes the chat API key,
 * a query of at most 128 characters and a `count`. The parser reads the common
 * `{ results: [{ title, url, snippet }] }` answer, and the endpoint stays
 * overridable for a relay speaking the same shape.
 */
export const deepseek: SearchProviderSpec = {
  rule: searchProviderRule('deepseek'),
  build: ({ query, count, endpoint, key }) => ({
    url: endpoint,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${key ?? ''}`,
    },
    body: JSON.stringify({ query, count }),
  }),
  parse: (payload) =>
    mapHits(resultList(payload, ['results', 'data', 'web.results', 'search_results']), [
      'snippet',
      'content',
      'description',
      'text',
    ]),
};

export default definePlugin({
  id: 'web-search-deepseek',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, deepseek)],
});
