import type { ServerType } from '@hono/node-server';
import type { SecretStore } from '../../platform/secrets.ts';
import type { ListQuery } from './audit.ts';
import { AdminAuthError } from './auth.ts';

export const MAX_BODY_BYTES = 8_192;
/** Two prompt templates may each carry 64Ki characters, including JSON escaping overhead. */
export const REPLAY_BODY_MAX_BYTES = 1_024 * 1_024;

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function json(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (cookie !== undefined) {
    headers.set('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** Renders an error for the panel, with every registered secret scrubbed out. */
export function redact(secrets: SecretStore | undefined, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return secrets === undefined ? message : secrets.redact(message);
}

export function readCookie(request: Request, name: string): string {
  const header = request.headers.get('cookie');
  if (header === null) {
    return '';
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return '';
}

export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AdminAuthError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads at most `maxBytes` of the body, counting bytes as they arrive. The limit
 * used to be checked after `request.text()` had buffered everything, so a
 * chunked request without Content-Length could make an unauthenticated login
 * allocate without bound, and the check counted UTF-16 units, not bytes.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = (): AdminAuthError => new AdminAuthError(413, 'body_too_large', 'Request body is too large');
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw tooLarge();
  }
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The revision of the configuration the caller last read, from `If-Match`.
 * Surrounding quotes and a weak prefix are accepted so an ETag-shaped header
 * works as well as the bare digest.
 */
export function requiredRevision(request: Request): string | null {
  const header = request.headers.get('if-match');
  if (header === null) {
    return null;
  }
  const revision = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return revision.length === 0 ? null : revision;
}

export function revisionRequired(): Response {
  return json(
    { error: 'revision_required', message: 'If-Match with the current configuration revision is required' },
    400,
  );
}

/**
 * Decodes the path segments, or `null` when one of them is not valid
 * percent-encoding. A malformed id is the caller's mistake, not a server fault,
 * so it must not surface as `internal_error`.
 */
export function decodeSegments(segments: readonly string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Extracts the host of an Origin header; `null` when it is not a valid origin. */
export function parseOriginHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export function listQuery(url: URL): ListQuery {
  return {
    limit: url.searchParams.get('limit'),
    cursor: url.searchParams.get('cursor'),
    state: url.searchParams.get('state'),
    chat: url.searchParams.get('chat'),
    host: url.searchParams.get('host'),
    set: url.searchParams.get('set'),
    search: url.searchParams.get('search'),
    target: url.searchParams.get('target'),
    at: url.searchParams.get('at'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  };
}

export function closeServer(server: ServerType): Promise<void> {
  // Only the plain HTTP server variant exposes closeAllConnections; the
  // adaptor never creates HTTP/2 servers in this project.
  if ('closeAllConnections' in server) {
    server.closeAllConnections();
  }
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
