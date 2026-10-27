import type { FileConfig, RawConfig, SecretRef } from '../../platform/config/index.ts';
import type { ConfigEdit } from '../../platform/config/write.ts';
import { newKeyJarName } from '../../platform/key-jar.ts';
import {
  BUILTIN_SEARCH_PROVIDERS,
  compileUrlFilter,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_SECONDS,
  validateWebSearchSection,
  webSearchAvailable,
  type SearchEngineConfig,
  type SearchProviderRule,
  type WebSearchConfig,
} from '../../platform/web-search.ts';
import { AdminQueryError } from './audit/shared.ts';

/**
 * The panel's view of the `web_search` section and the translation of one
 * submitted form into a configuration edit.
 *
 * Secrets never travel back: the view says whether an engine has a credential,
 * and the write path turns a submitted plaintext into a new key-jar entry. The
 * submitted `key_source` reuses a DeepSeek key that is already configured for a
 * model provider, so the same credential never has to be copied by hand.
 */

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

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
  readonly key: SearchProviderRule['keyPolicy'];
  readonly query_limit: number;
  readonly supports_count: boolean;
}

export interface SearchConfigView {
  readonly revision: string;
  /** The configured switch; `active` also requires an enabled engine. */
  readonly enabled: boolean;
  readonly active: boolean;
  readonly url_filters: readonly string[];
  readonly engines: readonly SearchEngineView[];
  readonly providers: readonly SearchProviderView[];
  /** Provider aliases whose DeepSeek key may be reused for the search engine. */
  readonly deepseek_keys: readonly string[];
}

/** DeepSeek keys already configured for the model provider, by alias. */
export function reusableSearchCredentials(config: Pick<FileConfig, 'providers'>): Record<string, SecretRef> {
  return Object.fromEntries(
    Object.entries(config.providers)
      .filter(([, provider]) => provider.kind === 'builtin' && provider.provider === 'deepseek')
      .map(([alias, provider]) => [alias, provider.api_key]),
  );
}

export function searchConfigView(
  file: FileConfig,
  active: RawConfig,
  revision: string,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
): SearchConfigView {
  const section = file.web_search;
  const rules = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    revision,
    enabled: section !== undefined && section.enabled !== false,
    active: webSearchAvailable(active, providers),
    url_filters: section?.url_filters ?? [],
    engines: (section?.engines ?? []).map((engine) => {
      const provider = rules.get(engine.provider);
      return {
        id: engine.id,
        provider: engine.provider,
        enabled: engine.enabled !== false,
        endpoint: engine.endpoint ?? provider?.defaultEndpoint ?? '',
        results: engine.results ?? DEFAULT_SEARCH_RESULTS,
        timeout_seconds: engine.timeout_seconds ?? DEFAULT_SEARCH_TIMEOUT_SECONDS,
        note: engine.note ?? '',
        key_configured: engine.api_key !== undefined,
      };
    }),
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      default_endpoint: provider.defaultEndpoint ?? null,
      key: provider.keyPolicy,
      query_limit: provider.queryLimit,
      supports_count: provider.supportsResultCount,
    })),
    deepseek_keys: Object.keys(reusableSearchCredentials(file)),
  };
}

interface EngineSubmission {
  readonly id: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly results: number | null;
  readonly timeoutSeconds: number | null;
  readonly note: string | null;
  readonly key: { readonly plaintext?: string; readonly reuse?: string; readonly keep: boolean };
}

export interface ParsedSearchConfig {
  readonly section: WebSearchConfig;
  readonly keys: Readonly<Record<string, string>>;
}

/**
 * Validates one submitted form and turns it into the section the file stores.
 * Every rule the runtime applies is checked here first, so the panel answers
 * 400 with a usable message instead of a generic apply failure.
 */
