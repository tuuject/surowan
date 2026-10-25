import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { adminPasskeys, adminSessions, adminUsers, hostSends, toolCalls } from '../../src/store/schema/index.ts';
import * as schema from '../../src/store/schema/index.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { cleanupSchemaDirectories, openStore, rollbackHostSendsRename } from './fixtures.ts';

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
    expect(first.next_cursor).toBe(seed.invocationB.toString());
    const second = listInvocations(orm, {
      limit: '25',
      cursor: first.next_cursor,
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
    expect(second.next_cursor).toBeNull();
    expect(listInvocations(orm, { chat: '-999' }).items).toEqual([]);
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
