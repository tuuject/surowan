/**
 * The test-only `/__e2e/**` hooks: state manipulation, the upstream's counters,
 * the health gate and shutdown. `e2e/server.ts` routes every request under that
 * prefix here before `AdminServer` sees it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { adminPasskeys, adminSessions, longTasks, taskReceipts } from '../../../src/store/schema.ts';
import { enterSleep, wakeFromSleep } from '../../../src/store/sleep.ts';
import { asRunResult } from '../../../src/store/store.ts';
import { shutdown } from './server-lifecycle.ts';
import { holdHealthGate, releaseHealthGate, relayStatsPayload, resetRelayStats } from './server-relay.ts';
import { type PlaygroundModelStep, playgroundSeedPayload, roomModelCalls, setPlaygroundModel } from './server-rooms.ts';
import { state as serverState } from './server-state.ts';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleHook(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice('/__e2e'.length);
  if (request.method === 'GET' && route === '/health') {
    return json({ ok: true });
  }
  if (request.method === 'GET' && route === '/playground-seed') {
    return json({ ...playgroundSeedPayload(), model_calls: roomModelCalls() });
  }
  if (request.method === 'POST' && route === '/playground-model') {
    const body = (await request.json().catch(() => null)) as { steps?: PlaygroundModelStep[] } | null;
    if (body === null || !Array.isArray(body.steps)) {
      return json({ error: 'invalid_body' }, 400);
    }
    setPlaygroundModel(body.steps);
    return json({ ok: true, steps: body.steps.length, model_calls: roomModelCalls() });
  }
  if (request.method === 'GET' && route === '/relay-stats') {
    return json(relayStatsPayload());
  }
  if (request.method === 'POST' && route === '/relay-stats/reset') {
    resetRelayStats();
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/health-gate/hold') {
    const gateBody = (await request.json().catch(() => null)) as { model?: string } | null;
    if (gateBody === null) {
      return json({ error: 'invalid_body' }, 400);
    }
    holdHealthGate(gateBody.model);
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/health-gate/release') {
    const gateBody = (await request.json().catch(() => null)) as { model?: string } | null;
    if (gateBody === null) {
      return json({ error: 'invalid_body' }, 400);
    }
    releaseHealthGate(gateBody.model);
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/fail-next-config-apply') {
    serverState.failNextConfigApply = true;
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/shutdown') {
    setTimeout(() => void shutdown(), 50);
    return json({ status: 'stopping' });
  }
  const store = serverState.store;
  if (request.method === 'POST' && route === '/revoke-sessions') {
    const result = store === null ? null : asRunResult(store.orm.delete(adminSessions).run());
    return json({ deleted: Number(result?.changes ?? 0) });
  }
  if (request.method === 'POST' && route === '/passkeys-rp-fixture') {
    const active = url.searchParams.get('active');
    if (active !== 'none' && active !== 'latest') {
      return json({ error: 'invalid_active' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const latest = store.orm.select().from(adminPasskeys).orderBy(adminPasskeys.id).all().at(-1);
    store.orm.update(adminPasskeys).set({ rpId: 'old.example.test' }).run();
    if (active === 'latest' && latest !== undefined) {
      store.orm.update(adminPasskeys).set({ rpId: 'localhost' }).where(eq(adminPasskeys.id, latest.id)).run();
    }
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/enter-sleep') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const transition = enterSleep(store.orm);
    return json({ sleep_until: transition.sleepUntil, entered: transition.entered });
  }
  if (request.method === 'POST' && route === '/wake') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    return json({ was_sleeping: wakeFromSleep(store.orm) });
  }
  if (request.method === 'POST' && route === '/set-alarm-terminal') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const now = new Date().toISOString();
    const taskId = BigInt(id);
    const result = asRunResult(
      store.orm
        .update(longTasks)
        .set({ state: 'completed', finishedAt: now, updatedAt: now })
        .where(and(eq(longTasks.id, taskId), eq(longTasks.pluginId, 'alarm'), eq(longTasks.state, 'waiting')))
        .run(),
    );
    if (result.changes > 0) {
      store.orm
        .insert(taskReceipts)
        .values({
          taskId,
          status: 'completed',
          resultJson: null,
          errorJson: null,
          state: 'handled',
          createdAt: now,
          updatedAt: now,
          claimedAt: now,
          handledAt: now,
          invocationId: null,
          invocationOutcome: null,
          completionReason: null,
          cancelledAt: null,
          cancelledBy: null,
          adminCancelled: false,
          cancelReason: null,
        })
        .onConflictDoNothing()
        .run();
    }
    return json({ updated: Number(result.changes) });
  }
  if (request.method === 'GET' && route === '/alarm-state') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    const row =
      store?.orm
        .select({ taskState: longTasks.state, receiptState: taskReceipts.state, cancelledBy: taskReceipts.cancelledBy })
        .from(longTasks)
        .leftJoin(taskReceipts, eq(taskReceipts.taskId, longTasks.id))
        .where(and(eq(longTasks.id, BigInt(id)), eq(longTasks.pluginId, 'alarm')))
        .get() ?? null;
    if (row === null) {
      return json({ state: null });
    }
    const state =
      row.taskState === 'cancelled' || row.receiptState === 'suppressed'
        ? 'cancelled'
        : row.receiptState === 'claimed'
          ? 'firing'
          : row.receiptState === 'handled'
            ? 'fired'
            : 'pending';
    return json({ state, cancelled_by: row.cancelledBy });
  }
  if (request.method === 'GET' && route === '/session-count') {
    const row = store?.orm.select({ count: sql`COUNT(*)` }).from(adminSessions).get();
    return json({ count: Number(row?.count ?? 0n) });
  }
  return json({ error: 'not_found' }, 404);
}
