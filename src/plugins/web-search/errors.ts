import type { SearchProviderSpec } from './extension.ts';

/**
 * A search failure with a stable code the audit row records. Every branch that
 * can fail classifies here so the model gets one consistent `web_search
 * failed: …` message and the `tool_calls` row gets a short code.
 */
export class WebSearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
  }
}

/** HTTP status to failure code. The response body is never read for these. */
export function classifyStatus(
  status: number,
  provider: SearchProviderSpec,
  key: string | undefined,
): { readonly code: string; readonly message: string } {
  if (status === 401 || status === 403) {
    if (provider.rule.keyPolicy !== 'required' && key === undefined) {
      return {
        code: 'endpoint_rejected',
        message:
          'The endpoint rejected the request. For a self-hosted or keyless endpoint, check that it returns JSON output.',
      };
    }
    return {
      code: 'auth_failed',
      message: `The provider rejected the credential (HTTP ${status}). Check the engine's api_key.`,
    };
  }
  if (status === 402 || status === 432 || status === 433) {
    return { code: 'quota_exhausted', message: `The provider reports exhausted quota (HTTP ${status}).` };
  }
  if (status === 429) {
    return { code: 'rate_limited', message: 'The provider is rate limiting this deployment (HTTP 429).' };
  }
  if (status >= 500 && status <= 599) {
    return { code: 'upstream_unavailable', message: `The provider is unavailable (HTTP ${status}).` };
  }
  if (status >= 400 && status <= 499) {
    return { code: 'request_rejected', message: `The provider rejected the request (HTTP ${status}).` };
  }
  return { code: 'upstream_error', message: `The provider answered with HTTP ${status}.` };
}

/** A transport failure, distinguishing an outer abort from our own timeout. */
export function networkError(
  error: unknown,
  outerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
): WebSearchError {
  if (error instanceof WebSearchError) {
    return error;
  }
  if (outerSignal?.aborted === true) {
    return new WebSearchError('aborted', 'The search was aborted');
  }
  if (timeout.aborted) {
    return new WebSearchError('timeout', 'The search request timed out');
  }
  return new WebSearchError('network_error', error instanceof Error ? error.message : String(error));
}
