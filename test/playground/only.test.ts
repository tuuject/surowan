/**
 * Acceptance: a `serve` process with Telegram disabled.
 *
 * The configuration has no `telegram` section at all, which is a legal state:
 * the process runs the shared store, Scheduler, Admin panel and room write path
 * with no Bot, no token resolution, no command registration, no webhook delete,
 * no ingestion, no sticker sync and no startup catch-up. MCP is still built,
 * because it does not belong to Telegram. The model is a local HTTP fixture that
 * answers the Responses API with a real `send` tool call, so the room's Release
 * runs the production runtime end to end.
 *
 * The same database also holds synthetic Telegram work: after the room round
 * finishes, that work must stay put - not recovered, not expired, not launched
 * and not skipped by the scheduler. Timers still complete on schedule, but
 * their receipts remain pending because Telegram is not ready.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ServeLock, SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { serve } from '../../src/adapters/local-monolith/runtime/index.ts';
import { startFixtureServer, stopFixtureServer } from '../helpers.ts';

const { botConstructed } = vi.hoisted(() => ({ botConstructed: vi.fn() }));
vi.mock('grammy', () => ({
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  Bot: class {
    api = {
      getMe: () => Promise.reject(new Error('a process with Telegram disabled must not call Telegram')),
    };
    constructor() {
      botConstructed();
      throw new Error('a process with Telegram disabled must not build a Bot');
    }
  },
}));

const directories: string[] = [];
const running: Promise<unknown>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const serving of running.splice(0)) {
    await serving.catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function sse(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** One Responses-API turn that calls `send` with the given text. */
function sendTurn(text: string): Response {
  const args = JSON.stringify({ kind: 'text', text });
  return sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: args },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'send', arguments: args },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

/** One Responses-API turn with private text only: the round ends without sending. */
function textTurn(text: string): Response {
  return sse([
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_2',
        status: 'completed',
        output: [],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      },
    },
  ]);
}

