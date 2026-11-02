import { Buffer } from 'node:buffer';
import { CliError, usageError } from './errors.ts';

/** The panel session cookie the server reads; a token is sent under this name. */
export const SESSION_COOKIE = 'plasticwan_admin';

/**
 * Validates an endpoint. Plaintext http is only accepted on loopback: the API
 * key travels in a header and must not cross the network unencrypted. URL
 * credentials are rejected so the key can never be smuggled through a URL.
 */
export function parseEndpoint(raw: string): URL {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError('invalid_endpoint', 'endpoint must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError('invalid_endpoint', 'endpoint must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw usageError('invalid_endpoint', 'endpoint must not contain URL credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw usageError('invalid_endpoint', 'endpoint must not contain a query string or fragment');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw usageError('insecure_endpoint', 'plaintext http is only allowed for loopback endpoints; use https');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export interface AdminClientOptions {
  readonly baseUrl: URL;
  /**
   * Programmatic `pwk_…` key. The server restricts it to the inspection
   * allowlist and Invocation replay.
   */
  readonly apiKey?: string;
  /** Panel session token; authorizes everything the browser panel authorizes. */
  readonly session?: string;
  readonly defaultTimeoutMs: number;
}

/** A successfully downloaded media body plus the headers the CLI validates. */
export interface MediaContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly variant: string | null;
}

/** A non-JSON response body: an export file or an image. */
export interface RawContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  /** True when the content type is text-ish, so the caller can decode it. */
  readonly isText: boolean;
}

/** Options shared by every request the client issues. */
export interface RequestOptions {
  /** `If-Match` value: a config revision, prompt content hash or entry revision. */
  readonly ifMatch?: string;
  /** A caller-supplied abort signal, joined with the request timeout. */
  readonly signal?: AbortSignal;
  /**
   * Sends the endpoint's own origin as `Origin`. Only routes that demand the
   * exact `admin.public_url` origin set it: on every other write a mismatched
   * `Origin` would be rejected, while a missing one is accepted.
   */
  readonly sendOrigin?: boolean;
}

/**
 * Minimal JSON client for the Admin API. Requests never follow redirects and
 * are never retried; the timeout aborts the in-flight request and the response
 * body read that follows it.
 *
 * A session token is sent as the panel cookie, because the server routes any
 * request carrying `Authorization` to the narrow API-key surface and never
 * falls back to a cookie. An API key is sent as a Bearer header.
 */
