import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { firstArray, mapHits } from './shared.ts';

/**
 * DeepSeek's search endpoint is not part of its chat API, so the adapter reads
 * the common `{ results: [{ title, url, snippet }] }` answer and the endpoint
 * stays overridable for a self-hosted or relay service speaking the same shape.
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
    body: JSON.stringify({ query, max_results: count }),
  }),
  parse: (payload) =>
    mapHits(firstArray(payload, ['results', 'data', 'web.results', 'search_results']) ?? [], [
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
