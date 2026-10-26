import type { SecretStore } from '../../platform/secrets.ts';
import { type ResolvedSearchEngine, urlFilterMatcher } from '../../platform/web-search.ts';
import type { ToolAudit } from '../../store/tool-audit.ts';
import { classifyStatus, networkError, WebSearchError } from './errors.ts';
import type { RawSearchHit, SearchHttpRequest, SearchProviderSpec, SearchRequestInput } from './extension.ts';
import { formatResults, normalizeHit } from './format.ts';

/**
 * One search request: credential resolution, the frozen request settings, the
 * bounded HTTP read and the provider's own parser.
 */

const RESPONSE_MAX_BYTES = 256 * 1024;
const QUERY_MAX_CHARS = 500;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface SearchExecution {
  readonly result: string;
  readonly results: number;
  readonly filtered: number;
  readonly truncated: boolean;
}

/**
 * Freezes the engine's settings into the request input. Called once per call,
 * before the audit row opens, so a failed credential never records a request
 * that was not sent.
 */
export async function buildRequest(
  provider: SearchProviderSpec,
  engine: ResolvedSearchEngine,
  query: string,
  count: number | undefined,
  secrets: SecretStore | undefined,
): Promise<SearchRequestInput> {
  let key: string | undefined;
  if (engine.apiKey !== undefined) {
    if (secrets === undefined) {
      throw new WebSearchError(
        'secret_unresolved',
        `Engine ${engine.id} needs an api_key and no secret store is wired`,
      );
    }
    try {
      key = await secrets.resolve(engine.apiKey);
    } catch {
      throw new WebSearchError(
        'secret_unresolved',
        `Engine ${engine.id} cannot resolve its api_key; fix the credential reference before searching`,
      );
    }
  } else if (provider.rule.keyPolicy === 'required') {
    throw new WebSearchError('secret_unresolved', `Provider ${provider.rule.label} requires an api_key`);
  }
  return {
    query: trimChars(query, Math.min(QUERY_MAX_CHARS, provider.rule.queryLimit)),
    count: count ?? engine.results,
    endpoint: engine.endpoint,
    key,
  };
}

export async function executeSearch(input: {
  readonly audit: ReturnType<ToolAudit['start']>;
  readonly engine: ResolvedSearchEngine;
  readonly provider: SearchProviderSpec;
  readonly request: SearchRequestInput;
  readonly query: string;
  readonly filters: readonly string[];
  readonly deadline: number;
  readonly fetchImpl: typeof fetch;
  readonly outerSignal?: AbortSignal;
}): Promise<SearchExecution> {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) {
    throw new WebSearchError('invocation_timeout', 'The invocation deadline was reached before the search started');
  }
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(input.engine.timeoutSeconds * 1_000, remaining)));
  const signal = input.outerSignal === undefined ? timeout : AbortSignal.any([input.outerSignal, timeout]);
  const built: SearchHttpRequest = input.provider.build(input.request);
  let response: Response;
  try {
    response = await input.fetchImpl(built.url, {
      method: built.method,
      headers: { ...built.headers },
      ...(built.body === undefined ? {} : { body: built.body }),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    throw networkError(error, input.outerSignal, timeout);
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel();
    throw new WebSearchError(
      'redirect_rejected',
      'The provider redirected the search request; redirects are not followed',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    const failure = classifyStatus(response.status, input.provider, input.request.key);
    throw new WebSearchError(failure.code, failure.message);
  }
  let bytes: Uint8Array;
  try {
    // The timeout keeps running while the body streams, so a provider that
    // stalls after its headers is a timeout too, not a generic network error.
    bytes = await readBounded(response, RESPONSE_MAX_BYTES);
  } catch (error) {
    throw networkError(error, input.outerSignal, timeout);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebSearchError('invalid_response', 'The provider did not return valid JSON');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new WebSearchError('invalid_response', 'The provider returned an unexpected response shape');
  }
  let raw: readonly RawSearchHit[];
  try {
    raw = input.provider.parse(payload);
  } catch {
    throw new WebSearchError('invalid_response', `Could not read ${input.provider.rule.label}'s response`);
  }
  // A provider may answer 200 with an error envelope. An empty list is a valid
  // "no results"; an error field with no hits is not.
  const errorField = (payload as Record<string, unknown>).error;
  if (raw.length === 0 && errorField !== undefined && errorField !== null && errorField !== false) {
    throw new WebSearchError('invalid_response', `The provider reported an error: ${input.provider.rule.label}`);
  }
  const normalized = raw.flatMap((hit) => {
    const value = normalizeHit(hit);
    return value === undefined ? [] : [value];
  });
  const filtered = urlFilterMatcher(input.filters);
  const kept = normalized.filter((hit) => !filtered(hit.url));
  const limit = input.provider.rule.supportsResultCount ? Math.max(1, input.request.count) : Number.POSITIVE_INFINITY;
  const limited = kept.slice(0, limit);
  const formatted = formatResults(input.engine, input.provider, input.query, limited, normalized.length - kept.length);
  input.audit.succeed(formatted.text);
  return {
    result: formatted.text,
    results: limited.length,
    filtered: normalized.length - kept.length,
    truncated: formatted.truncated,
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new WebSearchError('response_too_large', `The response exceeds ${maxBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Characters, not UTF-16 units, so a surrogate pair is never split. */
function trimChars(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : characters.slice(0, limit).join('');
}