export function parseSearchConfigBody(
  body: Record<string, unknown>,
  existing: WebSearchConfig | undefined,
  providers: readonly SearchProviderRule[] = BUILTIN_SEARCH_PROVIDERS,
  reusable: Readonly<Record<string, SecretRef>> = {},
): ParsedSearchConfig {
  if (typeof body.enabled !== 'boolean') {
    throw invalid('enabled must be a boolean');
  }
  const rules = new Map(providers.map((provider) => [provider.id, provider]));
  const previousEngines = new Map((existing?.engines ?? []).map((engine) => [engine.id, engine]));
  const submissions = readEngines(body.engines, rules);
  const keys: Record<string, string> = {};
  const engines: NonNullable<WebSearchConfig['engines']> = [];
  for (const submission of submissions) {
    const rule = rules.get(submission.provider);
    if (rule === undefined) {
      throw invalid(`engine ${submission.id} references unknown provider ${submission.provider}`);
    }
    const endpoint = submission.endpoint ?? rule.defaultEndpoint;
    if (endpoint === undefined || endpoint.length === 0) {
      throw invalid(`engine ${submission.id} (${rule.label}) requires an endpoint`);
    }
    const apiKey = resolveEngineKey(submission, rule, previousEngines.get(submission.id), reusable, keys);
    engines.push({
      id: submission.id,
      provider: submission.provider,
      enabled: submission.enabled,
      endpoint,
      ...(submission.results === null ? {} : { results: submission.results }),
      ...(submission.timeoutSeconds === null ? {} : { timeout_seconds: submission.timeoutSeconds }),
      ...(submission.note === null || submission.note.length === 0 ? {} : { note: submission.note }),
      ...(apiKey === undefined ? {} : { api_key: apiKey }),
    });
  }
  const urlFilters = readUrlFilters(body.url_filters);
  const section: WebSearchConfig = {
    enabled: body.enabled,
    engines,
    ...(urlFilters.length === 0 ? {} : { url_filters: urlFilters }),
  };
  try {
    validateWebSearchSection(section, providers);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  return { section, keys };
}

export function searchConfigEdits(parsed: ParsedSearchConfig): readonly ConfigEdit[] {
  return [{ path: ['web_search'], value: parsed.section, keys: parsed.keys }];
}

function readEngines(value: unknown, rules: ReadonlyMap<string, SearchProviderRule>): readonly EngineSubmission[] {
  if (!Array.isArray(value)) {
    throw invalid('engines must be an array');
  }
  if (value.length > 32) {
    throw invalid('at most 32 search engines may be configured');
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = asObject(entry, `engines[${index}]`);
    const id = requiredString(record.id, `engines[${index}].id`, 32);
    if (!ENGINE_ID_PATTERN.test(id)) {
      throw invalid(`engines[${index}].id must match ${ENGINE_ID_PATTERN.source}`);
    }
    if (ids.has(id)) {
      throw invalid(`duplicate engine id ${id}`);
    }
    ids.add(id);
    const provider = requiredString(record.provider, `engines[${index}].provider`, 64);
    const rule = rules.get(provider);
    if (rule === undefined) {
      throw invalid(`engine ${id} references unknown provider ${provider}`);
    }
    const endpoint = optionalString(record.endpoint, `engines[${index}].endpoint`, 2_048);
    const results = optionalInteger(record.results, `engines[${index}].results`, 1, 10);
    if (!rule.supportsResultCount && results !== null) {
      throw invalid(`engine ${id} (${rule.label}) does not accept a result count`);
    }
    const timeoutSeconds = optionalInteger(record.timeout_seconds, `engines[${index}].timeout_seconds`, 5, 30);
    const note = optionalString(record.note, `engines[${index}].note`, 1_000);
    const keepApiKey = record.keep_api_key === true;
    const keySource = optionalString(record.key_source, `engines[${index}].key_source`, 80);
    const plaintext = optionalString(record.api_key, `engines[${index}].api_key`, 4_096);
    if (keySource !== null && plaintext !== null) {
      throw invalid(`engine ${id} cannot set both api_key and key_source`);
    }
    return {
      id,
      provider,
      enabled: record.enabled !== false,
      endpoint,
      results,
      timeoutSeconds,
      note,
      key: {
        ...(plaintext === null ? {} : { plaintext }),
        ...(keySource === null ? {} : { reuse: keySource }),
        keep: keepApiKey,
      },
    };
  });
}

function resolveEngineKey(
  submission: EngineSubmission,
  rule: SearchProviderRule,
  previous: SearchEngineConfig | undefined,
  reusable: Readonly<Record<string, SecretRef>>,
  keys: Record<string, string>,
): SecretRef | undefined {
  if (submission.key.plaintext !== undefined) {
    const name = newKeyJarName();
    keys[name] = submission.key.plaintext;
    return { jar: name };
  }
  if (submission.key.reuse !== undefined) {
    if (rule.id !== 'deepseek') {
      throw invalid(`engine ${submission.id}: only a DeepSeek engine can reuse a model provider key`);
    }
    const reference = reusable[submission.key.reuse];
    if (reference === undefined) {
      throw invalid(`engine ${submission.id}: unknown DeepSeek provider alias ${submission.key.reuse}`);
    }
    return reference;
  }
  if (submission.key.keep && previous?.api_key !== undefined) {
    // A kept key belongs to the provider it was issued for; carrying it to a
    // different provider would send one vendor's credential to another.
    if (previous.provider !== submission.provider) {
      throw invalid(`engine ${submission.id} changed provider; enter a new api_key`);
    }
    return previous.api_key;
  }
  if (rule.keyPolicy === 'required') {
    throw invalid(`engine ${submission.id} (${rule.label}) requires an api_key`);
  }
  return undefined;
}

function readUrlFilters(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid('url_filters must be an array');
  }
  if (value.length > 50) {
    throw invalid('at most 50 URL filters may be configured');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      throw invalid(`url_filters[${index}] must be a string of 1-512 characters`);
    }
    try {
      compileUrlFilter(entry);
    } catch {
      throw invalid(`url_filters[${index}] is not a valid regular expression`);
    }
    return entry;
  });
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalid(`${label} must be a string of 1-${maxLength} characters`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalid(`${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function invalid(message: string): AdminQueryError {
  return new AdminQueryError('search_invalid', message, 400);
}
