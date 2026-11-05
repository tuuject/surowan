import type { EndpointSpec } from '../types.ts';

/**
 * Web-search settings page. The write rewrites the whole `web_search` section
 * and sends new plaintext keys into the key jar.
 */
export const SEARCH_SPECS: readonly EndpointSpec[] = [
  {
    command: 'search show',
    method: 'GET',
    path: 'search/config',
    summary: 'Show the saved search engines, URL filters and provider capabilities',
  },
  {
    command: 'search update',
    method: 'PUT',
    path: 'search/config',
    body: true,
    revision: 'config',
    summary: 'Replace the whole search section; new api_key values go to the key jar',
  },
];
