import Type from 'typebox';
import Compile from 'typebox/compile';

/**
 * The Decisions API client: one yes/no question about a JSON state, answered
 * with a probability. It is a thin boundary with no business dependencies —
 * credential resolution, thresholds and Buckets live above it.
 *
 * Nothing here throws for an expected failure. Every outcome is a
 * discriminated result, because the caller's rule is "a failure admits the
 * batch": a thrown error would have to be caught at the same place anyway, and
 * a stable `code` is what the audit row records.
 */

/** How much of a response body is read before the answer counts as unusable. */
const RESPONSE_MAX_BYTES = 64 * 1024;
/** A failure detail is one line of provider prose, not a document. */
const DETAIL_MAX_CHARS = 300;

/** Why a decision was not reached. `http_error` additionally carries `status`. */
export type DecisionsErrorCode =
  | 'timeout'
  | 'aborted'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'refusal';

export interface DecisionsSuccess {
  readonly ok: true;
  /** The P(yes) the model answered, already inside 0..1. */
  readonly probability: number;
  readonly inputTokens: number;
  /** The request's reported cost; `null` when the service did not report one. */
  readonly cost: number | null;
  readonly durationMs: number;
}

export interface DecisionsFailure {
  readonly ok: false;
  readonly code: DecisionsErrorCode;
  /** The HTTP status behind an `http_error`; absent for every other code. */
  readonly status?: number;
  /** Redacted, bounded and safe to store or log: it never carries the credential. */
  readonly detail: string;
  readonly durationMs: number;
}

export type DecisionsResult = DecisionsSuccess | DecisionsFailure;

export interface DecisionsRequest {
  /** Already resolved by the caller; never logged, and never echoed in `detail`. */
  readonly apiKey: string;
  /** The API prefix; `/decisions` is appended to it. */
  readonly baseUrl: string;
  readonly model: string;
  /** Any JSON value; the client only serializes it. */
  readonly state: unknown;
  readonly instructions: string;
  /** The budget for the whole call, body download included. */
  readonly timeoutMs: number;
  /** Process shutdown; distinct from the timeout so the audit row can tell them apart. */
  readonly signal?: AbortSignal | undefined;
  /** Test seam; production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Only the two fields the caller consumes are validated: `answers.gate` and
 * `usage`. Everything else in the envelope (id, model, provider, per-answer
 * extras) is tolerated as written, so a service-side addition never turns a
 * usable answer into an `invalid_response`.
 */
const GateAnswerSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('noul'),
      noul: Type.Number({ minimum: 0, maximum: 1 }),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    },
    { additionalProperties: true },
  ),
  Type.Object({ type: Type.Literal('refusal') }, { additionalProperties: true }),
]);
const DecisionsResponseSchema = Type.Object(
  {
    answers: Type.Object({ gate: GateAnswerSchema }, { additionalProperties: true }),
    usage: Type.Object(
      {
        input_tokens: Type.Integer({ minimum: 0 }),
        output_tokens: Type.Integer({ minimum: 0 }),
        cost: Type.Optional(Type.Number({ minimum: 0 })),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const DecisionsErrorSchema = Type.Object(
  {
    error: Type.Object(
      { code: Type.Optional(Type.Number()), message: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const responseValidator = Compile(DecisionsResponseSchema);
const errorValidator = Compile(DecisionsErrorSchema);

/**
 * Asks the decision model one question. The request body is
 * `{ model, state, questions: { gate: { type: 'noul', instructions } } }`;
 * redirects are refused rather than followed, so a hijacked endpoint cannot
 * move the credential to another host.
 */
export async function requestDecision(request: DecisionsRequest): Promise<DecisionsResult> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs));
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${request.baseUrl.replace(/\/+$/, '')}/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        state: request.state,
        questions: { gate: { type: 'noul', instructions: request.instructions } },
      }),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    return failure(transportCode(request.signal, timeout), detailOf(error, request.apiKey), elapsed());
  }
  if (!response.ok) {
    const status = response.status;
    const body = await readBounded(response, RESPONSE_MAX_BYTES).catch(() => undefined);
    return failure('http_error', httpDetail(status, body, request.apiKey), elapsed(), status);
  }
  let body: Uint8Array | undefined;
  try {
    body = await readBounded(response, RESPONSE_MAX_BYTES);
  } catch (error) {
    return failure(transportCode(request.signal, timeout), detailOf(error, request.apiKey), elapsed());
  }
  if (body === undefined) {
    return failure('invalid_response', `The response exceeds ${RESPONSE_MAX_BYTES} bytes`, elapsed());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return failure('invalid_response', 'The response is not valid JSON', elapsed());
  }
  if (!responseValidator.Check(parsed)) {
    return failure('invalid_response', 'The response does not carry an answers.gate.noul between 0 and 1', elapsed());
  }
  const answer = parsed.answers.gate;
  if (answer.type === 'refusal') {
    return failure('refusal', 'The model refused to answer the gate question', elapsed());
  }
  return {
    ok: true,
    probability: answer.noul,
    inputTokens: parsed.usage.input_tokens,
    cost: parsed.usage.cost ?? null,
    durationMs: elapsed(),
  };
}

function failure(code: DecisionsErrorCode, detail: string, durationMs: number, status?: number): DecisionsFailure {
  return { ok: false, code, detail, durationMs, ...(status === undefined ? {} : { status }) };
}

/** An outer abort (shutdown) outranks the timeout so the two are never confused. */
function transportCode(outer: AbortSignal | undefined, timeout: AbortSignal): DecisionsErrorCode {
  if (outer?.aborted === true) {
    return 'aborted';
  }
  return timeout.aborted ? 'timeout' : 'network_error';
}

/**
 * A failure detail is stored and logged, so it is bounded and stripped of the
 * credential: an upstream that echoes the Authorization header back must not
 * put the key into the audit row.
 */
function detailOf(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // `fetch` wraps the socket error, and "fetch failed" alone says nothing about
  // a reset, a DNS failure or a refused connection.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const detail = cause.length === 0 || cause === message ? message : `${message}: ${cause}`;
  return redactBounded(detail, apiKey);
}

function httpDetail(status: number, body: Uint8Array | undefined, apiKey: string): string {
  const base = `The Decisions API answered with HTTP ${status}`;
  if (body === undefined) {
    return base;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return base;
  }
  if (!errorValidator.Check(parsed)) {
    return base;
  }
  const message = parsed.error.message;
  return message === undefined || message.length === 0 ? base : `${base}: ${redactBounded(message, apiKey)}`;
}

function redactBounded(text: string, apiKey: string): string {
  // `fetch` strips leading and trailing whitespace from a header value, so the
  // credential on the wire can be shorter than the resolved one; an upstream
  // that echoes it back echoes the stripped form.
  const sent = apiKey.trim();
  let redacted = apiKey.length === 0 ? text : text.split(apiKey).join('[redacted]');
  redacted = sent.length === 0 ? redacted : redacted.split(sent).join('[redacted]');
  return redacted.length <= DETAIL_MAX_CHARS ? redacted : `${redacted.slice(0, DETAIL_MAX_CHARS)}…`;
}

/**
 * Reads at most `maxBytes`; `undefined` means the body was larger, which is a
 * malformed answer rather than something to parse partially.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
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
      return undefined;
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
