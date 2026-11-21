import type { DecisionGateSettings } from '../../platform/decision-gate.ts';
import { type DecisionsResult, requestDecision } from '../../platform/decisions.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { DecisionRecord, DecisionState } from './types.ts';

/**
 * Phase 2's request half: resolve the credential, ask the question, and reduce
 * the answer to the columns the audit row keeps.
 *
 * The credential and the HTTP call share one `timeout_ms`. `resolveCommand`
 * takes no AbortSignal, so a resolution that loses the race is abandoned: its
 * own five-second timer ends the child process.
 */
export interface VerdictRequest {
  readonly settings: DecisionGateSettings;
  readonly instructions: string;
  readonly state: DecisionState;
  readonly secrets: SecretStore;
  /** Process shutdown; a cancelled verdict is dropped by the caller. */
  readonly signal: AbortSignal;
  /** Read after the credential resolves, so a shutdown never starts an HTTP call. */
  readonly stopped: () => boolean;
  readonly redact: (error: unknown) => string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function resolveVerdict(request: VerdictRequest): Promise<DecisionRecord> {
  const budget = request.settings.timeout_ms;
  const startedAt = Date.now();
  const deadline = startedAt + budget;
  const key = await resolveKey(request, deadline);
  if (request.stopped()) {
    return failure(request, 'secret_unresolved', 'The decision was cancelled', null);
  }
  if (!key.ok) {
    return failure(request, 'secret_unresolved', key.detail, null);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return failure(request, 'timeout', 'The decision budget was spent resolving the credential', null);
  }
  const result = await requestDecision({
    apiKey: key.value,
    baseUrl: request.settings.base_url,
    model: request.settings.model,
    state: request.state,
    instructions: request.instructions,
    timeoutMs: remaining,
    signal: request.signal,
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
  });
  return record(request, result);
}

/** A failure is always an admission; the stable code is what the audit row keeps. */
export function failure(
  request: Pick<VerdictRequest, 'settings' | 'redact'>,
  code: string,
  detail: string,
  durationMs: number | null,
): DecisionRecord {
  return {
    state: 'error',
    outcome: 'enter',
    probability: null,
    threshold: request.settings.threshold,
    inputTokens: null,
    cost: null,
    durationMs: durationMs === null ? null : BigInt(durationMs),
    errorCode: code,
    errorDetail: request.redact(detail),
  };
}

function record(request: VerdictRequest, result: DecisionsResult): DecisionRecord {
  if (!result.ok) {
    return failure(request, result.code, result.detail, result.durationMs);
  }
  return {
    state: 'success',
    outcome: result.probability >= request.settings.threshold ? 'enter' : 'drop',
    probability: result.probability,
    threshold: request.settings.threshold,
    inputTokens: BigInt(result.inputTokens),
    cost: result.cost,
    durationMs: BigInt(result.durationMs),
    errorCode: null,
    errorDetail: null,
  };
}

async function resolveKey(
  request: VerdictRequest,
  deadline: number,
): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly detail: string }> {
  const reference = request.settings.api_key;
  if (reference === undefined) {
    return { ok: false, detail: 'The gate has no api_key reference' };
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { ok: false, detail: 'The decision budget was spent before the credential could be resolved' };
  }
  const resolution = request.secrets.resolve(reference).then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, detail: request.redact(error) }),
  );
  // The timeout is an arm of the race, not a listener that outlives the call:
  // it is disposed as soon as the resolution settles, so fast decisions do not
  // stack `abort` listeners on the one long-lived shutdown signal.
  const budget = startBudget(remaining, request.signal);
  try {
    const winner = await Promise.race([resolution, budget.promise]);
    if (winner.kind === 'value') {
      return { ok: true, value: winner.value };
    }
    if (winner.kind === 'error') {
      return { ok: false, detail: winner.detail };
    }
    return {
      ok: false,
      detail:
        winner.kind === 'aborted'
          ? 'The decision was cancelled'
          : 'The decision budget expired resolving the credential',
    };
  } finally {
    budget.cancel();
  }
}

interface Budget {
  /** Settles on the timer or on shutdown, whichever comes first; never keeps the loop alive. */
  readonly promise: Promise<{ readonly kind: 'timeout' } | { readonly kind: 'aborted' }>;
  /** Disposes the timer and the abort listener; the promise stays pending forever. */
  cancel(): void;
}

function startBudget(milliseconds: number, signal: AbortSignal): Budget {
  let settled = false;
  let resolve!: (kind: { readonly kind: 'timeout' } | { readonly kind: 'aborted' }) => void;
  const promise = new Promise<{ readonly kind: 'timeout' } | { readonly kind: 'aborted' }>((done) => {
    resolve = done;
  });
  const cleanup = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (kind: 'timeout' | 'aborted'): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolve({ kind });
  };
  const onAbort = (): void => finish('aborted');
  const timer = setTimeout(() => finish('timeout'), Math.max(0, milliseconds));
  timer.unref?.();
  if (signal.aborted) {
    finish('aborted');
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    promise,
    cancel: () => {
      settled = true;
      cleanup();
    },
  };
}
