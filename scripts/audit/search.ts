import type Database from 'better-sqlite3';
import { preview } from './support.ts';

export function runSearch(
  database: Database.Database,
  text: string,
  limit: number,
  since: string | null,
  json: boolean,
): string {
  const rows = database
    .prepare<
      [string, string, string, number],
      { invocation_id: number; conversation_id: number; sends_used: number; created_at: string; text: string }
    >(
      `SELECT m.invocation_id, i.conversation_id, i.sends_used, m.created_at, m.text
       FROM agent_messages m JOIN invocations i ON i.id = m.invocation_id
       WHERE m.role = 'assistant' AND m.text LIKE '%' || ? || '%'
         AND (? = '' OR m.created_at >= ?)
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(text, since ?? '', since ?? '', limit);
  if (json) {
    return JSON.stringify({ pattern: text, matches: rows }, null, 2);
  }
  const out: string[] = [`=== private assistant texts matching 「${text}」 (${rows.length}) ===`];
  const invocationIds = new Set(rows.map((row) => row.invocation_id));
  const silent = rows.filter((row) => row.sends_used === 0).length;
  for (const row of rows) {
    out.push(
      `invocation ${row.invocation_id} conversation ${row.conversation_id} sends=${row.sends_used} ${row.created_at}: ${preview(row.text, 200)}`,
    );
  }
  out.push('', `invocations matched: ${invocationIds.size}; matches inside send-less invocations: ${silent}`);
  return out.join('\n');
}
