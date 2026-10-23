export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Parsed JSON error body, when the response carried one. Endpoints whose
   * failures can leave data behind (prompt writes) read it for the extra
   * fields `call` cannot map onto code and message.
   */
  readonly payload: unknown;

  constructor(status: number, code: string, message: string, payload: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export interface SessionState {
  readonly setup_required: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly expires_at: string | null;
  /** Whether passkeys are enabled at all; gated by the `admin.public_url` config. */
  readonly passkeys_enabled: boolean;
  /** Only a real boolean when authenticated; null before setup / while signed out. */
  readonly has_password: boolean | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ChatSummary {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username?: string | null;
  readonly message_thread_id: number;
}

export interface ListFilters {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly state?: string | undefined;
  readonly chat?: string | undefined;
  readonly host?: string | undefined;
  readonly set?: string | undefined;
  readonly search?: string | undefined;
  readonly target?: string | undefined;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'Admin API returned a non-JSON response');
    }
  }
  if (!response.ok) {
    const body = payload as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message ?? `Admin API request failed with status ${response.status}`,
      payload,
    );
  }
  return payload as T;
}

export function listPath(path: string, filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  if (filters.cursor !== undefined && filters.cursor !== null) {
    params.set('cursor', filters.cursor);
  }
  for (const key of ['state', 'chat', 'host', 'set', 'search', 'target'] as const) {
    const value = filters[key];
    if (value !== undefined && value.length > 0) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Write requests carry the revision they were built against, so the server
 * rejects a write whose configuration has moved on (`409 config_conflict`)
 * instead of silently overwriting somebody else's edit.
 */
export function writeHeaders(revision: string): Record<string, string> {
  return { 'content-type': 'application/json', 'if-match': revision };
}
