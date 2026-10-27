import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { mapHits, resultList } from './shared.ts';

/**
 * Brave's web endpoint is a GET with the subscription token in a header and
 * `{ web: { results: [{ title, url, description }] } }` in the body.
 */
export const brave: SearchProviderSpec = {
  rule: searchProviderRule('brave'),
  build: ({ query, count, endpoint, key }) => {
    const url = new URL(endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    return {
      url: url.href,
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'x-subscription-token': key ?? '',
      },
    };
  },
  // Brave omits `web` entirely when nothing matched; the `type: "search"`
  // envelope is what still identifies a well-formed empty answer.
  parse: (payload) =>
    mapHits(
      resultList(payload, ['web.results', 'results'], (record) => record.type === 'search'),
      ['description', 'snippet'],
    ),
};

export default definePlugin({
  id: 'web-search-brave',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, brave)],
});
