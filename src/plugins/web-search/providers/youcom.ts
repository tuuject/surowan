import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { firstArray, mapHits } from './shared.ts';

/**
 * You.com's search API accepts an optional key: the free endpoint answers
 * without one, so the header is only sent when the engine configured a key.
 */
export const youcom: SearchProviderSpec = {
  rule: searchProviderRule('youcom'),
  build: ({ query, count, endpoint, key }) => {
    const url = new URL(endpoint);
    url.searchParams.set('query', query);
    url.searchParams.set('count', String(count));
    return {
      url: url.href,
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        ...(key === undefined ? {} : { 'x-api-key': key }),
      },
    };
  },
  parse: (payload) =>
    mapHits(firstArray(payload, ['results.web', 'results', 'hits']) ?? [], ['description', 'snippet']),
};

export default definePlugin({
  id: 'web-search-youcom',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, youcom)],
});
