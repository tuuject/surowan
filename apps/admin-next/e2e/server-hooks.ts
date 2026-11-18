/**
 * The test-only `/__e2e/**` hooks: state manipulation, the upstream's counters,
 * the health gate and shutdown. `e2e/server.ts` routes every request under that
 * prefix here before `AdminServer` sees it.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';
import { applyEdits, modify } from 'jsonc-parser';
import {
  adminPairings,
  adminUsers,
  adminPasskeys,
  adminSessions,
  buckets,
  chats,
  conversations,
  invocations,
  longTasks,
  memoPadEntries,
  taskReceipts,
} from '../../../src/store/schema/index.ts';
import { AdminAuth } from '../../../src/ingress/admin/auth.ts';
import { enterSleep, wakeFromSleep } from '../../../src/store/sleep.ts';
import { asRunResult } from '../../../src/store/store.ts';
import { shutdown } from './server-lifecycle.ts';
import { holdHealthGate, relayStatsPayload, releaseHealthGate, resetRelayStats } from './server-relay.ts';
import { type PlaygroundModelStep, playgroundSeedPayload, roomModelCalls, setPlaygroundModel } from './server-rooms.ts';
import { state as serverState } from './server-state.ts';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const SERVER_CLI = join(import.meta.dirname, '..', '..', '..', 'src', 'cli.ts');
const execFileAsync = promisify(execFile);

/**
 * Mints a pairing ticket with the real server CLI against this server's live
 * config and database, the way an operator does over SSH while `serve` runs.
 */
async function createPairingWithCli(purpose: 'web' | 'client', ttlSeconds: string | null): Promise<unknown> {
  const flags = [
    ...(purpose === 'web' ? ['--web'] : ['--name', 'e2e-agent', '--mode', 'read']),
    ...(ttlSeconds === null ? [] : ['--ttl-seconds', ttlSeconds]),
  ];
  const { stdout } = await execFileAsync(process.execPath, [
    SERVER_CLI,
    'pairing',
    'create',
    ...flags,
    '--config',
    join(serverState.directory, 'config.jsonc'),
  ]);
  return JSON.parse(stdout);
}

