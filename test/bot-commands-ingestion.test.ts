import { afterAll, describe, expect, test } from 'vitest';
import { FIXED_NOW, cleanupDirectories, commandUpdate, setup } from './bot-commands-fixtures.ts';

afterAll(cleanupDirectories);

describe('ingestion command interception', () => {
  test.each(['ignoreme', 'unignoreme'])('does not allow /%s to bypass Chat or Topic restrictions', async (name) => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.chats[0]!.topic_ids = [8];
      config.telegram.chats[0]!.ignored_user_ids = [42];
    });
    try {
      expect(ingestion.ingest(commandUpdate(1, 10, `/${name}`, 987654321), FIXED_NOW)).toEqual({});
      const topic = commandUpdate(2, 11, `/${name}`);
      topic.message = {
        ...topic.message!,
        chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        is_topic_message: true,
        message_thread_id: 9,
      };
      expect(ingestion.ingest(topic, FIXED_NOW)).toEqual({});
      expect(
        store.db
          .prepare<[], { rejection_reason: string }>('SELECT rejection_reason FROM telegram_updates ORDER BY update_id')
          .all(),
      ).toEqual([{ rejection_reason: 'chat_not_allowed' }, { rejection_reason: 'topic_not_allowed' }]);
    } finally {
      store.close();
    }
  });

  test('commands are audited but not stored and never create buckets', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/status'), FIXED_NOW);
    expect(result.command).toEqual({ name: 'status', messageId: 10n });
    expect(result.messageId).toBeUndefined();
    expect(result.bucketId).toBeUndefined();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    const audit = store.db
      .prepare<[], { allowed: bigint; rejection_reason: string | null }>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(1n);
    expect(audit?.rejection_reason).toBeNull();
    store.close();
  });

  test('catch-up returns only /pause and /resume and stores no command', async () => {
    const { store, ingestion } = await setup();
    expect(ingestion.ingestCatchUp(commandUpdate(1, 10, '/pause'), FIXED_NOW).command).toEqual({
      name: 'pause',
      messageId: 10n,
    });
    expect(ingestion.ingestCatchUp(commandUpdate(2, 11, '/resume'), FIXED_NOW).command).toEqual({
      name: 'resume',
      messageId: 11n,
    });
    // Recognized but not replayed: intercepted instead of falling through to
    // message storage, and reported as no command.
    expect(ingestion.ingestCatchUp(commandUpdate(3, 12, '/status'), FIXED_NOW)).toEqual({});
    expect(ingestion.ingestCatchUp(commandUpdate(4, 13, '/cut_topic'), FIXED_NOW)).toEqual({});
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    expect(
      store.db
        .prepare<[], { allowed: bigint; rejection_reason: string | null }>(
          'SELECT allowed, rejection_reason FROM telegram_updates ORDER BY update_id',
        )
        .all(),
    ).toEqual([
      { allowed: 1n, rejection_reason: null },
      { allowed: 1n, rejection_reason: null },
      { allowed: 1n, rejection_reason: null },
      { allowed: 1n, rejection_reason: null },
    ]);
    store.close();
  });

  test('catch-up does not let an admin /allowlist bypass the allowlist', async () => {
    const { store, ingestion } = await setup();
    expect(ingestion.ingestCatchUp(commandUpdate(1, 10, '/allowlist', 987654321), FIXED_NOW)).toEqual({});
    const audit = store.db
      .prepare<[], { allowed: bigint; rejection_reason: string }>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(0n);
    expect(audit?.rejection_reason).toBe('chat_not_allowed');
    store.close();
  });

  test('commands with a foreign mention fall through to normal storage', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/pause@OtherBot'), FIXED_NOW);
    expect(result.command).toBeUndefined();
    expect(result.messageId).toBeDefined();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('commands are not intercepted for disallowed chats', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/pause', 987654321), FIXED_NOW);
    const audit = store.db
      .prepare<[], { allowed: bigint; rejection_reason: string }>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(0n);
    expect(audit?.rejection_reason).toBe('chat_not_allowed');
    expect(result.command).toBeUndefined();
    store.close();
  });

  test('an admin /allowlist passes through for a disallowed chat and is audited as allowed', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/allowlist', 987654321), FIXED_NOW);
    expect(result.command).toEqual({ name: 'allowlist', messageId: 10n });
    expect(result.messageId).toBeUndefined();
    expect(result.bucketId).toBeUndefined();
    // The command is processed but never stored as a message or a bucket.
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    const audit = store.db
      .prepare<[], { allowed: bigint; rejection_reason: string | null }>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(1n);
    expect(audit?.rejection_reason).toBeNull();
    store.close();
  });

  test('a non-admin /allowlist stays rejected for a disallowed chat', async () => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.admins = [7];
    });
    const result = ingestion.ingest(commandUpdate(1, 10, '/allowlist', 987654321), FIXED_NOW);
    expect(result.command).toBeUndefined();
    const audit = store.db
      .prepare<[], { allowed: bigint; rejection_reason: string }>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(0n);
    expect(audit?.rejection_reason).toBe('chat_not_allowed');
    store.close();
  });
});
