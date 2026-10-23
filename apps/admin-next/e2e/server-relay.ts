/**
 * The loopback upstream every spec's provider points at.
 *
 * It answers `/v1/models` (discovery must never reach the network and the
 * key/header assertions only hold when the request lands here) and
 * `/v1/chat/completions` (health checks and the dictionary merge share it; each
 * caller's request is identified by the model id it asks for).
 */
import type { ServerType } from '@hono/node-server';
import { startFixtureServer } from '../../../test/helpers.ts';
import {
  E2E_ACCEPTED_RELAY_KEYS,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_PROMPT,
  E2E_HEALTH_UNEXPECTED_MODEL,
  E2E_MERGE_MODEL,
  E2E_MERGE_SUGGESTION,
  E2E_RELAY_DISCOVERED_MODELS,
} from './models-fixture.ts';

/**
 * Every chat-completion request the fixture upstream served (the health-check
 * calls), plus rejection, concurrency and in-flight counters. Exposed to the
 * specs via `GET /__e2e/relay-stats` so they can assert what actually left the
 * process: one request per click, a batch capped at three in flight, the
 * exact body Pi sent (single fixed prompt, no system message, no tools), and
 * that a real client disconnect (request signal abort) frees the slot instead
 * of waiting for the canned delay to expire.
 */
interface RelayChatRecord {
  readonly model: string;
  readonly body: Record<string, unknown>;
  /** Set once the fixture observed the peer abort the request before it finished. */
  aborted: boolean;
  /** Set once the fixture's handler reached its end state (response written or torn down). */
  completed: boolean;
}
const relayChatStats = {
  requests: [] as RelayChatRecord[],
  rejected: 0,
  inFlight: 0,
  maxConcurrent: 0,
  aborted: 0,
  completed: 0,
};

/**
 * Upstream latency for every model. It is short on purpose: no assertion may
 * depend on wall-clock timing. Specs that need a request to stay in flight
 * (ordering, concurrency, cancellation) park it with the hold gate below; the
 * delay only keeps a single check observable as in flight for a moment.
 */
const HEALTH_DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The upstream answers per requested model id: `health-ok*` streams the
 * expected reply, `health-unexpected` streams a different one, `health-fail`
 * answers HTTP 500, and everything else is unknown.
 */
function healthBehavior(model: string): 'ok' | 'merge' | 'unexpected' | 'http-error' | 'unknown' {
  if (model === E2E_HEALTH_OK_MODEL || model === E2E_HEALTH_OK_2_MODEL) {
    return 'ok';
  }
  if (model === E2E_MERGE_MODEL) {
    return 'merge';
  }
  if (model === E2E_HEALTH_UNEXPECTED_MODEL) {
    return 'unexpected';
  }
  if (model === E2E_HEALTH_FAIL_MODEL) {
    return 'http-error';
  }
  return 'unknown';
}

/**
 * Test-only response gate. While a model (or all models) is held, arriving
 * health requests are parked before any response bytes: the upstream has not
 * answered yet, for as long as the spec wants. This replaces wall-clock delay
 * races (a 2s stream can complete before a 120ms one is asserted on, or a
 * "cancelled" batch can simply have finished naturally) with explicit
 * hold/release control. A peer disconnect while a request is parked is a real
 * upstream cancel — the fixture observed the connection die before it replied.
 */
const healthGate = {
  all: false,
  models: new Set<string>(),
};
const gateReleaseListeners = new Set<() => void>();

function isHeld(model: string): boolean {
  return healthGate.all || healthGate.models.has(model);
}

