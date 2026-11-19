import { afterAll, expect, test } from 'vitest';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { adminPasskeys, adminSessions, adminUsers, hostSends, toolCalls } from '../../src/store/schema/index.ts';
import * as schema from '../../src/store/schema/index.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { writeTestConfig } from '../helpers.ts';
import {
  buildDatabaseBelow,
  cleanupSchemaDirectories,
  makeSchemaDirectory,
  openStore,
  rollbackHostSendsRename,
} from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

test.each(['fresh', 'upgraded'])('invocation audit uses indexed calls in %s databases', async (mode) => {
  const fixture = await openStore();
  let store = fixture.store;
  try {
    const seed = seedAdminFixture(store);
    const auditBefore = {
      models: store.db.prepare('SELECT * FROM model_calls ORDER BY id').all(),
      tools: store.db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };
    if (mode === 'upgraded') {
      store.db.exec(`
        DROP INDEX IF EXISTS model_calls_invocation_idx;
        DROP INDEX IF EXISTS tool_calls_invocation_idx;
        DELETE FROM schema_migrations WHERE version = 23;
      `);
      store.close();
      store = await SqliteStore.open(fixture.loaded.config);
      store.close();
      store = await SqliteStore.open(fixture.loaded.config);
    }
    const plans: string[] = [];
    const orm = drizzle(store.db, {
      schema,
      logger: {
        logQuery(query, params) {
          const plan = store.db.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all(...params);
          plans.push(...plan.map((row) => row.detail));
        },
      },
    });
    const first = listInvocations(orm, { limit: '1' });
    expect(first.items).toMatchObject([
      { id: seed.invocationB.toString(), state: 'failed', tool_call_count: 1, total_tokens: 0, total_cost: null },
    ]);
    expect(first).toMatchObject({ total: 2, as_of: seed.invocationB.toString(), new_count: 0 });
    const second = listInvocations(orm, {
      limit: '25',
      offset: '0',
      as_of: first.as_of,
      chat: '123456789',
      state: 'completed',
    });
    expect(second.items).toMatchObject([
      {
        id: seed.invocationA.toString(),
        state: 'completed',
        tool_call_count: 2,
        total_tokens: 3930,
        cache_read_tokens: 1400,
        cache_write_tokens: 0,
      },
    ]);
    expect(second.items[0]?.total_cost).toBeCloseTo(0.0048);
    expect(second).toMatchObject({ total: 1, offset: 0 });
    expect(listInvocations(orm, { chat: '-999' }).items).toEqual([]);
    // The model filter must ride the same correlation index; a full scan of the
    // audit table on every list request is the regression this guards.
    const byModel = listInvocations(orm, { model: 'gpt-4.1-mini' });
    expect(byModel.items.map((item) => item.id)).toEqual([seed.invocationB.toString(), seed.invocationA.toString()]);
    expect(listInvocations(orm, { model: 'not-configured' }).items).toEqual([]);
    expect(plans.some((detail) => /SCAN (?:mc|tc)\b/.test(detail))).toBe(false);
    expect(plans.some((detail) => /SEARCH mc USING .*INDEX .*\(invocation_id=\?\)/.test(detail))).toBe(true);
    expect(plans.some((detail) => /SEARCH tc USING .*INDEX .*\(invocation_id=\?\)/.test(detail))).toBe(true);
    expect(store.db.prepare('SELECT * FROM model_calls ORDER BY id').all()).toEqual(auditBefore.models);
    expect(store.db.prepare('SELECT * FROM tool_calls ORDER BY id').all()).toEqual(auditBefore.tools);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    store.close();
  }
});

