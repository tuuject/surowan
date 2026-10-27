import { call, writeHeaders } from './core.ts';

/**
 * The web-search settings surface. The view never carries a credential: an
 * engine says whether a key is configured, and the write either stores a new
 * plaintext in `key.json` or reuses one that is already there.
 */

export type SearchKeyPolicy = 'required' | 'optional' | 'forbidden';

export interface SearchEngineView {
  readonly id: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly results: number;
  readonly timeout_seconds: number;
  readonly note: string;
  readonly key_configured: boolean;
}

export interface SearchProviderView {
  readonly id: string;
  readonly label: string;
  readonly default_endpoint: string | null;
  readonly key: SearchKeyPolicy;
  readonly query_limit: number;
  readonly supports_count: boolean;
}

export interface SearchConfigView {
  readonly revision: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly url_filters: readonly string[];
  readonly engines: readonly SearchEngineView[];
  readonly providers: readonly SearchProviderView[];
  /** DeepSeek provider aliases whose key may be reused. */
  readonly deepseek_keys: readonly string[];
}

export interface SearchEngineInput {
  readonly id: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly results: number | null;
  readonly timeout_seconds: number | null;
  readonly note: string | null;
  /** New plaintext; written to the key jar and never echoed back. */
  readonly api_key: string | null;
  /** Reuse the credential this engine already references. */
  readonly keep_api_key: boolean;
  /** Reuse a DeepSeek key configured for this model-provider alias. */
  readonly key_source: string | null;
}

export interface SearchConfigInput {
  readonly enabled: boolean;
  readonly url_filters: readonly string[];
  readonly engines: readonly SearchEngineInput[];
}

export interface SearchConfigResult extends SearchConfigView {
  readonly apply?: { readonly applied: readonly string[]; readonly restart_required: readonly string[] };
}

export function getSearchConfig(): Promise<SearchConfigView> {
  return call<SearchConfigView>('/search/config');
}

export function putSearchConfig(body: SearchConfigInput, revision: string): Promise<SearchConfigResult> {
  return call<SearchConfigResult>('/search/config', {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
