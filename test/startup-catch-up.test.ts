import { afterAll, describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { STARTUP_CATCH_UP_STATE_KEY } from '../src/orchestration/scheduler.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { runStartupCatchUp, type StartupCatchUpApi } from '../src/startup-catch-up.ts';
import { invocationCapabilities, sleep, testSendToolEnv } from './helpers.ts';
import {
  FIRST_CHAT_ID,
  SECOND_CHAT_ID,
  cleanupDirectories,
  fakeApi,
  fixedClock,
  setup,
  stickerUpdate,
  textUpdate,
  topicUpdate,
} from './startup-catch-up-fixtures.ts';

afterAll(cleanupDirectories);

describe('startup catch-up', () => {
  test('creates one invocation per conversation with the configured latest messages', async () => {
    const { store, ingestion, scheduler, commands } = await setup(true);
    const updates: Update[] = [];
    for (let index = 0; index < 15; index += 1) {
      updates.push(topicUpdate(index * 2 + 1, index + 1, FIRST_CHAT_ID, 100, 1_700_000_000 + index));
      updates.push(topicUpdate(index * 2 + 2, index + 101, SECOND_CHAT_ID, 200, 1_700_000_000 + index));
    }
    const result = await runStartupCatchUp({
      api: fakeApi(updates),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.updates).toBe(30);
    expect(result.invocationIds).toHaveLength(2);
    const buckets = store.db
      .prepare<[], { kind: string; state: string; count: bigint }>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state',
      )
      .all();
    expect(buckets).toEqual([{ kind: 'startup_catch_up', state: 'queued', count: 2n }]);
    const snapshots = store.db
      .prepare<[], { chat_id: bigint; section: string; count: bigint; first_message: bigint; last_message: bigint }>(
        `SELECT c.telegram_chat_id AS chat_id, im.section, COUNT(*) AS count,
                MIN(m.telegram_message_id) AS first_message, MAX(m.telegram_message_id) AS last_message
         FROM invocation_messages im
         JOIN invocations i ON i.id = im.invocation_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         JOIN messages m ON m.id = im.message_id
         GROUP BY c.telegram_chat_id, im.section
         ORDER BY c.telegram_chat_id`,
      )
      .all();
    expect(snapshots).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), section: 'new', count: 10n, first_message: 6n, last_message: 15n },
      { chat_id: BigInt(SECOND_CHAT_ID), section: 'new', count: 10n, first_message: 106n, last_message: 115n },
    ]);
    expect(
      store.db.prepare('SELECT value FROM app_state WHERE key = ?').get(STARTUP_CATCH_UP_STATE_KEY),
    ).toBeUndefined();
    store.close();
  });

  test('excludes ignored users from startup catch-up storage and context', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 42), textUpdate(2, 11, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    const snapshot = store.db
      .prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages')
      .get();
    expect(snapshot === undefined ? null : JSON.parse(snapshot.snapshot_json).sender.id).toBe('7');
    store.close();

    const ignoredOnly = await setup(false, (config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const ignoredOnlyResult = await runStartupCatchUp({
      api: fakeApi([textUpdate(3, 12, 42)]),
      store: ignoredOnly.store,
      ingestion: ignoredOnly.ingestion,
      scheduler: ignoredOnly.scheduler,
      commands: ignoredOnly.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(ignoredOnlyResult.storedMessages).toBe(0);
    expect(ignoredOnlyResult.invocationIds).toHaveLength(0);
    ignoredOnly.store.close();
  });

  test('applies sticker_trigger_enabled to startup catch-up invocations', async () => {
    const disabled = await setup(false);
    const disabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: disabled.store,
      ingestion: disabled.ingestion,
      scheduler: disabled.scheduler,
      commands: disabled.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(disabledResult.storedMessages).toBe(1);
    expect(disabledResult.invocationIds).toHaveLength(0);
    disabled.store.close();

    const enabled = await setup(false, (config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    const enabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: enabled.store,
      ingestion: enabled.ingestion,
      scheduler: enabled.scheduler,
      commands: enabled.commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(enabledResult.invocationIds).toHaveLength(1);
    enabled.store.close();
  });

  test('switches to realtime buckets after draining pending updates', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    await runStartupCatchUp({
      api: fakeApi([topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    const live = ingestion.ingest(
      topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_100),
      new Date('2026-08-17T03:01:00.000Z'),
    );
    expect(live.bucketId).toBeDefined();
    const states = store.db
      .prepare<[], { kind: string; state: string; count: bigint }>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state ORDER BY kind',
      )
      .all();
    expect(states).toEqual([
      { kind: 'realtime', state: 'collecting', count: 1n },
      { kind: 'startup_catch_up', state: 'queued', count: 1n },
    ]);
    store.close();
  });

  test('keeps forum topics of one chat in separate invocations', async () => {
    const { store, loaded, ingestion, scheduler, commands, build } = await setup(false);
    const result = await runStartupCatchUp({
      api: fakeApi([
        topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000),
        topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_001),
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(result.invocationIds).toHaveLength(2);
    const sentThreads: Array<number | undefined> = [];
    const api: TelegramTransport = {
      sendMessage: async (_chatId, _text, options) => {
        sentThreads.push(options.message_thread_id);
        return { message_id: 500 + sentThreads.length, date: 1_700_000_100, chat: { id: FIRST_CHAT_ID } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: FIRST_CHAT_ID } }),
    };
    const prompts: string[] = [];
    for (const invocationId of result.invocationIds) {
      const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
      prompts.push(context.userPrompt);
      const tool = createSendTool({
        store,
        ...testSendToolEnv(api, context),
        context,
        capabilities: invocationCapabilities(store, loaded.config, context.header),
        sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
        maxTextLength: undefined,
        disallowBlankLines: false,
        deadline: Date.now() + 30_000,
        bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      });
      await tool.execute(`default-topic-${invocationId}`, { kind: 'text', text: 'latest' });
    }
    expect(sentThreads).toEqual([100, 200]);
    expect(prompts[0]).toContain(`chat-${FIRST_CHAT_ID}-message-10`);
    expect(prompts[0]).not.toContain(`chat-${FIRST_CHAT_ID}-message-11`);
    expect(prompts[1]).toContain(`chat-${FIRST_CHAT_ID}-message-11`);
    expect(prompts[1]).not.toContain(`chat-${FIRST_CHAT_ID}-message-10`);
    const outgoingThreads = store.db
      .prepare<[], { message_thread_id: bigint }>(
        'SELECT v.message_thread_id FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.sent_by_bot = 1 ORDER BY m.id',
      )
      .all()
      .map((row) => row.message_thread_id);
    expect(outgoingThreads).toEqual([100n, 200n]);
    store.close();
  });

  test('keeps catch-up work queued across a drain longer than the recovery age', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    let now = new Date('2026-08-17T03:00:00.000Z');
    let polls = 0;
    const api: StartupCatchUpApi = {
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) {
          return [textUpdate(1, 10, 7)];
        }
        // The drain itself outlived RECOVERY_MAX_AGE_MS — the same state a
        // crash mid-drain leaves when the resumed drain finishes later.
        now = new Date(now.getTime() + 6 * 60_000);
        return [];
      },
    };
    const result = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => now,
    });
    expect(result.invocationIds).toHaveLength(1);

    // application.ts runs scheduler.start() right after the drain, and start()
    // calls recover(now) before its loop. Freshly queued catch-up work must
    // survive it; otherwise every message of the drain is dropped as stale.
    scheduler.recover(now);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'queued', error_code: null });
    expect(
      store.db
        .prepare<[], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations',
        )
        .get(),
    ).toEqual({ state: 'queued', completion_reason: null });

    // Not just kept: the run reaches its audited terminal state.
    scheduler.start(now);
    try {
      const deadline = Date.now() + 10_000;
      let invocation: { state: string; completion_reason: string | null } | undefined;
      while (Date.now() < deadline) {
        invocation = store.db
          .prepare<[], { state: string; completion_reason: string | null }>(
            'SELECT state, completion_reason FROM invocations',
          )
          .get();
        if (invocation !== undefined && invocation.state !== 'queued' && invocation.state !== 'running') {
          break;
        }
        await sleep(10);
      }
      expect(invocation).toEqual({ state: 'completed', completion_reason: 'done' });
      expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('completed');
    } finally {
      await scheduler.stop();
      store.close();
    }
  }, 20_000);

  test('still expires catch-up work whose recovery age has truly passed', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false);
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(result.invocationIds).toHaveLength(1);

    // The process died before scheduler.start() and came back six minutes
    // later. Queued work this old is exactly what recovery_age is for: the
    // freshness fix must not keep genuinely stale invocations alive forever.
    scheduler.recover(new Date(Date.parse('2026-08-17T03:00:00.000Z') + 6 * 60_000));
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'expired', error_code: 'recovery_age' });
    expect(
      store.db
        .prepare<[], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations',
        )
        .get(),
    ).toEqual({ state: 'aborted', completion_reason: 'recovery_age' });
    store.close();
  });
});
