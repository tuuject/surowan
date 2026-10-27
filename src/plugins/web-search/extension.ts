import { BUILTIN_SEARCH_PROVIDERS, type SearchProviderRule } from '../../platform/web-search.ts';
import { defineExtensionPoint } from '../plugin.ts';

/**
 * The extension contract a provider plugin contributes to. `web-search`
 * declares `WEB_SEARCH_PROVIDERS`; every provider plugin depends on it and
 * contributes exactly one spec, so the set of usable providers is decided by
 * plugins rather than by a switch in the core.
 */

/** One result as the provider returned it, before normalization. */
export interface RawSearchHit {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
}

export interface SearchRequestInput {
  /** Already trimmed to the provider's query limit. */
  readonly query: string;
  readonly count: number;
  /** Effective endpoint, default or configured override. */
  readonly endpoint: string;
  /** Resolved credential; absent for providers that do not need one. */
  readonly key: string | undefined;
}

export interface SearchHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface SearchProviderSpec {
  readonly rule: SearchProviderRule;
  /** Builds one HTTP request; never resolves configuration or credentials. */
  build(request: SearchRequestInput): SearchHttpRequest;
  /**
   * Reads a successful JSON body. A payload that does not look like this
   * provider's answer is a parse failure, reported by the core as
   * `invalid_response`; an empty result is `[]`, not an error.
   */
  parse(payload: unknown): readonly RawSearchHit[];
}

export const WEB_SEARCH_PROVIDERS = defineExtensionPoint<SearchProviderSpec>(
  'web-search.providers',
  (spec) => spec.rule.id,
);

/** The bundled rule for one provider id; a plugin cannot invent a provider. */
export function searchProviderRule(id: string): SearchProviderRule {
  const rule = BUILTIN_SEARCH_PROVIDERS.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`Unknown search provider rule: ${id}`);
  }
  return rule;
}