export async function handleHook(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice('/__e2e'.length);
  if (request.method === 'GET' && route === '/health') {
    return json({ ok: true });
  }
  if (request.method === 'GET' && route === '/config-text') {
    // The MCP servers spec writes its review artifact from the config file the
    // server actually holds after its panel writes.
    const text = await readFile(join(serverState.directory, 'config.jsonc'), 'utf8');
    return json({ path: join(serverState.directory, 'config.jsonc'), text });
  }
  if (request.method === 'POST' && route === '/telegram-connection') {
    const body = (await request.json().catch(() => null)) as {
      status?: unknown;
      reason?: unknown;
      bot?: { id?: unknown; username?: unknown } | null;
    } | null;
    const connections = serverState.connections;
    if (body === null) {
      return json({ error: 'invalid_body' }, 400);
    }
    if (connections === null) {
      return json({ error: 'not_ready' }, 503);
    }
    const since = new Date().toISOString();
    if (body.status === 'connected') {
      const bot =
        typeof body.bot?.id === 'string'
          ? { id: body.bot.id, username: typeof body.bot.username === 'string' ? body.bot.username : null }
          : { id: '42', username: 'surowan_bot' };
      connections.set('telegram', { status: 'connected', since, bot });
      return json({ ok: true });
    }
    if (body.status === 'config_error') {
      const reason = body.reason;
      if (reason !== 'unauthorized' && reason !== 'conflict' && reason !== 'token_unreadable') {
        return json({ error: 'invalid_reason' }, 400);
      }
      connections.set('telegram', { status: 'config_error', since, reason });
      return json({ ok: true });
    }
    if (body.status === 'network_error' || body.status === 'disabled') {
      connections.set('telegram', { status: body.status, since });
      return json({ ok: true });
    }
    return json({ error: 'invalid_status' }, 400);
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
  if (request.method === 'POST' && route === '/deprecated-config') {
    // Writes the deprecated-but-accepted fields into the fixture config file
    // (or removes them) so a spec can apply the file and watch the standing
    // warning appear and disappear like an operator's edit would.
    const enabled = url.searchParams.get('enabled') === '1';
    const configPath = join(serverState.directory, 'config.jsonc');
    const text = await readFile(configPath, 'utf8');
    const writes: [readonly string[], unknown][] = [
      [['agent', 'memory_ttl_warning_days'], 30],
      [['agent', 'send_empty_text_fallback_enabled'], true],
      [['vision', 'background_sticker_concurrency'], 1],
    ];
    const edits = writes.flatMap(([path, value]) => modify(text, [...path], enabled ? value : undefined, {}));
    await writeFile(configPath, applyEdits(text, edits));
    return json({ ok: true, enabled });
  }
  if (request.method === 'POST' && route === '/shutdown') {
    setTimeout(() => void shutdown(), 50);
    return json({ status: 'stopping' });
  }
  const store = serverState.store;
  if (request.method === 'POST' && route === '/expire-memo') {
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const id = url.searchParams.get('id');
    if (id === null) {
      return json({ error: 'missing_id' }, 400);
    }
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    const createdAt = new Date(Date.parse(expiresAt) - 3_600_000).toISOString();
    const result = asRunResult(
      store.orm.update(memoPadEntries).set({ createdAt, expiresAt }).where(eq(memoPadEntries.id, id)).run(),
    );
    return json({ updated: Number(result.changes), expires_at: expiresAt });
  }
  if (request.method === 'POST' && route === '/insert-invocation') {
    // A copy of the newest completed invocation, created now: the arrival a
    // list snapshot must keep out until the reader asks for new records.
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const source = store.orm
      .select()
      .from(invocations)
      .where(eq(invocations.state, 'completed'))
      .orderBy(desc(invocations.id))
      .limit(1)
      .get();
    if (source === undefined) {
      return json({ error: 'no_source_invocation' }, 500);
    }
    const { id: _sourceId, ...columns } = source;
    const inserted = store.orm
      .insert(invocations)
      .values({ ...columns, createdAt: new Date().toISOString() })
      .returning({ id: invocations.id })
      .get();
    return json({ id: inserted?.id.toString() ?? null });
  }
  if (request.method === 'POST' && route === '/ensure-admin') {
    // The panel has no web setup: specs that only need a signed-in session get
    // the account the way `admin-account` makes one. A no-op once any account
    // exists, so it never resets a spec's credentials or sessions.
    const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    if (body === null || typeof body.username !== 'string' || typeof body.password !== 'string') {
      return json({ error: 'invalid_body' }, 400);
    }
    if (serverState.store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const orm = serverState.store.orm;
    if (orm.select({ id: adminUsers.id }).from(adminUsers).limit(1).get() !== undefined) {
      return json({ created: false });
    }
    await new AdminAuth(orm, 12).createOrResetAccount(
      { username: body.username, password: body.password },
      { revokePasskeys: false },
    );
    return json({ created: true });
  }
  if (request.method === 'POST' && route === '/official-image') {
    // The marker the official Dockerfile sets; the session reads it per request.
    if (url.searchParams.get('enabled') === '1') {
      process.env.SUROWAN_OFFICIAL_IMAGE = '1';
    } else {
      delete process.env.SUROWAN_OFFICIAL_IMAGE;
    }
    return json({ ok: true });
  }
  if (request.method === 'POST' && route === '/pairing-create') {
    const purpose = url.searchParams.get('purpose');
    if (purpose !== 'web' && purpose !== 'client') {
      return json({ error: 'invalid_purpose' }, 400);
    }
    const ttl = url.searchParams.get('ttl');
    if (ttl !== null && !/^\d{1,4}$/.test(ttl)) {
      return json({ error: 'invalid_ttl' }, 400);
    }
    return json(await createPairingWithCli(purpose, ttl));
  }
  if (request.method === 'GET' && route === '/pairing-rows') {
    const rows =
      store === null
        ? []
        : store.orm
            .select({
              id: adminPairings.id,
              purpose: adminPairings.purpose,
              consumedAt: adminPairings.consumedAt,
              clientId: adminPairings.clientId,
            })
            .from(adminPairings)
            .orderBy(adminPairings.id)
            .all();
    const sessions =
      store === null ? 0 : (store.orm.select({ count: sql<number>`count(*)` }).from(adminSessions).get()?.count ?? 0);
    return json({
      sessions: Number(sessions),
      rows: rows.map((row) => ({
        id: row.id.toString(),
        purpose: row.purpose,
        consumed: row.consumedAt !== null,
        client_id: row.clientId?.toString() ?? null,
      })),
    });
  }
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
  if (request.method === 'POST' && route === '/running-invocation') {
    // An Invocation the database calls running, in a Conversation of the
    // configured Chat that follows the global model. Nothing executes it: the
    // model switch confirmation only reads the row, and `/finish` ends it.
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const conversation = store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(and(eq(chats.hostKind, 'telegram'), eq(chats.hostChatId, 123_456_789n)))
      .orderBy(conversations.id)
      .get();
    if (conversation === undefined) {
      return json({ error: 'conversation_missing' }, 500);
    }
    const now = new Date().toISOString();
    const bucket = store.orm
      .insert(buckets)
      .values({
        conversationId: conversation.id,
        state: 'running',
        firstReceivedAt: now,
        deadlineAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: buckets.id })
      .get();
    if (bucket === undefined) {
      return json({ error: 'bucket_insert_failed' }, 500);
    }
    const invocation = store.orm
      .insert(invocations)
      .values({
        bucketId: bucket.id,
        conversationId: conversation.id,
        state: 'running',
        configHash: 'e2e-running',
        promptVersion: 1n,
        startedAt: now,
        createdAt: now,
      })
      .returning({ id: invocations.id })
      .get();
    return json({ id: invocation?.id.toString() ?? null });
  }
  if (request.method === 'POST' && route === '/running-invocation/finish') {
    const id = url.searchParams.get('id');
    if (id === null || !/^\d{1,19}$/.test(id)) {
      return json({ error: 'invalid_id' }, 400);
    }
    if (store === null) {
      return json({ error: 'store_closed' }, 500);
    }
    const now = new Date().toISOString();
    const result = asRunResult(
      store.orm
        .update(invocations)
        .set({ state: 'completed', completionReason: 'e2e_finished', finishedAt: now })
        .where(and(eq(invocations.id, BigInt(id)), eq(invocations.state, 'running')))
        .run(),
    );
    return json({ updated: Number(result.changes) });
  }
  if (request.method === 'GET' && route === '/session-count') {
    const row = store?.orm.select({ count: sql`COUNT(*)` }).from(adminSessions).get();
    return json({ count: Number(row?.count ?? 0n) });
  }
  return json({ error: 'not_found' }, 404);
}
