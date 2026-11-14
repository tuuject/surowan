import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { webFetchUserAgent } from '../../platform/version.ts';
import { type AddressPolicy, type ResolveHostname, resolveAllowedAddress } from './address.ts';
import { WebFetchError } from './shared.ts';

const MAX_REDIRECTS = 3;

export interface RequestHeaders {
  readonly accept: string;
  readonly referer?: string;
}

export type RequestResolved = (
  url: URL,
  address: string,
  headers: RequestHeaders,
  signal: AbortSignal,
) => Promise<Response>;

export async function fetchWithRedirects(
  input: string,
  headers: RequestHeaders,
  signal: AbortSignal,
  resolveHostname: ResolveHostname,
  requestResolved: RequestResolved,
  policy: AddressPolicy,
  accepted: { readonly images: boolean },
): Promise<{ url: string; response: Response; kind: 'text' | 'image' }> {
  let url = parseUrl(input);
  for (let redirects = 0; ; redirects += 1) {
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const address = await resolveAllowedAddress(hostname, resolveHostname, policy);
    const response = await requestResolved(url, address, headers, signal);
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || location === null) {
      return { url: url.href, response, kind: responseKind(response, accepted.images) };
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      throw new WebFetchError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects`);
    }
    url = parseUrl(new URL(location, url).href);
  }
}

function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebFetchError('invalid_url', 'URL must be absolute');
  }
  const expectedPort = url.protocol === 'http:' ? '80' : url.protocol === 'https:' ? '443' : undefined;
  if (
    expectedPort === undefined ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    (url.port.length > 0 && url.port !== expectedPort)
  ) {
    throw new WebFetchError(
      'invalid_url',
      'URL must use HTTP(S), default ports, and contain no credentials or fragment',
    );
  }
  return url;
}

/** The Referer value as a browser would send it: no credentials, no fragment. */
export function parseReferer(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebFetchError('invalid_referer', 'referer must be an absolute URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username.length > 0 || url.password.length > 0) {
    throw new WebFetchError('invalid_referer', 'referer must use HTTP(S) and contain no credentials');
  }
  url.hash = '';
  return url.href;
}

export function defaultRequestResolved(
  url: URL,
  address: string,
  headers: RequestHeaders,
  signal: AbortSignal,
): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
    {
      protocol: url.protocol,
      hostname: address,
      port: url.port.length === 0 ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      signal,
      headers: {
        accept: headers.accept,
        'accept-encoding': 'identity',
        connection: 'close',
        host: url.host,
        'user-agent': webFetchUserAgent(),
        ...(headers.referer === undefined ? {} : { referer: headers.referer }),
      },
      ...(url.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {}),
    },
    (incoming) => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) {
          headers.append(name, value);
        }
      }
      const status = incoming.statusCode ?? 500;
      const hasBody = status !== 204 && status !== 205 && status !== 304;
      const body = hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null;
      resolve(new Response(body, { status, statusText: incoming.statusMessage ?? '', headers }));
    },
  );
  request.once('error', reject);
  request.end();
  return promise;
}

/**
 * Text is returned as text. An image is only accepted when the tool can store
 * one; SVG (`image/svg+xml`) stays text, like every other `+xml` type.
 */
function responseKind(response: Response, images: boolean): 'text' | 'image' {
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    throw new WebFetchError('unsupported_encoding', `Unsupported content encoding: ${encoding}`);
  }
  const contentType = mediaTypeOf(response);
  if (
    contentType === undefined ||
    contentType.length === 0 ||
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType.endsWith('+json') ||
    contentType === 'application/xml' ||
    contentType.endsWith('+xml') ||
    contentType === 'application/javascript' ||
    contentType === 'application/x-javascript'
  ) {
    return 'text';
  }
  if (images && contentType.startsWith('image/')) {
    return 'image';
  }
  throw new WebFetchError('unsupported_content_type', `Unsupported content type: ${contentType}`);
}

export function mediaTypeOf(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
}

export async function readTextBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBody(response, maxBytes);
  const attempts = truncated ? Math.min(3, bytes.byteLength) : 0;
  for (let dropped = 0; dropped <= attempts; dropped += 1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.byteLength - dropped));
      return { text, truncated };
    } catch {}
  }
  throw new WebFetchError('invalid_text_encoding', 'Response is not valid UTF-8');
}

export async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (response.body === null) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const available = maxBytes - size;
    if (next.value.byteLength > available) {
      if (available > 0) {
        chunks.push(next.value.subarray(0, available));
      }
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}
