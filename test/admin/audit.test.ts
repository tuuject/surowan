/**
 * Admin audit routes: tool sessions, messages and the sticker cache.
 */
import { expect, test } from 'vitest';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { enterSleep } from '../../src/store/sleep.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie, textUpdate } from './fixtures.ts';

test('audit routes expose tool sessions, messages and sticker cache', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const received = new Date('2026-03-01T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello audit panel'), received);
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected an invocation');
    }
    const iso = received.toISOString();
    store.db
      .prepare(
        "UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ?, completion_reason = 'done', turns_used = 1, tool_calls_used = 1, sends_used = 1, tool_registry_json = ? WHERE id = ?",
      )
      .run(
        received.toISOString(),
        received.toISOString(),
        JSON.stringify([
          { name: 'send', label: 'Send to Telegram', description: 'Send one plain-text message' },
          { name: 'add_memory', label: 'Add memory', description: 'Save a short-term note' },
        ]),
        invocationId,
      );
    store.db
      .prepare(
        "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, duration_ms, created_at, finished_at) VALUES (?, 'call-1', 'send', '{\"text\":\"hi\"}', 'sent', 'success', 1, 42, ?, ?)",
      )
      .run(invocationId, iso, iso);
    const toolRow = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM tool_calls WHERE tool_call_id = 'call-1'")
      .get();
    if (toolRow === undefined) {
      throw new Error('Expected the tool call row');
    }
    store.db
      .prepare(
        "INSERT INTO host_sends(tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (?, (SELECT conversation_id FROM invocations WHERE id = ?), 'text', '{\"text\":\"hi\"}', 'success', 555, ?, ?)",
      )
      .run(toolRow.id, invocationId, iso, iso);
    store.db
      .prepare(
        "INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, duration_ms, error_code, error_detail, tools_json, created_at, finished_at) VALUES (?, 'agent', 'agent', 'agent-model', 1, 'error', 100, 20, 500, 30, 620, 0.5, 900, 'model_error', 'status=500\nbody={\"error\":\"upstream exploded\"}', ?, ?, ?)",
      )
      .run(invocationId, JSON.stringify(['send', 'add_memory']), iso, iso);
    store.db
      .prepare(
        "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, 'assistant', 'private reasoning', 'cot before the answer', ?)",
      )
      .run(invocationId, iso);
    store.db
      .prepare(
        "INSERT INTO sticker_sets(alias, telegram_name, title, configured, sync_state, last_synced_at, updated_at) VALUES ('cats', 'CatPack', 'Cat Pack', 1, 'success', ?, ?)",
      )
      .run(iso, iso);
    store.db
      .prepare(
        "INSERT INTO media_analyses(file_unique_id, analysis_version, provider, model, prompt_version, kind, state, description, metadata_json, created_at, updated_at) VALUES ('uniq-1', 'v1', 'vision', 'vision-model', 1, 'sticker', 'success', 'a grinning cat', '{\"tags_en\":[\"cat\"]}', ?, ?)",
      )
      .run(iso, iso);
    const analysis = store.db
      .prepare<[], { id: bigint }>("SELECT id FROM media_analyses WHERE file_unique_id = 'uniq-1'")
      .get();
    if (analysis === undefined) {
      throw new Error('Expected the analysis row');
    }
    store.db
      .prepare(
        "INSERT INTO stickers(sticker_set_id, file_unique_id, file_id, emoji, format, active, current_analysis_id, index_state, updated_at) VALUES ((SELECT id FROM sticker_sets WHERE alias = 'cats'), 'uniq-1', 'file-1', '😺', 'static', 1, ?, 'success', ?)",
      )
      .run(analysis.id, iso);

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const invocations = await readJson(await server.handle(request('/api/invocations', { headers })));
    expect(invocations.items).toHaveLength(1);
    expect(invocations.items[0]).toMatchObject({
      id: invocationId.toString(),
      tool_call_count: 1,
      // Budget definition: input + output + cache read + cache write.
      total_tokens: 650,
      cache_read_tokens: 500,
      cache_write_tokens: 30,
      chat: { telegram_chat_id: '123456789', type: 'private' },
    });

    const detail = await readJson(await server.handle(request(`/api/invocations/${invocationId}`, { headers })));
    expect(detail.tool_calls[0]).toMatchObject({
      tool_name: 'send',
      state: 'success',
      side_effect: true,
      duration_ms: 42,
    });
    expect(detail.tool_registry).toHaveLength(2);
    expect(detail.tool_registry[0]).toMatchObject({ name: 'send', label: 'Send to Telegram' });
    expect(detail.tool_registry[1]?.description).toBe('Save a short-term note');
    expect(detail.model_calls[0]).toMatchObject({
      provider: 'agent',
      model: 'agent-model',
      state: 'error',
      // The provider's raw total is kept for audit but never trusted as the sum.
      total_tokens: 650,
      provider_total_tokens: 620,
      cache_read_tokens: 500,
      cache_write_tokens: 30,
      error_code: 'model_error',
      error_detail: 'status=500\nbody={"error":"upstream exploded"}',
    });
    expect(detail.model_calls[0].tools).toEqual(['send', 'add_memory']);
    expect(detail.agent_messages[0]).toMatchObject({
      role: 'assistant',
      text: 'private reasoning',
      thinking_text: 'cot before the answer',
    });
    expect(detail.telegram_sends[0]).toMatchObject({ kind: 'text', state: 'success', telegram_message_id: '555' });
    expect(detail.context_messages.some((entry: { section: string }) => entry.section === 'new')).toBe(true);

    const missing = await server.handle(request('/api/invocations/999999', { headers }));
    expect(missing.status).toBe(404);
    const badId = await server.handle(request('/api/invocations/not-a-number', { headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });

    const messages = await readJson(await server.handle(request('/api/messages?search=audit', { headers })));
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]).toMatchObject({
      telegram_message_id: '10',
      text: 'hello audit panel',
      revision_count: 1,
      sender: { telegram_id: '42', telegram_type: 'user', display_name: 'Alice' },
    });
    const filteredOut = await readJson(await server.handle(request('/api/messages?search=absent-text', { headers })));
    expect(filteredOut.items).toHaveLength(0);
    const messageDetail = await readJson(
      await server.handle(request(`/api/messages/${messages.items[0].id}`, { headers })),
    );
    expect(messageDetail.revisions[0]).toMatchObject({
      revision_no: 1,
      text: 'hello audit panel',
      sender: { telegram_id: '42', telegram_type: 'user', display_name: 'Alice' },
    });

    const sets = await readJson(await server.handle(request('/api/sticker-sets', { headers })));
    expect(sets.items[0]).toMatchObject({ alias: 'cats', sync_state: 'success', sticker_count: 1, indexed_count: 1 });
    const stickers = await readJson(
      await server.handle(request('/api/stickers?set=cats&state=success&search=grinning', { headers })),
    );
    expect(stickers.items).toHaveLength(1);
    expect(stickers.items[0]).toMatchObject({
      set_alias: 'cats',
      file_unique_id: 'uniq-1',
      index_state: 'success',
      analysis: { provider: 'vision', model: 'vision-model', description: 'a grinning cat', prompt_version: 1 },
    });
    const otherSet = await readJson(await server.handle(request('/api/stickers?set=dogs', { headers })));
    expect(otherSet.items).toHaveLength(0);

    const chat = store.db.prepare<[], { id: bigint }>('SELECT id FROM chats WHERE telegram_chat_id = 123456789').get();
    if (chat === undefined) {
      throw new Error('Expected the chat row');
    }
    store.db.prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)').run(chat.id, iso);
    const sleeping = enterSleep(store.orm);

    const overview = await readJson(await server.handle(request('/api/overview', { headers })));
    expect(overview.invocation_states).toContainEqual({ label: 'completed', count: 1 });
    expect(overview.top_tools).toContainEqual({ label: 'send', count: 1 });
    expect(overview.message_count).toBe(1);
    expect(overview.cached_analysis_count).toBe(1);
    expect(overview.runtime_status).toEqual({
      sleeping: true,
      sleep_until: sleeping.sleepUntil,
      paused_chats: [
        {
          telegram_chat_id: '123456789',
          type: 'private',
          title: null,
          username: null,
          paused_at: iso,
        },
      ],
    });

    const awakened = await server.handle(post('/api/wake', {}, cookie));
    expect(awakened.status).toBe(200);
    expect(await readJson(awakened)).toEqual({ status: 'awake', was_sleeping: true });
    expect((await readJson(await server.handle(request('/api/overview', { headers })))).runtime_status).toMatchObject({
      sleeping: false,
      sleep_until: null,
    });
    expect(await readJson(await server.handle(post('/api/wake', {}, cookie)))).toEqual({
      status: 'awake',
      was_sleeping: false,
    });

    const now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', '123456789', 'model_tokens', 500, ?)",
      )
      .run(now.slice(0, 10), now);

    // Invocation and tool-call counts are read straight from the audit tables,
    // so date them into the requested window instead of writing daily_usage.
    store.db.prepare('UPDATE invocations SET created_at = ?').run(now);
    store.db.prepare('UPDATE tool_calls SET created_at = ?').run(now);

    const usage = await readJson(await server.handle(request('/api/usage?days=7', { headers })));
    expect(usage.days).toBe(7);
    expect(usage.series.length).toBe(7);
    const today = now.slice(0, 10);
    const todayEntry = usage.series.find((entry: { date: string }) => entry.date === today);
    expect(todayEntry).toMatchObject({ date: today, model_tokens: 500, agent_invocations: 1, tool_calls: 1 });

    const invalidDays = await server.handle(request('/api/usage?days=0', { headers }));
    expect(invalidDays.status).toBe(400);
    const tooManyDays = await server.handle(request('/api/usage?days=365', { headers }));
    expect(tooManyDays.status).toBe(400);

    const rejectedLimit = await server.handle(request('/api/invocations?limit=500', { headers }));
    expect(rejectedLimit.status).toBe(400);
    expect(await readJson(rejectedLimit)).toMatchObject({ error: 'invalid_limit' });
    const rejectedFilter = await server.handle(request("/api/stickers?state=success'%20OR%201=1", { headers }));
    expect(rejectedFilter.status).toBe(400);
    expect(await readJson(rejectedFilter)).toMatchObject({ error: 'invalid_state' });
    const writeAttempt = await server.handle(post('/api/invocations', {}, cookie));
    expect(writeAttempt.status).toBe(405);
  } finally {
    store.close();
  }
});
