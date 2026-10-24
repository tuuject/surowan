import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { writeTestConfig } from './helpers.ts';

export const directories: string[] = [];

afterEach(async () => {
  for (const d of directories) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      // ignore EBUSY on Windows
    }
  }
  directories.length = 0;
});

export async function loadMigrationFile(version: number): Promise<string> {
  const name = String(version).padStart(3, '0');
  const dirPath = join(import.meta.dirname, '..', 'src', 'store', 'migrations');
  const files = await (await import('node:fs/promises')).readdir(dirPath);
  const file = files.find((f) => f.startsWith(name));
  if (!file) {
    throw new Error(`Migration ${version} not found`);
  }
  return readFile(join(dirPath, file), 'utf8');
}

/** Create a database with migrations 001-019 applied. */
export async function createPre020Db(): Promise<{
  db: Database.Database;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mig-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const { config } = await loadConfig(configPath);
  const dbPath = config.paths.database;

  await (await import('node:fs/promises')).mkdir(dirname(dbPath), {
    recursive: true,
  });

  const db = new Database(dbPath);
  db.defaultSafeIntegers(true);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  for (let v = 1; v <= 19; v += 1) {
    const sql = await loadMigrationFile(v);
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        BigInt(v),
        new Date().toISOString(),
      );
    }).immediate();
  }

  return { db, directory };
}

/** Helper: insert minimal chat + conversation rows for FK satisfaction. */
export function seedChat(db: Database.Database): void {
  db.prepare(
    `INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at)
     VALUES (1, 123, 123, 'private', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
     VALUES (1, 1, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
}

export function seedBucketAndInvocation(db: Database.Database): void {
  db.prepare(
    `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
     VALUES (1, 1, 'completed', 'realtime', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
     VALUES (1, 1, 1, 'completed', 'h', 1, '2025-01-01T00:00:00.000Z')`,
  ).run();
}

export async function run020(db: Database.Database): Promise<void> {
  const sql020 = await loadMigrationFile(20);
  db.transaction(() => {
    db.exec(sql020);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(20n, new Date().toISOString());
  }).immediate();
}

/** Seed canonical history and audit data independently of the obsolete sidecar. */
export function seedCanonicalData(db: Database.Database): void {
  seedChat(db);
  seedBucketAndInvocation(db);
  db.prepare(`
    INSERT INTO conversation_contexts(id, conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, created_at, updated_at)
    VALUES (1, 1, 4, 5, 2, 'hash-abc', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, est_tokens, created_at)
    VALUES (1, 4, 'user', '{"role":"user","content":"hello","timestamp":1735689600000}', 1, 1, 10, '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO context_refs(context_id, ref, kind, source_seq, target_conversation_id, target_thread_id, expires_at, created_at)
    VALUES (1, 'reply:10', 'reply', 4, 1, 0, '2099-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO agent_messages(id, invocation_id, sequence_no, role, text, thinking_text, created_at)
    VALUES (300, 1, 1, 'tool_result', 'ordinary audit', '', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at)
    VALUES (400, 1, 'tc-real', 'send', '{}', 'success', 1, '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO telegram_sends(id, tool_call_id, conversation_id, kind, request_json, state, created_at)
    VALUES (401, 400, 1, 'text', '{}', 'success', '2025-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO internal_contexts(id, conversation_id, invocation_id, source_agent_message_id, kind, version, observed_at, payload_json, created_at)
    VALUES (600, 1, 1, 300, 'alarm_list', 1, '2025-07-01T00:00:00.000Z', 'invalid legacy payload', '2025-07-01T00:00:00.000Z')
  `).run();
}

/**
 * The ledger keeps its rows across 038 and only changes name, so a snapshot
 * taken before it and one taken after it are comparable when they read the
 * same columns from whichever name is present.
 */
function ledgerTable(db: Database.Database): string {
  const row = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('host_sends', 'telegram_sends')",
    )
    .get();
  if (row === undefined) {
    throw new Error('neither host_sends nor telegram_sends exists');
  }
  return row.name;
}

export function canonicalSnapshot(db: Database.Database) {
  const ledger = ledgerTable(db);
  return {
    headers: db.prepare('SELECT * FROM conversation_contexts ORDER BY id').all(),
    messages: db.prepare('SELECT * FROM context_messages ORDER BY context_id, seq').all(),
    refs: db.prepare('SELECT * FROM context_refs ORDER BY context_id, ref').all(),
    agentMessages: db.prepare('SELECT * FROM agent_messages ORDER BY id').all(),
    toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    sends: db
      .prepare(
        `SELECT id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id,
                response_json, error_code, created_at, finished_at
           FROM ${ledger} ORDER BY id`,
      )
      .all(),
  };
}
