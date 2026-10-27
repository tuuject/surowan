import { RE2JS } from 're2js';
import type { RawConfig, SecretRef } from './config/index.ts';

/**
 * The shared contract of the built-in web-search providers.
 *
 * The catalogue is plain data, so the configuration validator can reject an
 * unknown provider without importing any plugin module. Each provider plugin
 * contributes the same rule through the web-search plugin's extension point
 * and adds its own request construction and response parsing; the rule itself
 * stays the single source of truth for what the panel and the validator see.
 */

export type SearchKeyPolicy = 'required' | 'optional' | 'forbidden';

export interface SearchProviderRule {
  readonly id: string;
  readonly label: string;
  /** Absent when the provider has no public default and the engine must set one. */
  readonly defaultEndpoint?: string;
  readonly keyPolicy: SearchKeyPolicy;
  /** Longest query the provider accepts, in characters. */
  readonly queryLimit: number;
  /** False when the provider decides its own page size (SearXNG instance default). */
  readonly supportsResultCount: boolean;
}

export const DEFAULT_SEARCH_RESULTS = 5;
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 15;

export const BUILTIN_SEARCH_PROVIDERS: readonly SearchProviderRule[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    defaultEndpoint: 'https://api.tavily.com/search',
    keyPolicy: 'required',
    queryLimit: 400,
    supportsResultCount: true,
  },
  {
    id: 'brave',
    label: 'Brave Search',
    defaultEndpoint: 'https://api.search.brave.com/res/v1/web/search',
    keyPolicy: 'required',
    queryLimit: 400,
    supportsResultCount: true,
  },
  {
    id: 'exa',
    label: 'Exa',
    defaultEndpoint: 'https://api.exa.ai/search',
    keyPolicy: 'required',
    queryLimit: 500,
    supportsResultCount: true,
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    defaultEndpoint: 'https://api.firecrawl.dev/v2/search',
    keyPolicy: 'required',
    queryLimit: 500,
    supportsResultCount: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultEndpoint: 'https://api.deepseek.com/v1/tools/search',
    keyPolicy: 'required',
    queryLimit: 128,
    supportsResultCount: true,
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    // Self-hosted instances have no shared address and need no credential.
    keyPolicy: 'forbidden',
    queryLimit: 500,
    supportsResultCount: false,
  },
  {
    id: 'youcom',
    label: 'You.com',
    defaultEndpoint: 'https://ydc-index.io/v1/search',
    keyPolicy: 'required',
    queryLimit: 500,
    supportsResultCount: true,
  },
];

export type SearchEngineConfig = NonNullable<NonNullable<RawConfig['web_search']>['engines']>[number];
export type WebSearchConfig = NonNullable<RawConfig['web_search']>;

/** One configured engine with every default filled in. */
export interface ResolvedSearchEngine {
  readonly id: string;
  readonly provider: SearchProviderRule;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly results: number;
  readonly timeoutSeconds: number;
  readonly note: string;
  readonly apiKey: SecretRef | undefined;
}

/**
 * The engines the configuration carries, defaults filled in and unknown
 * providers skipped. Validation rejects an unknown provider before a running
 * process ever publishes such a configuration; skipping here keeps a stale
 * file from crashing a reader.
 */
export function resolveSearchEngines(
  config: Pick<RawConfig, 'web_search'>,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): readonly ResolvedSearchEngine[] {
  const engines = config.web_search?.engines ?? [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return engines.flatMap((engine) => {
    const provider = byId.get(engine.provider);
    if (provider === undefined) {
      return [];
    }
    return [
      {
        id: engine.id,
        provider,
        enabled: engine.enabled !== false,
        endpoint: engine.endpoint ?? provider.defaultEndpoint ?? '',
        results: engine.results ?? DEFAULT_SEARCH_RESULTS,
        timeoutSeconds: engine.timeout_seconds ?? DEFAULT_SEARCH_TIMEOUT_SECONDS,
        note: engine.note ?? '',
        apiKey: engine.api_key,
      },
    ];
  });
}

/** Enabled engines only, in configuration order. */
export function enabledSearchEngines(
  config: Pick<RawConfig, 'web_search'>,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): readonly ResolvedSearchEngine[] {
  return resolveSearchEngines(config, providers).filter((engine) => engine.enabled);
}

/**
 * Whether web search exists at all right now. A missing section, the switch
 * off, or no enabled engine are the same state: the capability and its skill
 * are invisible, and no invocation may request a search.
 */
export function webSearchAvailable(
  config: Pick<RawConfig, 'web_search'>,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): boolean {
  return config.web_search?.enabled !== false && enabledSearchEngines(config, providers).length > 0;
}

export function searchProviderRules(
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): ReadonlyMap<string, SearchProviderRule> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

/**
 * Cross-field rules for the `web_search` section. The schema already bounds
 * every scalar; this rejects unregistered providers, missing or forbidden
 * credentials, a missing SearXNG address, bad endpoints and bad URL filters.
 */
export function validateWebSearchSection(
  section: WebSearchConfig | undefined,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): void {
  if (section === undefined) {
    return;
  }
  const byId = searchProviderRules(providers);
  const engineIds = new Set<string>();
  for (const engine of section.engines ?? []) {
    if (engineIds.has(engine.id)) {
      throw new Error(`Duplicate web_search engine id: ${engine.id}`);
    }
    engineIds.add(engine.id);
    const provider = byId.get(engine.provider);
    if (provider === undefined) {
      throw new Error(`web_search engine ${engine.id} references unknown provider ${engine.provider}`);
    }
    const endpoint = engine.endpoint ?? provider.defaultEndpoint;
    if (endpoint === undefined) {
      throw new Error(`web_search engine ${engine.id} (${provider.label}) requires an endpoint`);
    }
    validateSearchEndpoint(endpoint, `web_search engine ${engine.id} endpoint`);
    if (provider.keyPolicy === 'required' && engine.api_key === undefined) {
      throw new Error(`web_search engine ${engine.id} (${provider.label}) requires an api_key`);
    }
    if (provider.keyPolicy === 'forbidden' && engine.api_key !== undefined) {
      throw new Error(`web_search engine ${engine.id} (${provider.label}) does not accept an api_key`);
    }
    if (provider.supportsResultCount === false && engine.results !== undefined) {
      throw new Error(`web_search engine ${engine.id} (${provider.label}) does not accept a result count`);
    }
  }
  for (const pattern of section.url_filters ?? []) {
    compileUrlFilter(pattern);
  }
}

/** Absolute HTTP(S), no credentials, query, fragment or trailing whitespace. */
export function validateSearchEndpoint(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    value !== value.trim() ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query or fragment`);
  }
}

/**
 * Compiles one user-supplied URL filter with RE2 semantics. Matching runs
 * synchronously on provider-supplied URLs, so a backtracking engine would let
 * a rule like `(a+)+$` stall the whole process; RE2 is linear in the input and
 * rejects the lookaround and backreference syntax that needs backtracking.
 */
export function compileUrlFilter(pattern: string): RE2JS {
  try {
    return RE2JS.compile(pattern);
  } catch {
    throw new Error(`Invalid web_search URL filter: ${pattern}`);
  }
}

/**
 * A predicate that is true when a URL matches any configured filter. A rule
 * matches anywhere in the URL, so `csdn` drops `https://blog.csdn.net/...`
 * without an anchor.
 */
export function urlFilterMatcher(filters: readonly string[]): (url: string) => boolean {
  const compiled = filters.map(compileUrlFilter);
  return (url) => compiled.some((pattern) => pattern.test(url));
}
