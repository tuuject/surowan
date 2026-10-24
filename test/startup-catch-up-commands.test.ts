import { afterAll, describe, expect, test, vi } from 'vitest';
import type { CommandSender } from '../src/orchestration/bot-commands.ts';
import type { FixtureConfig } from './helpers.ts';
import { runStartupCatchUp } from '../src/startup-catch-up.ts';
import {
  FIRST_CHAT_ID,
  SECOND_CHAT_ID,
  cleanupDirectories,
  commandUpdate,
  fakeApi,
  fixedClock,
  setup,
  textUpdate,
} from './startup-catch-up-fixtures.ts';

afterAll(cleanupDirectories);

describe('startup catch-up commands', () => {
  const ADMIN: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
  const admins: (config: FixtureConfig) => void = (config) => {
    config.telegram.admins = [42];
  };

  test('replays /pause and /resume from the backlog in update order', async () => {
    const { store, ingestion, scheduler, commands } = await setup(true, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        commandUpdate(2, 11, '/pause'),
        commandUpdate(3, 12, '/resume'),
        textUpdate(4, 13, 7, SECOND_CHAT_ID),
        commandUpdate(5, 14, '/pause', { chatId: SECOND_CHAT_ID }),
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    // The first chat ends resumed and queues its catch-up invocation; the
    // second ends paused, so its bucket is skipped with chat_paused.
    expect(result.storedMessages).toBe(2);
    expect(result.invocationIds).toHaveLength(1);
    expect(
      store.db
        .prepare<[], { chat_id: bigint }>(
          'SELECT c.telegram_chat_id AS chat_id FROM chat_pause p JOIN chats c ON c.id = p.chat_id',
        )
        .all(),
    ).toEqual([{ chat_id: BigInt(SECOND_CHAT_ID) }]);
    expect(
      store.db
        .prepare<[], { chat_id: bigint; state: string; error_code: string | null }>(
          `SELECT c.telegram_chat_id AS chat_id, b.state, b.error_code
           FROM buckets b JOIN conversations v ON v.id = b.conversation_id JOIN chats c ON c.id = v.chat_id
           ORDER BY c.telegram_chat_id`,
        )
        .all(),
    ).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), state: 'queued', error_code: null },
      { chat_id: BigInt(SECOND_CHAT_ID), state: 'skipped_budget', error_code: 'chat_paused' },
    ]);
    // Commands are audited, never stored as messages.
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM message_revisions WHERE text LIKE '/%'")
        .get()?.count,
    ).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(5n);
    store.close();
  });

  test('a later /pause in the backlog overrides an earlier /resume', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/resume'), commandUpdate(3, 12, '/pause')]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'skipped_budget', error_code: 'chat_paused' });
    store.close();
  });

  test('a non-admin /pause in the backlog is audited and changes nothing', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      config.telegram.admins = [7];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause', { senderId: 42 })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(
      store.db.prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'queued', error_code: null });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(2n);
    store.close();
  });

  test('other commands are audited but never stored, replayed, or injected', async () => {
    const { store, ingestion, scheduler, commands, build } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        commandUpdate(2, 11, '/status'),
        commandUpdate(3, 12, '/cut_topic'),
        commandUpdate(4, 13, '/whoami'),
        commandUpdate(5, 14, '/model'),
      ]),
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
    // /cut_topic's cutoff is an administrative effect that must not be replayed.
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE allowed = 1').get()
        ?.count,
    ).toBe(5n);
    const invocationId = result.invocationIds[0];
    if (invocationId === undefined) {
      throw new Error('Expected a catch-up invocation');
    }
    const context = build(invocationId);
    expect(context.userPrompt).toContain('message from 7');
    for (const token of ['/status', '/cut_topic', '/whoami', '/model']) {
      expect(context.userPrompt).not.toContain(token);
    }
    store.close();
  });

  test('an admin /allowlist in an unlisted chat is not replayed from the backlog', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const result = await runStartupCatchUp({
      api: fakeApi([commandUpdate(1, 10, '/allowlist', { chatId: SECOND_CHAT_ID })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(0);
    expect(result.invocationIds).toHaveLength(0);
    expect(
      store.db
        .prepare<[], { allowed: bigint; rejection_reason: string }>(
          'SELECT allowed, rejection_reason FROM telegram_updates',
        )
        .get(),
    ).toEqual({ allowed: 0n, rejection_reason: 'chat_not_allowed' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chats').get()?.count).toBe(0n);
    store.close();
  });

  test('an edited /pause in the backlog is a revision, not a command', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const edited = commandUpdate(2, 10, '/pause');
    const editedMessage = edited.message;
    if (editedMessage === undefined) {
      throw new Error('Invalid fixture');
    }
    const result = await runStartupCatchUp({
      api: fakeApi([
        textUpdate(1, 10, 7),
        { update_id: 2, edited_message: { ...editedMessage, edit_date: 1_700_000_100 } },
      ]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM message_revisions').get()?.count,
    ).toBe(2n);
    store.close();
  });

  test("an ignored user's /pause in the backlog is dropped", async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, (config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause')]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.storedMessages).toBe(1);
    expect(result.invocationIds).toHaveLength(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('a retried drain does not replay commands for duplicate updates', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    const clock = fixedClock();
    const api = fakeApi([textUpdate(1, 10, 7), commandUpdate(2, 11, '/pause')]);
    const first = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: clock,
    });
    expect(first.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);

    // The admin resumes live, then the process dies before acknowledging and the
    // same backlog is fetched again: the duplicate /pause must not re-apply.
    expect(await commands.run({ name: 'resume' }, BigInt(FIRST_CHAT_ID), ADMIN)).toBe('已恢复本群互动。');
    const retry = await runStartupCatchUp({
      api,
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: clock,
    });
    expect(retry.storedMessages).toBe(0);
    expect(retry.invocationIds).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates').get()?.count).toBe(
      2n,
    );
    store.close();
  });

  test('proactive scheduling gates a catch-up batch without a direct cue', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const random = vi.fn(() => 0.99);
    const { store, ingestion, scheduler, commands } = await setup(
      false,
      (config) => {
        config.telegram.proactive_reply = {
          enabled: true,
          base_probability: 0.2,
          increment: 0.1,
          hard_pity: 8,
        };
      },
      { bot: { id: BigInt(999), username: 'SurowanBot' }, random },
    );
    const result = await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.invocationIds).toHaveLength(0);
    expect(random).toHaveBeenCalledTimes(1);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(0n);
    expect(
      store.db.prepare<[], { state: string; error_code: string }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'skipped_budget', error_code: 'proactive_reply_skipped' });
    expect(
      store.db.prepare<[], { consecutive_misses: bigint }>('SELECT consecutive_misses FROM proactive_reply_state').get()
        ?.consecutive_misses,
    ).toBe(1n);
    vi.restoreAllMocks();
    store.close();
  });

  test('live commands keep their realtime contract after the drain', async () => {
    const { store, ingestion, scheduler, commands } = await setup(false, admins);
    await runStartupCatchUp({
      api: fakeApi([textUpdate(1, 10, 7)]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    const live = ingestion.ingest(commandUpdate(2, 11, '/pause'));
    expect(live.command).toEqual({ name: 'pause', messageId: 11n });
    expect(live.messageId).toBeUndefined();
    const command = live.command;
    if (command === undefined) {
      throw new Error('Expected a live command');
    }
    expect(await commands.run(command, BigInt(FIRST_CHAT_ID), ADMIN)).toBe('已暂停本群互动，发送 /resume 可恢复。');
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });
});
