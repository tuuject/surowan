import { contribute, definePlugin } from '../../plugin.ts';
import { searchProviderRule, WEB_SEARCH_PROVIDERS, type SearchProviderSpec } from '../extension.ts';
import { asArray, asRecord, mapHits, resultList } from './shared.ts';
import type { RawSearchHit } from '../extension.ts';

/**
 * You.com's Web Search API sends the key in `X-API-Key` on every request.
 * A web hit carries a short `description` plus an array of `snippets`; the
 * excerpts are the useful part, with `description` as the fallback.
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
        'x-api-key': key ?? '',
      },
    };
  },
  parse: (payload) => resultList(payload, ['results.web', 'results', 'hits']).map(withSnippets),
};

function withSnippets(entry: unknown): RawSearchHit {
  const [hit = {}] = mapHits([entry], ['description', 'snippet']);
  const excerpts = (asArray(asRecord(entry)?.snippets) ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return excerpts.length === 0 ? hit : { ...hit, snippet: excerpts.join(' ') };
}

export default definePlugin({
  id: 'web-search-youcom',
  hosts: ['telegram', 'playground'],
  dependencies: ['web-search'],
  extensions: [contribute(WEB_SEARCH_PROVIDERS, youcom)],
});