/** Resolves once `model` is released; rejects when the peer aborts while parked. */
function waitForRelease(model: string, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cleanup = (): void => {
    gateReleaseListeners.delete(listener);
    signal.removeEventListener('abort', onAbort);
  };
  const onAbort = (): void => {
    cleanup();
    reject(signal.reason);
  };
  const listener = (): void => {
    if (!isHeld(model)) {
      cleanup();
      resolve();
    }
  };
  if (signal.aborted) {
    onAbort();
    return promise;
  }
  gateReleaseListeners.add(listener);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

/** `POST /__e2e/health-gate/release`: let parked requests through again. */
export function releaseHealthGate(model?: string): void {
  if (model === undefined) {
    healthGate.all = false;
    healthGate.models.clear();
  } else {
    healthGate.models.delete(model);
  }
  for (const listener of [...gateReleaseListeners]) {
    listener();
  }
}

/** `POST /__e2e/health-gate/hold`: park one model, or all of them when unnamed. */
export function holdHealthGate(model?: string): void {
  if (model === undefined) {
    healthGate.all = true;
  } else {
    healthGate.models.add(model);
  }
}

/**
 * Enforces the health-check contract at the wire: one user message with the
 * exact fixed prompt, no system role, no tools, streaming, output capped at
 * 128. A violation answers 400 so the check surfaces as an upstream error and
 * the spec fails with a message naming the broken field.
 *
 * The dictionary merge asks the same upstream for a different job (a JSON
 * suggestion with no fixed prompt), so only the health prompt pays this
 * contract; the merge model's request is recorded verbatim instead.
 */
function validateHealthRequest(body: Record<string, unknown>): string | null {
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0) {
    return 'fixture: health request must carry a model id';
  }
  if (model === E2E_MERGE_MODEL) {
    return null;
  }
  if (body.stream !== true) {
    return 'fixture: health request must stream';
  }
  if (body.tools !== undefined) {
    return 'fixture: health request must not carry tools';
  }
  if (body.tool_choice !== undefined) {
    return 'fixture: health request must not carry tool_choice';
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    return 'fixture: health request must carry exactly one message';
  }
  const message = messages[0] as Record<string, unknown> | undefined;
  if (message === undefined || message.role !== 'user') {
    return 'fixture: the only message must have role user';
  }
  if (message.content !== E2E_HEALTH_PROMPT) {
    return 'fixture: the only message must be exactly the fixed health prompt';
  }
  const cap = body.max_tokens ?? body.max_completion_tokens;
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap > 128)) {
    return 'fixture: the output cap must be an integer <= 128';
  }
  return null;
}

