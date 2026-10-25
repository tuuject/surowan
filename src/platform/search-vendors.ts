/**
 * Search vendors behind `web_search`: one request and one reply shape each.
 * Pure functions; the plugin adds auditing, deadlines and rendering. Any
 * service that speaks the `tavily` shape can be reached through `base_url`.
 */
import Type from 'typebox';
import type { Static } from 'typebox';
import Compile from 'typebox/compile';

export type SearchVendorId = 'tavily' | 'brave' | 'exa' | 'firecrawl' | 'deepseek' | 'searxng' | 'you';

export interface SearchVendorSpec {
  readonly label: string;
  /** `null` when the deployment must supply the address (SearXNG). */
  readonly defaultBaseUrl: string | null;
  /** `false` for a vendor that answers anonymously (SearXNG, You.com's free tier). */
  readonly keyRequired: boolean;
  /** The longest query it accepts; a longer one is clipped before sending. */
  readonly queryMax: number;
}

export const SEARCH_VENDORS: Readonly<Record<SearchVendorId, SearchVendorSpec>> = {
  // Tavily documents a 400-character maximum for its query.
  tavily: { label: 'Tavily', defaultBaseUrl: 'https://api.tavily.com', keyRequired: true, queryMax: 400 },
  // Brave allows 600; 400 is a conservative clip that never fails a request.
  brave: {
    label: 'Brave Search',
    defaultBaseUrl: 'https://api.search.brave.com',
    keyRequired: true,
    queryMax: 400,
  },
  exa: { label: 'Exa', defaultBaseUrl: 'https://api.exa.ai', keyRequired: true, queryMax: 500 },
  firecrawl: { label: 'Firecrawl', defaultBaseUrl: 'https://api.firecrawl.dev', keyRequired: true, queryMax: 500 },
  deepseek: { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', keyRequired: true, queryMax: 128 },
  searxng: { label: 'SearXNG', defaultBaseUrl: null, keyRequired: false, queryMax: 500 },
  // Keyed and keyless You.com answer at different hosts (`defaultSearchBase`).
  you: { label: 'You.com', defaultBaseUrl: 'https://ydc-index.io', keyRequired: false, queryMax: 500 },
};

/** You.com's keyless search; 100 searches a day per address, then 429. */
const YOU_FREE_BASE = 'https://api.you.com';

/** The longest query any vendor accepts; each vendor clips to its own limit. */
export const MAX_SEARCH_QUERY_CHARS = 500;

function clipQuery(vendor: SearchVendorId, query: string): string {
  const limit = SEARCH_VENDORS[vendor].queryMax;
  return query.length > limit ? query.slice(0, limit) : query;
}

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly date?: string;
}

export interface SearchRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The address a vendor is asked at: the configured one, else its own. */
export function defaultSearchBase(vendor: SearchVendorId, hasKey: boolean): string {
  if (vendor === 'you' && !hasKey) {
    return YOU_FREE_BASE;
  }
  const spec = SEARCH_VENDORS[vendor];
  if (spec.defaultBaseUrl === null) {
    throw new Error(`${spec.label} requires base_url`);
  }
  return spec.defaultBaseUrl;
}

function trimmed(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Completes an API root or a `/v1` root; any other prefix is used as given. */
function deepSeekToolsRoot(base: string): string {
  const url = new URL(trimmed(base));
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/v1') {
    url.pathname = '/v1/tools';
    return trimmed(url.href);
  }
  return trimmed(base);
}

/** `/v1/tools/search`, whether the deployment gave a root or the full endpoint. */
function deepSeekSearchUrl(base: string): string {
  const root = deepSeekToolsRoot(base);
  return root.endsWith('/search') ? root : `${root}/search`;
}

function jsonHeaders(auth: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { accept: 'application/json', 'content-type': 'application/json', ...auth };
}

function bearer(key: string | undefined): Readonly<Record<string, string>> {
  return key === undefined ? {} : { authorization: `Bearer ${key}` };
}