export class AdminClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string | undefined;
  readonly #session: string | undefined;
  readonly #defaultTimeoutMs: number;
  /** `set-cookie` headers from the most recent request, for session rotation. */
  #setCookies: readonly string[] = [];

  constructor(options: AdminClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#session = options.session;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async get(path: string, query?: URLSearchParams, options: RequestOptions = {}): Promise<unknown> {
    return await this.request('GET', path, query, undefined, options);
  }

  async post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return await this.request('POST', path, undefined, body, options);
  }

  /**
   * Downloads a media body. The same redirect/timeout rules as JSON requests
   * apply; the body is bounded by `maxBytes` so an oversized or stalled stream
   * fails fast instead of filling memory or disk.
   */
  async getMedia(path: string, query: URLSearchParams, maxBytes: number): Promise<MediaContent> {
    const url = this.#resolve(path, query);
    const init: RequestInit = {
      method: 'GET',
      headers: { ...this.#authHeaders(), accept: 'application/octet-stream' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#defaultTimeoutMs),
    };
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw await responseError(response);
      }
      const body = await readBodyBytes(response, maxBytes);
      if (body.truncated) {
        throw mediaTooLarge(maxBytes);
      }
      return {
        bytes: body.bytes,
        contentType: normalizeContentType(response.headers.get('content-type')),
        variant: response.headers.get('x-plasticwan-media-variant'),
      };
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }

  /** The credential this client authenticates with, for the doctor report. */
  get credentialKind(): 'api_key' | 'session' {
    return this.#apiKey === undefined ? 'session' : 'api_key';
  }

  /**
   * The `set-cookie` headers the last request produced. A route that rotates
   * the session (credentials change, password removal, logout) answers with a
   * new token, and the stored one is invalid from that moment.
   */
  get lastSetCookies(): readonly string[] {
    return this.#setCookies;
  }

  /**
   * `POST /api/auth/login` with the panel password. Returns the `set-cookie`
   * headers, which carry the session token; no cookie jar is involved.
   */
  async loginWithPassword(username: string, password: string): Promise<readonly string[]> {
    const url = this.#resolve('api/auth/login');
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username, password }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#defaultTimeoutMs),
    };
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      if (!response.ok) {
        throw responseErrorFromBody(response, text);
      }
      const parsed = tryParseJson(text);
      if (!isRecord(parsed) || parsed.status !== 'ok') {
        throw new CliError('invalid_response', 'the login response had an unexpected shape');
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length === 0) {
        throw new CliError('invalid_response', 'the login response did not set a session cookie');
      }
      return cookies;
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }

  /**
   * Fetches a non-JSON body (an export file or an image). The caller decides
   * whether the bytes are written to disk; `maxBytes` bounds the buffer.
   */
  async getRaw(
    path: string,
    query: URLSearchParams,
    options: RequestOptions & { readonly maxBytes: number },
  ): Promise<RawContent> {
    const url = this.#resolve(path, query);
    const headers: Record<string, string> = { ...this.#authHeaders(), accept: '*/*' };
    if (options.ifMatch !== undefined) {
      headers['if-match'] = options.ifMatch;
    }
    const timeout = AbortSignal.timeout(this.#defaultTimeoutMs);
    const init: RequestInit = {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]),
    };
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw await responseError(response);
      }
      const body = await readBodyBytes(response, options.maxBytes);
      if (body.truncated) {
        throw new CliError('response_too_large', `the response exceeded ${options.maxBytes} bytes`);
      }
      const contentType = normalizeContentType(response.headers.get('content-type'));
      return {
        bytes: body.bytes,
        contentType,
        // An export is text; an image is not. The caller asked for one or the other.
        isText: contentType === null || contentType.startsWith('text/') || contentType.includes('json'),
      };
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }

  #authHeaders(): Record<string, string> {
    if (this.#apiKey !== undefined) {
      return { authorization: `Bearer ${this.#apiKey}` };
    }
    if (this.#session !== undefined) {
      return { cookie: `${SESSION_COOKIE}=${this.#session}` };
    }
    // Only the pre-session routes (`auth/setup`, `auth/login`, `auth/session`)
    // are reachable without a credential; every other route answers 401.
    return {};
  }

  #resolve(path: string, query?: URLSearchParams): URL {
    const url = new URL(path.replace(/^\/+/, ''), this.#baseUrl);
    if (query !== undefined) {
      for (const [key, value] of query) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  /**
   * One JSON request. The query applies to every method: panel writes such as
   * `PUT /api/prompts/group?chat=…` select their target through it.
   */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query: URLSearchParams | undefined,
    body: unknown,
    options: RequestOptions,
  ): Promise<unknown> {
    const url = this.#resolve(path, query);
    const headers: Record<string, string> = { ...this.#authHeaders(), accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.ifMatch !== undefined) {
      headers['if-match'] = options.ifMatch;
    }
    if (options.sendOrigin === true) {
      headers.origin = this.#baseUrl.origin;
    }
    const timeout = AbortSignal.timeout(this.#defaultTimeoutMs);
    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(url, init);
      this.#setCookies = response.headers.getSetCookie();
      // The body read belongs to the same try: a server that sends headers and
      // then stalls must hit the timeout path, not `internal_error`.
      return await readJsonResponse(response);
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }
}

function mediaTooLarge(maxBytes: number): CliError {
  return new CliError('media_file_too_large', `media content exceeded ${maxBytes} bytes`);
}

function translateFetchError(error: unknown, timeoutMs: number): CliError {
  if (error instanceof CliError) {
    // A failed body read (invalid JSON, oversized body, ...) already carries a
    // structured client error; it must keep its own code.
    return error;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new CliError('timeout', `request timed out after ${timeoutMs}ms; it was not retried`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${error instanceof Error ? error.message : String(error)} ${cause}`;
  if (/redirect/i.test(text)) {
    return new CliError('redirect_not_allowed', 'the server attempted a redirect; redirects are not followed');
  }
  return new CliError('network_error', 'the request failed before a response arrived; it was not retried');
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const bodyText = await response.text();
  if (!response.ok) {
    throw responseErrorFromBody(response, bodyText);
  }
  if (bodyText.length === 0) {
    throw new CliError('invalid_response', 'server returned an empty response');
  }
  const parsed = tryParseJson(bodyText);
  if (parsed === undefined) {
    throw new CliError('invalid_response', 'server response was not valid JSON');
  }
  return parsed;
}

async function responseError(response: Response): Promise<CliError> {
  return responseErrorFromBody(response, await response.text());
}

/** A JSON error body survives as the error code/message; anything else is http_error. */
function responseErrorFromBody(response: Response, bodyText: string): CliError {
  const parsed = tryParseJson(bodyText);
  if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error.length > 0) {
    const message = typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : parsed.error;
    return new CliError(parsed.error, message);
  }
  return new CliError('http_error', `server responded with HTTP ${response.status}`);
}

function normalizeContentType(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const type = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return type.length === 0 ? null : type;
}

interface BodyBytes {
  readonly bytes: Buffer;
  readonly truncated: boolean;
}

async function readBodyBytes(response: Response, maxBytes: number): Promise<BodyBytes> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: Buffer.alloc(0), truncated: true };
  }
  const stream = response.body;
  if (stream === null) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { bytes: Buffer.alloc(0), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
