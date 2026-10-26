import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { firstArray, mapHits } from './shared.ts';

/**
 * SearXNG is self-hosted: the endpoint is required and carries no credential.
 * Only the JSON output is usable, so the request asks for it explicitly; a 403
 * usually means the instance disabled that format, which the core reports.
 */
export const searxng: SearchProviderSpec = {
  rule: searchProviderRule('searxng'),
  build: ({ query, endpoint }) => {
    const url = new URL(endpoint);
    if (!url.pathname.replace(/\/+$/, '').endsWith('/search')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
    }
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    return {
      url: url.href,
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    };
  },
  parse: (payload) => mapHits(firstArray(payload, ['results']) ?? [], ['content', 'snippet', 'description']),
};

export default definePlugin({
  id: 'web-search-searxng',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, searxng)],
});