function queryUrl(base: string, path: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(`${trimmed(base)}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

/** A keyless vendor gets `key === undefined`; validation already rejected it. */
export function buildSearchRequest(
  vendor: SearchVendorId,
  baseUrl: string,
  key: string | undefined,
  query: string,
  count: number,
): SearchRequest {
  const q = clipQuery(vendor, query);
  switch (vendor) {
    case 'tavily':
      return {
        url: `${trimmed(baseUrl)}/search`,
        method: 'POST',
        headers: jsonHeaders(bearer(key)),
        body: JSON.stringify({
          query: q,
          max_results: count,
          search_depth: 'basic',
          include_answer: false,
        }),
      };
    case 'brave':
      return {
        url: queryUrl(baseUrl, '/res/v1/web/search', { q, count: String(count) }),
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(key === undefined ? {} : { 'x-subscription-token': key }),
        },
      };
    case 'exa':
      return {
        url: `${trimmed(baseUrl)}/search`,
        method: 'POST',
        headers: jsonHeaders(key === undefined ? {} : { 'x-api-key': key }),
        body: JSON.stringify({
          query: q,
          numResults: count,
          contents: { text: { maxCharacters: 2_000 } },
        }),
      };
    case 'firecrawl':
      return {
        url: `${trimmed(baseUrl)}/v2/search`,
        method: 'POST',
        headers: jsonHeaders(bearer(key)),
        body: JSON.stringify({ query: q, limit: count }),
      };
    case 'deepseek':
      // need_content stays false: whole pages do not belong in search context.
      return {
        url: deepSeekSearchUrl(baseUrl),
        method: 'POST',
        headers: jsonHeaders(bearer(key)),
        body: JSON.stringify({ query: q, count, need_content: false }),
      };
    case 'searxng':
      return {
        url: queryUrl(baseUrl, '/search', { q, format: 'json' }),
        method: 'GET',
        headers: { accept: 'application/json' },
      };
    case 'you':
      if (key !== undefined) {
        return {
          url: `${trimmed(baseUrl)}/v1/search`,
          method: 'POST',
          headers: jsonHeaders({ 'x-api-key': key }),
          body: JSON.stringify({ query: q, count }),
        };
      }
      return {
        url: queryUrl(baseUrl, '/v1/agents/search', { query: q, count: String(count) }),
        method: 'GET',
        headers: { accept: 'application/json' },
      };
  }
}

// Reply shapes, validated at the boundary; a mismatch is an invalid response.

const HitFields = {
  title: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  raw_content: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  snippet: Type.Optional(Type.String()),
  snippets: Type.Optional(Type.Array(Type.String())),
  date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  published_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // SearXNG names the field this way.
  publishedDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  page_age: Type.Optional(Type.Union([Type.String(), Type.Null()])),
} as const;

const HitSchema = Type.Object(HitFields, { additionalProperties: true });

const ResultsReply = Type.Object({ results: Type.Array(HitSchema) }, { additionalProperties: true });

const BraveReply = Type.Object(
  {
    // A bare `{}` is unreadable, not an empty result set.
    web: Type.Object({ results: Type.Optional(Type.Array(HitSchema)) }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

const FirecrawlReply = Type.Object(
  {
    data: Type.Union([
      Type.Array(HitSchema),
      Type.Object({ web: Type.Optional(Type.Array(HitSchema)) }, { additionalProperties: true }),
    ]),
  },
  { additionalProperties: true },
);

const YouReply = Type.Object(
  {
    results: Type.Object(
      {
        web: Type.Optional(Type.Array(HitSchema)),
        news: Type.Optional(Type.Array(HitSchema)),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** One result as the validators above allow it; derived so the fields live once. */
type HitValue = Static<typeof HitSchema>;

const validators = {
  results: Compile(ResultsReply),
  brave: Compile(BraveReply),
  firecrawl: Compile(FirecrawlReply),
  you: Compile(YouReply),
} as const;

function hitsOf(rows: readonly HitValue[]): readonly SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const rawUrl = typeof row.url === 'string' ? row.url : '';
    // Canonicalise the URL: a vendor could otherwise slip CR/LF and a fake
    // numbered result into the rendered list.
    if (!isHttpUrl(rawUrl)) {
      continue;
    }
    const url = new URL(rawUrl).href;
    const text = firstText(row);
    const date = row.date ?? row.published_date ?? row.publishedDate ?? row.page_age;
    hits.push({
      title: firstNonEmpty(row.title) ?? url,
      url,
      text,
      ...(typeof date === 'string' && date !== '' ? { date } : {}),
    });
  }
  return hits;
}

function firstText(row: HitValue): string {
  const snippets = Array.isArray(row.snippets) ? row.snippets.join(' ') : undefined;
  for (const candidate of [
    row.content,
    row.raw_content,
    row.text,
    row.summary,
    row.description,
    row.snippet,
    snippets,
  ]) {
    const value = firstNonEmpty(candidate);
    if (value !== undefined) {
      return value;
    }
  }
  return '';
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmedValue = value.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '';
}

/**
 * The pages in one vendor reply. Throws when the body is not the JSON shape the
 * vendor documents; an empty result list is not an error.
 */
export function readSearchReply(vendor: SearchVendorId, body: string): readonly SearchHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error('invalid JSON');
  }
  switch (vendor) {
    case 'brave': {
      if (!validators.brave.Check(payload)) {
        throw new Error('missing web.results');
      }
      // Narrowed by the validator above; `Compile().Check` returns a boolean.
      const reply = payload as Static<typeof BraveReply>;
      return hitsOf(reply.web?.results ?? []);
    }
    case 'firecrawl': {
      if (!validators.firecrawl.Check(payload)) {
        throw new Error('missing data');
      }
      const reply = payload as Static<typeof FirecrawlReply>;
      const data = reply.data;
      if (Array.isArray(data)) {
        return hitsOf(data);
      }
      return hitsOf(data?.web ?? []);
    }
    case 'you': {
      if (!validators.you.Check(payload)) {
        throw new Error('missing results');
      }
      const reply = payload as Static<typeof YouReply>;
      return hitsOf([...(reply.results.web ?? []), ...(reply.results.news ?? [])]);
    }
    default: {
      if (!validators.results.Check(payload)) {
        throw new Error('missing results');
      }
      const reply = payload as Static<typeof ResultsReply>;
      return hitsOf(reply.results);
    }
  }
}