/** One OpenAI-style SSE stream with the canned reply, then `data: [DONE]`. */
function healthSseChunks(model: string, content: string): string[] {
  const id = `chatcmpl-e2e-${model}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content }, null),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ];
}

async function handleHealthCompletions(request: Request): Promise<Response> {
  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!E2E_ACCEPTED_RELAY_KEYS.includes(presented)) {
    return Response.json({ error: { message: 'invalid key' } }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: 'fixture: request body is not JSON' } }, { status: 400 });
  }
  const validationError = validateHealthRequest(body);
  if (validationError !== null) {
    relayChatStats.rejected += 1;
    return Response.json({ error: { message: validationError } }, { status: 400 });
  }
  const model = String(body.model);
  const behavior = healthBehavior(model);
  const record: RelayChatRecord = { model, body, aborted: false, completed: false };
  relayChatStats.requests.push(record);
  if (behavior === 'unknown') {
    return Response.json({ error: { message: `fixture: no canned behavior for model ${model}` } }, { status: 404 });
  }
  // Every canned request counts as in-flight from arrival until its response
  // is written or the peer disconnects — including the HTTP-500 one, so a
  // batch whose slots hold a failing model reports real concurrency.
  relayChatStats.inFlight += 1;
  relayChatStats.maxConcurrent = Math.max(relayChatStats.maxConcurrent, relayChatStats.inFlight);
  const onAbort = (): void => {
    if (!record.aborted) {
      record.aborted = true;
      relayChatStats.aborted += 1;
    }
  };
  if (request.signal.aborted) {
    onAbort();
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true });
  }
  let finished = false;
  const finish = (): void => {
    request.signal.removeEventListener('abort', onAbort);
    if (!finished) {
      finished = true;
      record.completed = true;
      relayChatStats.completed += 1;
      // Defensive clamp: a request torn down after the next spec reset the
      // counters must not push the shared counter below zero.
      relayChatStats.inFlight = Math.max(0, relayChatStats.inFlight - 1);
    }
  };
  try {
    // Test-only gate: while the model is held the upstream has not answered.
    // If the peer disconnects here, that is a real upstream cancel.
    if (isHeld(model)) {
      await waitForRelease(model, request.signal);
    }
    if (behavior === 'http-error') {
      await sleep(HEALTH_DELAY_MS);
      finish();
      return Response.json({ error: { message: 'fixture upstream failure' } }, { status: 500 });
    }
    const content = behavior === 'ok' ? 'ok' : behavior === 'merge' ? JSON.stringify(E2E_MERGE_SUGGESTION) : 'hello';
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await sleep(HEALTH_DELAY_MS);
          const encoder = new TextEncoder();
          for (const chunk of healthSseChunks(model, content)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch {
          // The client went away mid-stream; nothing more to send.
        } finally {
          finish();
        }
      },
      cancel: finish,
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  } catch {
    // The peer disconnected while this handler was parked or answering; free
    // the slot without trying to reply into a dead socket.
    finish();
    return Response.json({ error: { message: 'fixture: client disconnected' } }, { status: 499 });
  }
}

/** `GET /__e2e/relay-stats`: what the upstream saw since the last reset. */
export function relayStatsPayload(): Record<string, unknown> {
  const byModel = new Map<string, number>();
  for (const record of relayChatStats.requests) {
    byModel.set(record.model, (byModel.get(record.model) ?? 0) + 1);
  }
  return {
    total: relayChatStats.requests.length,
    by_model: Object.fromEntries(byModel),
    max_concurrent: relayChatStats.maxConcurrent,
    in_flight: relayChatStats.inFlight,
    rejected: relayChatStats.rejected,
    aborted: relayChatStats.aborted,
    completed: relayChatStats.completed,
    records: relayChatStats.requests.map((record) => ({
      model: record.model,
      aborted: record.aborted,
      completed: record.completed,
    })),
    bodies: relayChatStats.requests.map((record) => record.body),
  };
}

/** `POST /__e2e/relay-stats/reset`: a spec asserts on its own requests only. */
export function resetRelayStats(): void {
  relayChatStats.requests.length = 0;
  relayChatStats.rejected = 0;
  relayChatStats.inFlight = 0;
  relayChatStats.maxConcurrent = 0;
  relayChatStats.aborted = 0;
  relayChatStats.completed = 0;
}

/** The upstream handle boot publishes (and stops on shutdown). */
export interface RelayUpstream {
  readonly server: ServerType;
  readonly port: number;
}

export function createRelayUpstream(): Promise<RelayUpstream> {
  return startFixtureServer((incoming) => {
    const url = new URL(incoming.url);
    if (url.pathname === '/v1/models') {
      if (incoming.headers.get('authorization') === null) {
        return Response.json({ error: { message: 'missing key' } }, { status: 401 });
      }
      const presented = (incoming.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!E2E_ACCEPTED_RELAY_KEYS.includes(presented)) {
        return Response.json({ error: { message: 'invalid key' } }, { status: 401 });
      }
      return Response.json({
        object: 'list',
        data: E2E_RELAY_DISCOVERED_MODELS.map((id) => ({ id, name: id, object: 'model' })),
      });
    }
    // Health checks and the dictionary merge share this loopback upstream:
    // each caller's request is identified by the model id it asks for.
    if (url.pathname === '/v1/chat/completions' && incoming.method === 'POST') {
      if (incoming.headers.get('authorization') === null) {
        return Response.json({ error: { message: 'missing key' } }, { status: 401 });
      }
      return handleHealthCompletions(incoming);
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  });
}
