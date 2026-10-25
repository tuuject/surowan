import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { longTasks, taskReceipts } from '../../src/store/schema/index.ts';
import { createPre020Db, loadMigrationFile, run020, seedBucketAndInvocation, seedChat } from './migration-fixtures.ts';

describe('migration 020', () => {
  test('creates long_tasks and task_receipts tables', async () => {
    const { db } = await createPre020Db();
    await run020(db);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('long_tasks', 'task_receipts', 'alarms')",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('long_tasks');
    expect(tables).toContain('task_receipts');
    expect(tables).not.toContain('alarms');

    db.close();
  });

  test('keeps Drizzle checks and partial indexes aligned with migrated SQLite', async () => {
    const { db } = await createPre020Db();
    try {
      await run020(db);
      db.exec(await loadMigrationFile(22));
      const dialect = new SQLiteSyncDialect();
      const normalize = (text: string): string => text.replace(/["\s]/g, '').toLowerCase();
      for (const table of [longTasks, taskReceipts]) {
        const definition = getTableConfig(table);
        const ddl = db
          .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(definition.name)!.sql;
        expect(definition.checks).toHaveLength(ddl.match(/\bCHECK\s*\(/gi)?.length ?? 0);
        for (const constraint of definition.checks) {
          expect(normalize(ddl)).toContain(normalize(`CHECK (${dialect.sqlToQuery(constraint.value).sql})`));
        }
        const actualIndexes = db
          .prepare<[string], { sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
          )
          .all(definition.name);
        expect(actualIndexes).toHaveLength(definition.indexes.length);
        for (const { config } of definition.indexes) {
          const columns = config.columns.map((column) => {
            if (!('name' in column)) {
              throw new Error('Task indexes must use named columns');
            }
            return column.name;
          });
          const predicate = config.where ? ` WHERE ${dialect.sqlToQuery(config.where).sql}` : '';
          const expected = `CREATE ${config.unique ? 'UNIQUE ' : ''}INDEX ${config.name} ON ${definition.name}(${columns.join(', ')})${predicate}`;
          expect(actualIndexes.map((index) => normalize(index.sql))).toContain(normalize(expected));
        }
      }
    } finally {
      db.close();
    }
  });

  test('migrates pending alarms to waiting timer tasks', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id)
      VALUES (10, 1, 999999, 'TargetUser', 'wake up',
        '${future}', '2025-06-01T00:00:00.000Z', 'pending',
        '2025-06-01T00:00:00.000Z', 42)
    `).run();

    await run020(db);

    const task = db
      .prepare<
        [],
        {
          id: bigint;
          plugin_id: string;
          state: string;
          scheduled_at: string;
          delivery_json: string;
          payload_json: string;
          created_by_user_id: bigint;
        }
      >('SELECT * FROM long_tasks WHERE id = 10')
      .get();
    expect(task).toBeDefined();
    expect(task!.id).toBe(10n);
    expect(task!.plugin_id).toBe('alarm');
    expect(task!.state).toBe('waiting');
    expect(task!.scheduled_at).toBe(future);
    expect(task!.created_by_user_id).toBe(42n);

    const delivery = JSON.parse(task!.delivery_json);
    expect(delivery.bypassDailyBudget).toBe(true);
    expect(delivery.mentionUser.userId).toBe('999999');
    expect(delivery.mentionUser.displayName).toBe('TargetUser');

    const payload = JSON.parse(task!.payload_json);
    expect(payload.target_user_id).toBe('999999');
    expect(payload.target_display_name).toBe('TargetUser');
    expect(payload.summary).toBe('wake up');

    db.close();
  });

  test('migrates firing alarms to completed + claimed receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, fired_at, invocation_id, invocation_outcome, updated_at)
      VALUES (11, 1, 888888, 'FiredUser', 'reminder',
        '${past}', '2025-06-01T00:00:00.000Z', 'firing',
        '2025-06-02T00:00:00.000Z', 1, 'completed', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const task = db.prepare<[], { state: string }>('SELECT state FROM long_tasks WHERE id = 11').get();
    expect(task!.state).toBe('completed');

    const receipt = db
      .prepare<
        [],
        {
          status: string;
          state: string;
          invocation_id: bigint;
          invocation_outcome: string;
        }
      >('SELECT status, state, invocation_id, invocation_outcome FROM task_receipts WHERE task_id = 11')
      .get();
    expect(receipt!.status).toBe('completed');
    expect(receipt!.state).toBe('claimed');
    expect(receipt!.invocation_id).toBe(1n);
    expect(receipt!.invocation_outcome).toBe('completed');

    db.close();
  });

  test('migrates fired alarms to completed + handled receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, fired_at, invocation_id, invocation_outcome, updated_at)
      VALUES (12, 1, 777777, 'DoneUser', 'done',
        '${past}', '2025-06-01T00:00:00.000Z', 'fired',
        '2025-06-02T00:00:00.000Z', 1, 'completed', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const receipt = db.prepare<[], { state: string }>('SELECT state FROM task_receipts WHERE task_id = 12').get();
    expect(receipt!.state).toBe('handled');

    db.close();
  });

  test('migrates cancelled alarms to cancelled + suppressed receipt', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, cancelled_at, cancelled_by, cancel_reason, updated_at)
      VALUES (13, 1, 666666, 'CancelledUser', 'nope',
        '${future}', '2025-06-01T00:00:00.000Z', 'cancelled',
        '2025-06-02T00:00:00.000Z', 'user', 'changed mind', '2025-06-02T00:00:00.000Z')
    `).run();

    await run020(db);

    const task = db.prepare<[], { state: string }>('SELECT state FROM long_tasks WHERE id = 13').get();
    expect(task!.state).toBe('cancelled');

    const receipt = db
      .prepare<[], { status: string; state: string }>('SELECT status, state FROM task_receipts WHERE task_id = 13')
      .get();
    expect(receipt!.status).toBe('cancelled');
    expect(receipt!.state).toBe('suppressed');

    db.close();
  });

  test('020 ignores alarm_list rows in internal_contexts (valid, empty, invalid) — 021 drops them all later', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    const observedAt = '2025-07-01T00:00:00.000Z';
    // Valid alarm_list payload
    const validPayload = JSON.stringify({
      kind: 'alarm_list',
      version: 1,
      observed_at: observedAt,
      items: [{ id: '100', scheduled_at: '2025-08-01T00:00:00.000Z', summary: 'valid' }],
    });
    // Empty alarm_list payload
    const emptyPayload = JSON.stringify({ kind: 'alarm_list', version: 1, observed_at: observedAt, items: [] });
    // Invalid alarm_list payload (null item id)
    const invalidPayload =
      '{"kind":"alarm_list","version":1,"observed_at":"2025-07-01T00:00:00.000Z","items":[{"id":null,"scheduled_at":"2025-08-01T00:00:00.000Z","summary":"ok"}]}';
    const insert = db.prepare(`
      INSERT INTO internal_contexts(id, conversation_id, invocation_id, kind, version, observed_at, payload_json, created_at)
      VALUES (?, 1, 1, 'alarm_list', 1, ?, ?, '2025-07-01T00:00:00.000Z')
    `);
    insert.run(1n, observedAt, validPayload);
    insert.run(2n, observedAt, emptyPayload);
    insert.run(3n, observedAt, invalidPayload);

    // 020 no longer validates or converts alarm_list — all rows survive 020 unchanged
    await run020(db);

    const rows = db
      .prepare<[], { id: bigint; kind: string; payload_json: string }>(
        'SELECT id, kind, payload_json FROM internal_contexts ORDER BY id',
      )
      .all();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.kind).toBe('alarm_list');
    expect(rows[1]!.kind).toBe('alarm_list');
    expect(rows[2]!.kind).toBe('alarm_list');
    expect(rows.map((row) => row.payload_json)).toEqual([validPayload, emptyPayload, invalidPayload]);
    db.exec(await loadMigrationFile(21));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'internal_contexts'").all()).toEqual([]);

    db.close();
  });

  test('preserves alarm IDs as bigint (no precision loss)', async () => {
    const { db } = await createPre020Db();
    seedChat(db);

    const largeId = 0x7fffffff_ffff0000n;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
        scheduled_at, created_at, state, updated_at, created_by_user_id)
      VALUES (${largeId.toString()}, 1, ${largeId.toString()}, 'BigUser', 'large',
        '${future}', '2025-06-01T00:00:00.000Z', 'pending',
        '2025-06-01T00:00:00.000Z', ${largeId.toString()})
    `).run();

    await run020(db);

    const task = db
      .prepare<[bigint], { id: bigint; created_by_user_id: bigint; payload_json: string }>(
        'SELECT id, created_by_user_id, payload_json FROM long_tasks WHERE id = ?',
      )
      .get(largeId);
    expect(task!.id).toBe(largeId);
    expect(task!.created_by_user_id).toBe(largeId);
    const payload = JSON.parse(task!.payload_json);
    expect(payload.target_user_id).toBe(largeId.toString());

    db.close();
  });

  test('preserves tool_calls and telegram_sends without rebuilding either table', async () => {
    const { db } = await createPre020Db();
    seedChat(db);
    seedBucketAndInvocation(db);

    db.prepare(`
      INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at)
      VALUES (1, 1, 'tc-1', 'alarm', '{}', 'success', 1, '2025-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, created_at)
      VALUES (1, 1, 1, 'text', '{}', 'success', '2025-01-01T00:00:00.000Z')
    `).run();
    const beforeSql = db
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'tool_calls'")
      .get()!.sql;

    await run020(db);

    expect(db.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'tool_calls'").get()!.sql).toBe(
      beforeSql,
    );
    expect(
      db.prepare<[], { tool_call_id: string }>('SELECT tool_call_id FROM tool_calls WHERE id = 1').get()!.tool_call_id,
    ).toBe('tc-1');
    expect(
      db.prepare<[], { tool_call_id: bigint }>('SELECT tool_call_id FROM telegram_sends WHERE id = 1').get()!
        .tool_call_id,
    ).toBe(1n);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    db.close();
  });

  test('preserves cancelled alarm claim audit and nullable owners', async () => {
    const { db } = await createPre020Db();
    try {
      seedChat(db);
      seedBucketAndInvocation(db);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      db.prepare(`
        INSERT INTO alarms(id, conversation_id, target_user_id, target_display_name, summary,
          scheduled_at, created_at, state, fired_at, cancelled_at, updated_at, created_by_user_id,
          invocation_id, admin_cancelled, cancelled_by, cancel_reason)
        VALUES (14, 1, 555, 'Cancelled', 'claimed then cancelled', ?,
          '2025-06-01T00:00:00.000Z', 'cancelled', '2025-06-01T01:00:00.000Z',
          '2025-06-01T02:00:00.000Z', '2025-06-01T02:00:00.000Z', NULL,
          1, 1, 'owner', 'admin_cancel')
      `).run(future);

      await run020(db);

      const task = db
        .prepare<[], { created_by_user_id: bigint | null }>('SELECT created_by_user_id FROM long_tasks WHERE id = 14')
        .get();
      const receipt = db.prepare('SELECT * FROM task_receipts WHERE task_id = 14').get();
      expect(task!.created_by_user_id).toBeNull();
      expect(receipt).toMatchObject({
        status: 'cancelled',
        state: 'suppressed',
        invocation_id: 1n,
        claimed_at: '2025-06-01T01:00:00.000Z',
        cancelled_at: '2025-06-01T02:00:00.000Z',
        cancelled_by: 'owner',
        admin_cancelled: 1n,
        cancel_reason: 'admin_cancel',
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