test.each(['fresh', 'upgraded'])(
  'reply delivery lookup preserves audit and uses its index in %s databases',
  async (mode) => {
    const fixture = await openStore();
    let store = fixture.store;
    try {
      const seed = seedAdminFixture(store);
      const now = new Date().toISOString();
      // Historical duplicates must not prevent an upgrade or rewrite past sends.
      for (const [index, state] of ['success', 'success', 'pending', 'outcome_unknown', 'error'].entries()) {
        const tool = store.orm
          .insert(toolCalls)
          .values({
            invocationId: seed.invocationA,
            toolCallId: `reply-index-${index}`,
            toolName: 'send',
            argumentsJson: '{}',
            state,
            sideEffect: true,
            createdAt: now,
          })
          .returning({ id: toolCalls.id })
          .get()!;
        store.orm
          .insert(hostSends)
          .values({
            toolCallId: tool.id,
            conversationId: seed.conversationId,
            kind: 'text',
            requestJson: JSON.stringify({ reply_to_message_id: '900' }),
            state,
            createdAt: now,
          })
          .run();
      }
      const before = store.orm.select().from(hostSends).all();
      if (mode === 'upgraded') {
        // 032 (admin passkeys) is already applied on this database with real
        // rows; rolling back only the reply index records must re-apply 033
        // without touching the passkeys schema or data.
        store.orm
          .insert(adminUsers)
          .values({
            id: 1n,
            username: 'schema-test-admin',
            passwordHash: null,
            webauthnUserId: 'schema-test-webauthn-user',
            createdAt: now,
            updatedAt: now,
            lastLoginAt: null,
          })
          .run();
        store.orm
          .insert(adminSessions)
          .values({
            id: 1n,
            userId: 1n,
            tokenHash: 'schema-test-token-hash',
            createdAt: now,
            expiresAt: now,
            lastSeenAt: now,
          })
          .run();
        store.orm
          .insert(adminPasskeys)
          .values({
            id: 1n,
            userId: 1n,
            credentialId: 'schema-test-credential-id',
            publicKey: 'schema-test-public-key',
            counter: 3n,
            rpId: 'localhost',
            name: 'schema test passkey',
            createdAt: now,
            lastUsedAt: now,
          })
          .run();
        const adminBefore = {
          users: store.orm.select().from(adminUsers).all(),
          sessions: store.orm.select().from(adminSessions).all(),
          passkeys: store.orm.select().from(adminPasskeys).all(),
        };
        // The reply index belongs to 038 now, so that is the migration this
        // replay puts back on top of a live database.
        rollbackHostSendsRename(store.db);
        store.close();
        store = await SqliteStore.open(fixture.loaded.config);
        store.close();
        store = await SqliteStore.open(fixture.loaded.config);
        expect(store.orm.select().from(adminUsers).all()).toEqual(adminBefore.users);
        expect(store.orm.select().from(adminSessions).all()).toEqual(adminBefore.sessions);
        expect(store.orm.select().from(adminPasskeys).all()).toEqual(adminBefore.passkeys);
        // The already-applied 033 row survives, and the rebased 038 records
        // exactly one row each for both versions.
        expect(store.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 33').get()).toEqual({
          n: 1n,
        });
        expect(store.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 38').get()).toEqual({
          n: 1n,
        });
      }
      const plans: string[] = [];
      const orm = drizzle(store.db, {
        schema,
        logger: {
          logQuery(query, params) {
            plans.push(
              ...store.db
                .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
                .all(...params)
                .map((row) => row.detail),
            );
          },
        },
      });
      const previous = orm
        .select({ state: hostSends.state })
        .from(hostSends)
        .where(sql`${hostSends.conversationId} = ${seed.conversationId}
        AND json_extract(${hostSends.requestJson}, '$.reply_to_message_id') = ${'900'}
        AND ${hostSends.state} IN ('success', 'pending', 'outcome_unknown')`)
        .orderBy(sql`${hostSends.state} = 'success'`)
        .limit(1)
        .get();
      expect(previous?.state).toBe('pending');
      expect(plans.some((detail) => detail.includes('USING INDEX host_sends_reply_delivery_idx'))).toBe(true);
      expect(store.orm.select().from(hostSends).all()).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
  },
);