/** A port the OS just had free; the configuration requires a real one. */
async function freePort(): Promise<number> {
  const probe = await startFixtureServer(() => new Response('ok'));
  const address = probe.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await stopFixtureServer(probe.server);
  return port;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

test('a process with Telegram disabled runs the room round and only recovers what a dead process left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-playground-only-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const dataDir = join(directory, 'data');
  let agentCalls = 0;
  const upstream = await startFixtureServer(async () => {
    agentCalls += 1;
    return agentCalls === 1 ? sendTurn('the room answers') : textTurn('done');
  });
  process.env.PG_ONLY_AGENT_KEY = 'fixture-agent-key';
  process.env.PG_ONLY_VISION_KEY = 'fixture-vision-key';
  try {
    const port = await freePort();
    const config = {
      version: 1,
      data_dir: dataDir.replaceAll('\\', '/'),
      timezone: 'UTC',
      providers: {
        agent: {
          kind: 'custom',
          base_url: `http://127.0.0.1:${upstream.port}`,
          api: 'openai-responses',
          api_key: { env: 'PG_ONLY_AGENT_KEY' },
          models: [
            {
              id: 'agent-model',
              name: 'Agent Model',
              reasoning: true,
              compat: { supports_developer_role: false },
              input: ['text'],
              context_window: 200_000,
              max_tokens: 32_768,
              cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
            },
          ],
        },
        vision: {
          kind: 'custom',
          base_url: `http://127.0.0.1:${upstream.port}`,
          api: 'openai-responses',
          api_key: { env: 'PG_ONLY_VISION_KEY' },
          models: [
            {
              id: 'vision-model',
              name: 'Vision Model',
              reasoning: false,
              input: ['text', 'image'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
            },
          ],
        },
      },
      agent: {
        provider: 'agent',
        model: 'agent-model',
        daily_budget: { max_tokens: 300_000 },
        thinking_level: 'off',
        system_prompt_file: 'agent-system-prompt.md',
        max_concurrency: 4,
        context_stop_ratio: 0.8,
        history_messages: 20,
        send_nudge_enabled: false,
        send_barrier_enabled: false,
        context: {
          retained_sends_target: 2,
          retained_sends_max: 3,
          hard_token_ratio: 0.6,
          ref_ttl_hours: 72,
          idle_grace_seconds: 0,
          max_wall_clock_seconds: 900,
          agent_cache_size: 8,
        },
        rate_limits: { sends_per_window: 6, window_seconds: 300, turns_per_injection: 8 },
      },
      vision: {
        provider: 'vision',
        model: 'vision-model',
        max_output_tokens: 2048,
        max_concurrency: 2,
        background_sticker_concurrency: 1,
        prompt_version: 1,
        daily_budget: { max_tokens: 200_000, max_images: 200 },
      },
      retention: { online_days: 30, backup_copies: 7 },
      paths: {
        database: join(dataDir, 'surowan.sqlite').replaceAll('\\', '/'),
        media_cache: join(dataDir, 'media').replaceAll('\\', '/'),
        backups: join(dataDir, 'backups').replaceAll('\\', '/'),
      },
      admin: { enabled: true, host: '127.0.0.1', port, session_ttl_hours: 12 },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'agent-system-prompt.md'), 'You are a test agent.\n', { mode: 0o600 });
    await writeFile(join(directory, 'chat-instructions.md'), 'Test group.\n', { mode: 0o600 });

    // Synthetic Telegram work: a running invocation, a queued one, a due
    // alarm, a stale collecting bucket, a queued invocation holding a claimed
    // receipt for a chat the config no longer lists, and an active sleep
    // window. Startup recovery closes what the dead previous process left
    // (its run, its claim, its stale bucket) whether or not Telegram is up;
    // receipt claims, suppression, the sleep skip and launches all wait for a
    // ready connection.
    const stamp = new Date().toISOString();
    const due = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const sleepUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    const seeding = await SqliteStore.open((await loadConfig(configPath)).config);
    seeding.db.exec(`
      INSERT INTO chats(id, host_kind, telegram_chat_id, canonical_chat_id, type, title, updated_at)
        VALUES (900, 'telegram', 123456789, 123456789, 'supergroup', 'TG fixture', '${stamp}');
      INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
        VALUES (900, 900, 0, '${stamp}', '${stamp}');
      INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, queued_at, started_at, created_at, updated_at)
        VALUES (900, 900, 'running', 'realtime', '${stamp}', '${stamp}', '${stamp}', '${stamp}', '${stamp}', '${stamp}'),
               (901, 900, 'queued', 'realtime', '${stamp}', '${stamp}', '${stamp}', NULL, '${stamp}', '${stamp}');
      INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, created_at)
        VALUES (900, 900, 900, 'running', 'tg-fixture', 1, '${stamp}', '${stamp}'),
               (901, 901, 900, 'queued', 'tg-fixture', 1, NULL, '${stamp}');
      INSERT INTO long_tasks(id, plugin_id, conversation_id, payload_json, state, scheduled_at, timer_result_json, delivery_json, created_at, updated_at)
        VALUES (900, 'alarm', 900, '{"summary":"telegram alarm"}', 'waiting', '${due}', '{"summary":"telegram alarm"}', '{"bypassDailyBudget":false}', '${stamp}', '${stamp}'),
               (901, 'alarm', 900, '{"summary":"fired alarm"}', 'completed', '${due}', '{"summary":"fired alarm"}', '{"bypassDailyBudget":false}', '${stamp}', '${stamp}');
      INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
        VALUES (901, 900, 7, '${stamp}', '${stamp}');
      INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, queued_at, started_at, created_at, updated_at)
        VALUES (902, 901, 'collecting', 'realtime', '${stale}', '${stale}', NULL, NULL, '${stale}', '${stale}'),
               (903, 900, 'queued', 'realtime', '${stamp}', '${stamp}', '${stamp}', NULL, '${stamp}', '${stamp}');
      INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, created_at)
        VALUES (903, 903, 900, 'queued', 'tg-fixture', 1, NULL, '${stamp}');
      INSERT INTO task_receipts(task_id, status, result_json, state, created_at, updated_at, claimed_at, invocation_id)
        VALUES (901, 'completed', '{"summary":"fired alarm"}', 'claimed', '${stamp}', '${stamp}', '${stamp}', 903);
      INSERT INTO app_state(key, value, updated_at) VALUES ('bot_sleep_until', '${sleepUntil}', '${stamp}');
    `);
    seeding.close();

    const events: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = String(args[0] ?? '');
      if (!line.startsWith('{')) {
        return;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.event === 'string') {
          events.push(parsed);
        }
      } catch {
        // Not a structured event line.
      }
    });
    const serving = serve(configPath);
    running.push(serving);
    await expect.poll(() => events.some((entry) => entry.event === 'admin_started'), { timeout: 30_000 }).toBe(true);

    // The process never built a Bot, never registered commands and never ran
    // the Telegram startup pass; the connection state is the disabled one.
    expect(botConstructed).not.toHaveBeenCalled();
    const names = events.map((entry) => entry.event);
    expect(names).not.toContain('commands_registered');
    expect(names).not.toContain('startup_catch_up_completed');
    expect(events.find((entry) => entry.event === 'serve_started')).toMatchObject({ mode: 'disabled', bot_id: null });

    // The panel is the only entry point, and the room round runs for real.
    const base = `http://127.0.0.1:${port}`;
    const setup = await fetch(
      `${base}/api/auth/setup`,
      jsonBody({ username: 'owner', password: 'correct-horse-battery' }),
    );
    expect(setup.status).toBe(200);
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { cookie, ...(init.headers ?? {}) },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const created = await call(
      '/api/playground/rooms',
      jsonBody({ title: 'Only room', members: [{ name: 'Ada' }], request_key: 'room-1' }),
    );
    expect(created.status).toBe(201);
    const roomId = (created.body.room as { id: string }).id;
    const detail = await call(`/api/playground/rooms/${roomId}`);
    const memberId = (detail.body.participants as { id: string }[])[0]?.id;
    expect(memberId).toBeDefined();

    const submitted = await call(
      `/api/playground/rooms/${roomId}/messages`,
      jsonBody({ request_key: 'msg-1', sender_id: memberId, text: 'draw something' }),
    );
    expect(submitted.status).toBe(201);
    const state = await call(`/api/playground/rooms/${roomId}`);
    const room = state.body.room as { revision: string; next_seq: string };
    const released = await call(
      `/api/playground/rooms/${roomId}/releases`,
      jsonBody({
        request_key: 'rel-1',
        revision: room.revision,
        through_seq: (BigInt(room.next_seq) - 1n).toString(),
      }),
    );
    expect(released.status).toBe(201);
    expect(released.body.invocation_id).not.toBeNull();

    await expect
      .poll(
        async () => {
          const timeline = await call(`/api/playground/rooms/${roomId}/messages`);
          const items = timeline.body.items as { sent_by_bot: boolean; text: string | null }[];
          return items.find((item) => item.sent_by_bot)?.text ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe('the room answers');

    const releaseDetail = await call(`/api/playground/rooms/${roomId}/releases/${String(released.body.release_id)}`);
    expect(releaseDetail.body.attempts).toHaveLength(1);
    expect(releaseDetail.body.attempts).toMatchObject([{ state: 'completed' }]);
    expect(releaseDetail.body.sends).toMatchObject([{ state: 'success', kind: 'text' }]);
    expect(agentCalls).toBeGreaterThan(0);

    // The dead process's run and its claimed receipt are closed by startup
    // recovery; the fresh queued run still waits for Telegram.
    const invocations = await call('/api/invocations?limit=50');
    const byId = new Map(
      (invocations.body.items as { id: string; state: string }[]).map((item) => [item.id, item.state]),
    );
    expect(byId.get('900')).toBe('aborted');
    expect(byId.get('901')).toBe('queued');
    expect(byId.get('903')).toBe('aborted');

    // A config apply validates tool registries against a host this process
    // binds: without the Telegram host, a Telegram preview would fail every
    // apply as model_unusable.
    config.agent.thinking_level = 'low';
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    const applied = await call('/api/config/apply', { method: 'POST' });
    expect(applied).toMatchObject({ status: 200, body: { status: 'applied', applied: ['agent.thinking_level'] } });

    // A second instance may not start while this one holds the lock.
    await expect(ServeLock.acquire(dataDir)).rejects.toThrow();

    // Shutdown through the same stop-request path a takeover uses.
    await writeFile(join(dataDir, 'serve.stop'), `${process.pid}\n`, { mode: 0o600 });
    await expect
      .poll(() => events.some((entry) => entry.event === 'shutdown_requested'), { timeout: 20_000 })
      .toBe(true);
    await serving;

    // The lock is released, so a restart needs no manual lock cleanup.
    const lock = await ServeLock.acquire(dataDir);
    await lock.release();

    // The persisted Telegram rows, read after the process stopped. With no
    // Telegram instance the overdue timer still completes, but its receipt is
    // never claimed and no invocation is queued for it. Recovery closed the
    // previous process's work once at startup; nothing was launched.
    const after = await SqliteStore.open((await loadConfig(configPath)).config);
    try {
      const row = (query: string) => after.db.prepare(query).get() as Record<string, unknown> | undefined;
      expect(row('SELECT state FROM long_tasks WHERE id = 900')).toEqual({ state: 'completed' });
      expect(row('SELECT COUNT(*) AS n FROM task_receipts WHERE task_id = 900')).toEqual({ n: 1n });
      expect(row('SELECT state FROM task_receipts WHERE task_id = 900')).toEqual({ state: 'pending' });
      // A claim of a dead process is never replayed.
      expect(row('SELECT state FROM task_receipts WHERE task_id = 901')).toEqual({ state: 'handled' });
      expect(row('SELECT state, completion_reason FROM invocations WHERE id = 900')).toEqual({
        state: 'aborted',
        completion_reason: 'process_restart',
      });
      expect(row('SELECT state, error_code FROM buckets WHERE id = 900')).toEqual({
        state: 'aborted',
        error_code: 'process_restart',
      });
      expect(row('SELECT state, error_code FROM buckets WHERE id = 902')).toEqual({
        state: 'expired',
        error_code: 'recovery_age',
      });
      expect(row('SELECT state FROM buckets WHERE id = 901')).toEqual({ state: 'queued' });
      expect(row('SELECT state FROM buckets WHERE id = 903')).toEqual({ state: 'aborted' });
      expect(row('SELECT state FROM invocations WHERE id = 901')).toEqual({ state: 'queued' });
      expect(row('SELECT state, completion_reason FROM invocations WHERE id = 903')).toEqual({
        state: 'aborted',
        completion_reason: 'process_restart',
      });
    } finally {
      after.close();
    }
  } finally {
    await stopFixtureServer(upstream.server);
  }
});
