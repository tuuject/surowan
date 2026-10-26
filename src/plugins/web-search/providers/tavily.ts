import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { firstArray, mapHits } from './shared.ts';

/**
 * Tavily answers `POST /search` with `{ results: [{ title, url, content }] }`.
 * `include_answer`/`include_raw_content` stay off: the core only needs titles,
 * URLs and short snippets, and asking for more would bill more.
 */
export const tavily: SearchProviderSpec = {
  rule: searchProviderRule('tavily'),
  build: ({ query, count, endpoint, key }) => ({
    url: endpoint,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${key ?? ''}`,
    },
    body: JSON.stringify({
      query,
      max_results: count,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  }),
  parse: (payload) => mapHits(firstArray(payload, ['results']) ?? [], ['content', 'snippet', 'description']),
};

export default definePlugin({
  id: 'web-search-tavily',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, tavily)],
});
