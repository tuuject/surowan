/**
 * Test-only `/__e2e/**` hooks for the live Invocation streams: they append the
 * rows a real run would write while the panel watches, so a spec can assert
 * that the page updates without a reload (or stays still when it should).
 *
 * Kept out of `server-hooks.ts` so that file stays under the pre-commit size
 * limit; `handleHook` forwards to `handleLiveHook` before its own routes.
 */
import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import { invocations, modelCalls, toolCalls } from '../../../src/store/schema/index.ts';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Unique per process, because `tool_calls.tool_call_id` is unique across the whole store. */
let appended = 0;

function readId(url: URL): string | null {
  const id = url.searchParams.get('id');
  return id !== null && /^\d{1,19}$/.test(id) ? id : null;
}

export async function handleLiveHook(
  request: Request,
  url: URL,
  store: SqliteStore | null,
): Promise<Response | undefined> {
  const route = url.pathname.slice('/__e2e'.length);
  if (route !== '/append-tool-call' && route !== '/append-model-call') {
    return undefined;
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  if (store === null) {
    return json({ error: 'store_closed' }, 500);
  }
  const invocationId = readId(url);
  if (invocationId === null) {
    return json({ error: 'invalid_id' }, 400);
  }
  const exists = store.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(eq(invocations.id, BigInt(invocationId)))
    .get();
  if (exists === undefined) {
    return json({ error: 'invocation_missing' }, 404);
  }
  appended += 1;
  const now = new Date().toISOString();
  if (route === '/append-tool-call') {
    const toolCallId = `e2e_live_call_${appended}_${Date.now()}`;
    store.orm
      .insert(toolCalls)
      .values({
        invocationId: BigInt(invocationId),
        toolCallId,
        toolName: 'read',
        argumentsJson: JSON.stringify({ path: 'system:///skills/e2e.md' }),
        state: 'success',
        sideEffect: false,
        resultText: 'appended by the live-refresh spec',
        createdAt: now,
        finishedAt: now,
      })
      .run();
    return json({ tool_call_id: toolCallId });
  }
  const created = store.orm
    .insert(modelCalls)
    .values({
      invocationId: BigInt(invocationId),
      role: 'agent',
      provider: 'e2e',
      model: 'e2e-model',
      attempt: 1n,
      state: 'success',
      inputTokens: 12n,
      outputTokens: 3n,
      totalTokens: 15n,
      cost: 0.001,
      createdAt: now,
      finishedAt: now,
    })
    .returning({ id: modelCalls.id })
    .get();
  return json({ id: created?.id.toString() ?? null });
}