test.each(['fresh', 'upgraded'])('per-conversation message reads use their indexes in %s databases', async (mode) => {
  // 'upgraded' replays 062 for real: the file still names the pre-064 columns,
  // so it runs on a database built at 063, seeded under the old names, with
  // the version row removed so the runner applies it before 064 renames the
  // columns it indexed.
  const upgraded =
    mode === 'upgraded'
      ? await (async () => {
          const directory = await makeSchemaDirectory();
          const configPath = join(directory, 'config.jsonc');
          await writeTestConfig(directory, configPath);
          const loaded = await loadConfig(configPath);
          const legacy = await buildDatabaseBelow(loaded, 64);
          legacy.exec(`
            INSERT INTO chats (id, host_kind, telegram_chat_id, canonical_chat_id, type, updated_at)
              VALUES (1, 'telegram', 123456789, 123456789, 'private', '2026-01-01T00:00:00.000Z');
            INSERT INTO senders (id, host_kind, telegram_type, telegram_id, display_name, is_bot, updated_at)
              VALUES (10, 'telegram', 'user', 42, 'Alice', 0, '2026-01-01T00:00:00.000Z'),
                     (11, 'telegram', 'user', 999, 'Surowan', 1, '2026-01-01T00:00:00.000Z');
            INSERT INTO conversations (id, chat_id, message_thread_id, created_at, updated_at)
              VALUES (100, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
            INSERT INTO buckets (id, conversation_id, state, first_received_at, deadline_at, created_at, updated_at)
              VALUES (3000, 100, 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:15.000Z'),
                     (3001, 100, 'collecting', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:15.000Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z');
            INSERT INTO messages (id, conversation_id, chat_id, host_kind, telegram_message_id, visible, sent_by_bot, telegram_date, received_at)
              VALUES (1000, 100, 1, 'telegram', 5000, 1, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
                     (1001, 100, 1, 'telegram', 5001, 1, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
                     (1002, 100, 1, 'telegram', 5002, 1, 1, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
                     (1003, 100, 1, 'telegram', 5003, 0, 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z'),
                     (1004, 100, 1, 'telegram', 5004, 1, 0, '2026-01-01T00:01:01.000Z', '2026-01-01T00:01:01.000Z'),
                     (1005, 100, 1, 'telegram', 5005, 1, 0, '2026-01-01T00:01:02.000Z', '2026-01-01T00:01:02.000Z');
            INSERT INTO message_revisions (id, message_id, revision_no, sender_id, kind, text, created_at, raw_fragment_json)
              VALUES (2000, 1000, 1, 10, 'text', 'one', '2026-01-01T00:00:01.000Z', '{}'),
                     (2001, 1001, 1, 10, 'text', 'two', '2026-01-01T00:00:02.000Z', '{}'),
                     (2002, 1002, 1, 11, 'text', 'three', '2026-01-01T00:00:03.000Z', '{}'),
                     (2003, 1003, 1, 10, 'text', 'four', '2026-01-01T00:00:04.000Z', '{}'),
                     (2004, 1004, 1, 10, 'text', 'five', '2026-01-01T00:01:01.000Z', '{}'),
                     (2005, 1005, 1, 10, 'text', 'six', '2026-01-01T00:01:02.000Z', '{}');
            UPDATE messages SET current_revision_id = CASE id
              WHEN 1000 THEN 2000 WHEN 1001 THEN 2001 WHEN 1002 THEN 2002
              WHEN 1003 THEN 2003 WHEN 1004 THEN 2004 WHEN 1005 THEN 2005 END;
            INSERT INTO bucket_messages (bucket_id, message_id, sequence_no)
              VALUES (3000, 1000, 1), (3000, 1001, 2), (3000, 1002, 3), (3001, 1004, 1);
          `);
          // Undo 062's effects and its record so the runner replays it.
          legacy.exec(`
            DROP INDEX messages_conversation_history_idx;
            DROP INDEX bucket_messages_message_idx;
            DELETE FROM schema_migrations WHERE version = 62;
          `);
          legacy.close();
          return { store: await SqliteStore.open(loaded.config), conversationId: 100n, bucketA: 3000n, bucketB: 3001n };
        })()
      : null;
  const fixture = upgraded === null ? await openStore() : null;
  const store = upgraded?.store ?? fixture?.store;
  if (store === undefined || store === null) {
    throw new Error('no store');
  }
  try {
    const seed =
      upgraded === null
        ? seedAdminFixture(store)
        : { conversationId: upgraded.conversationId, bucketA: upgraded.bucketA, bucketB: upgraded.bucketB };
    const explain = (query: string, ...params: (bigint | number | string)[]) =>
      store.db
        .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
        .all(...params)
        .map((row) => row.detail);

    // The snapshot's history window reads one conversation newest-first on
    // every invocation; it must ride (conversation_id, sent_at,
    // message_no) instead of scanning and re-sorting messages.
    const history = explain(
      `SELECT m.id
         FROM messages m
         JOIN conversations v ON v.id = m.conversation_id
         JOIN message_revisions r ON r.id = m.current_revision_id
         LEFT JOIN senders s ON s.id = r.sender_id
         WHERE m.conversation_id = ? AND m.visible = 1
           AND m.message_no > COALESCE(
             (SELECT message_no FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
           AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.bucket_id = ? AND bm.message_id = m.id)
           AND m.id NOT IN (
             SELECT pending.message_id FROM bucket_messages pending
             JOIN buckets pb ON pb.id = pending.bucket_id
             WHERE pb.conversation_id = ? AND pb.state = 'collecting')
         ORDER BY m.sent_at DESC, m.message_no DESC
         LIMIT ?`,
      seed.conversationId,
      seed.bucketA,
      seed.conversationId,
      30n,
    );
    expect(history.some((detail) => /SCAN m\b/.test(detail))).toBe(false);
    expect(
      history.some((detail) => /SEARCH m USING (COVERING )?INDEX messages_conversation_history_idx/.test(detail)),
    ).toBe(true);
    expect(history.some((detail) => detail.includes('USE TEMP B-TREE'))).toBe(false);

    // Adopting pending bot messages filters the same history shape inside
    // the ingestion transaction and probes bucket_messages by message_id.
    const pending = explain(
      `SELECT m.id
         FROM messages m
         JOIN message_revisions r ON r.id = m.current_revision_id
         JOIN senders s ON s.id = r.sender_id
         WHERE m.conversation_id = ? AND m.visible = 1 AND m.sent_by_bot = 0 AND s.is_bot = 1
           AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = m.id)
           AND m.received_at >= COALESCE(
             (SELECT MAX(first_received_at) FROM buckets WHERE conversation_id = ? AND id <> ?), '')
           AND m.message_no > COALESCE(
             (SELECT message_no FROM conversation_context_cutoffs WHERE conversation_id = m.conversation_id), -1)
         ORDER BY m.sent_at DESC, m.message_no DESC
         LIMIT ?`,
      seed.conversationId,
      seed.conversationId,
      seed.bucketB,
      30n,
    );
    expect(pending.some((detail) => /SCAN m\b/.test(detail))).toBe(false);
    expect(
      pending.some((detail) => /SEARCH m USING (COVERING )?INDEX messages_conversation_history_idx/.test(detail)),
    ).toBe(true);
    expect(pending.some((detail) => /SCAN bm\b/.test(detail))).toBe(false);
    expect(pending.some((detail) => /SEARCH bm USING (COVERING )?INDEX bucket_messages_message_idx/.test(detail))).toBe(
      true,
    );
    expect(pending.some((detail) => detail.includes('USE TEMP B-TREE'))).toBe(false);

    // The (bucket_id, message_id) primary key cannot answer a bare
    // message_id probe; bucket_messages grows with the message history.
    const lookup = explain('SELECT 1 FROM bucket_messages bm WHERE bm.message_id = ?', 1n);
    expect(lookup.some((detail) => /SCAN bm\b/.test(detail))).toBe(false);
    expect(lookup.some((detail) => /SEARCH bm USING (COVERING )?INDEX bucket_messages_message_idx/.test(detail))).toBe(
      true,
    );
  } finally {
    store.close();
  }
});
