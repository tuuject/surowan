import { Buffer } from 'node:buffer';
import { type KeyObject, createHash, randomBytes, sign } from 'node:crypto';
import { canonicalSignatureString, formatSignatureAuthorization } from '@surowan/admin-surface';
import { CliError, usageError } from './errors.ts';

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
  /**
   * Paired-client identity. Each request is signed with the Ed25519 key; the
   * key itself never leaves this process and appears in no header.
   */
  readonly signer?: RequestSigner;
  readonly defaultTimeoutMs: number;
}

/** What signing needs: who the client is, which instance, and the private key. */
export interface RequestSigner {
  /** `admin_clients.id` as decimal text. */
  readonly clientId: string;
  readonly instanceId: string;
  readonly privateKey: KeyObject;
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
  /** A missing content type counts as text: a text route that omits it still has decodable bytes. */
  readonly isText: boolean;
}

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
 * Every request authenticates with either a Bearer API key or a detached
 * Ed25519 signature over the method, target, body digest, timestamp and a
 * fresh nonce.
 */
export class AdminClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string | undefined;
  readonly #signer: RequestSigner | undefined;
  readonly #defaultTimeoutMs: number;

  constructor(options: AdminClientOptions) {
    if (options.apiKey !== undefined && options.signer !== undefined) {
      throw new Error('AdminClient takes either an API key or a request signer, not both');
    }
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#signer = options.signer;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async get(path: string, query?: URLSearchParams, options: RequestOptions = {}): Promise<unknown> {
    return await this.request('GET', path, query, undefined, options);
  }

  async post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return await this.request('POST', path, undefined, body, options);
  }

  /**
   * One credential-free POST. The pairing claim is the only Admin API write
   * that runs before a credential exists, so it must never carry a stale
   * `Authorization` header left over from a previous login.
   */
  async postUnauthenticated(path: string, body: unknown): Promise<unknown> {
    const url = this.#resolve(path);
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#defaultTimeoutMs),
    };
    try {
      return await readJsonResponse(await fetch(url, init));
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
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
      headers: { ...this.#authHeaders('GET', url, EMPTY_BODY), accept: 'application/octet-stream' },
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

  /** Which credential this client carries; `doctor` reports it verbatim. */
  get credentialKind(): 'api_key' | 'client_signature' {
    return this.#signer === undefined ? 'api_key' : 'client_signature';
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
    const headers: Record<string, string> = { ...this.#authHeaders('GET', url, EMPTY_BODY), accept: '*/*' };
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
        isText: contentType === null || contentType.startsWith('text/') || contentType.includes('json'),
      };
    } catch (error) {
      throw translateFetchError(error, this.#defaultTimeoutMs);
    }
  }

  /**
   * Credential headers for one request. A signer covers the exact bytes that
   * will be sent, so a JSON body, an upload or an empty GET body all sign what
   * the server will digest.
   */
  #authHeaders(method: string, url: URL, body: Buffer): Record<string, string> {
    if (this.#apiKey !== undefined) {
      return { authorization: `Bearer ${this.#apiKey}` };
    }
    const signer = this.#signer;
    if (signer === undefined) {
      return {};
    }
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const nonce = randomBytes(16).toString('base64url');
    const canonical = canonicalSignatureString({
      instanceId: signer.instanceId,
      clientId: signer.clientId,
      method,
      target: signingTarget(url, this.#baseUrl),
      timestamp,
      nonce,
      bodyDigest: createHash('sha256').update(body).digest('base64url'),
    });
    const signature = sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('base64url');
    return {
      authorization: formatSignatureAuthorization({ clientId: signer.clientId, timestamp, nonce, signature }),
    };
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
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    // A body-bearing write signs the exact JSON text; `undefined` signs the
    // empty body, which is what the server digests for a bodyless request.
    const bodyBytes = bodyText === undefined ? EMPTY_BODY : Buffer.from(bodyText, 'utf8');
    const headers: Record<string, string> = {
      ...this.#authHeaders(method, url, bodyBytes),
      accept: 'application/json',
    };
    if (bodyText !== undefined) {
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
    if (bodyText !== undefined) {
      init.body = bodyText;
    }
    try {
      const response = await fetch(url, init);
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

/** The digest of a bodyless request; the server digests the same zero bytes. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * The path the server will see. The endpoint may carry a base path (a reverse
 * proxy strips it), so the signature names the request from `/api/…` and stays
 * valid behind that prefix.
 */
function signingTarget(url: URL, baseUrl: URL): string {
  const base = baseUrl.pathname;
  const path = url.pathname.startsWith(base) ? `/${url.pathname.slice(base.length)}` : url.pathname;
  return `${path}${url.search}`;
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
