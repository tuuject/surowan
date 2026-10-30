import type Database from 'better-sqlite3';
import { preview } from './support.ts';

interface ConversationRow {
  readonly id: number;
  readonly chat_id: number;
  readonly message_thread_id: number;
  readonly telegram_chat_id: number;
  readonly chat_title: string | null;
  readonly chat_type: string;
}

interface ConversationInvocationRow {
  readonly id: number;
  readonly state: string;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly completion_reason: string | null;
  readonly prompt_version: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly nudges: number;
  readonly private_texts: number;
}

interface ConversationSendRow {
  readonly id: number;
  readonly kind: string;
  readonly state: string;
  readonly telegram_message_id: number | null;
  readonly created_at: string;
  readonly request_json: string;
}

interface ContextRow {
  readonly head_seq: number;
  readonly next_seq: number;
  readonly system_prompt_hash: string;
  readonly updated_at: string;
  readonly total: number;
  readonly live: number;
  readonly checkpoints: number;
}

interface AttentionRow {
  readonly expires_at: string;
  readonly trigger_kind: string;
  readonly triggered_at: string;
}

export function renderConversation(database: Database.Database, id: number, limit: number, json: boolean): string {
  const conversation = database
    .prepare<[number], ConversationRow>(
      `SELECT v.id, v.chat_id, v.message_thread_id, c.telegram_chat_id, c.title AS chat_title, c.type AS chat_type
       FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ?`,
    )
    .get(id);
  if (conversation === undefined) {
    throw new Error(`Conversation ${id} does not exist`);
  }
  const invocations = database
    .prepare<[number, number], ConversationInvocationRow>(
      `SELECT i.id, i.state, i.sends_used, i.tool_calls_used, i.turns_used, i.completion_reason,
              i.prompt_version, i.started_at, i.finished_at,
              (SELECT count(*) FROM agent_messages m WHERE m.invocation_id = i.id AND m.role = 'harness_nudge') AS nudges,
              (SELECT count(*) FROM agent_messages m WHERE m.invocation_id = i.id AND m.role = 'assistant') AS private_texts
       FROM invocations i WHERE i.conversation_id = ? ORDER BY i.id DESC LIMIT ?`,
    )
    .all(id, limit);
  const sends = database
    .prepare<[number, number], ConversationSendRow>(
      `SELECT id, kind, state, telegram_message_id, created_at, substr(request_json, 1, 160) AS request_json
       FROM host_sends WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(id, limit);
  const privateTexts = database
    .prepare<[number, number], { invocation_id: number; text: string }>(
      `SELECT m.invocation_id, m.text
       FROM agent_messages m JOIN invocations i ON i.id = m.invocation_id
       WHERE i.conversation_id = ? AND m.role = 'assistant'
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(id, limit);
  const context = database
    .prepare<[number], ContextRow>(
      `SELECT head_seq, next_seq, system_prompt_hash, updated_at,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id) AS total,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id AND c.evicted_at IS NULL) AS live,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id AND c.is_checkpoint = 1) AS checkpoints
       FROM conversation_contexts cc WHERE cc.conversation_id = ?`,
    )
    .get(id);
  const attention = database
    .prepare<[number], AttentionRow>(
      `SELECT expires_at, trigger_kind, triggered_at FROM conversation_attention WHERE conversation_id = ?`,
    )
    .get(id);
  const memos = database
    .prepare<[number], { count: number }>(`SELECT count(*) AS count FROM memo_pad_entries WHERE chat_id = ?`)
    .get(conversation.chat_id);
  const gate =
    attention === undefined
      ? 'no attention window recorded'
      : `attention window until ${attention.expires_at} (${attention.trigger_kind} at ${attention.triggered_at})`;

  if (json) {
    return JSON.stringify(
      {
        conversation,
        invocations,
        sends,
        privateTexts,
        context: context ?? null,
        attention: attention ?? null,
        memoCount: memos?.count ?? 0,
      },
      null,
      2,
    );
  }

  const out: string[] = [];
  const section = (title: string): void => {
    out.push('', `=== ${title} ===`);
  };
  section('Conversation');
  out.push(
    `id=${conversation.id} chat=${conversation.telegram_chat_id} (${conversation.chat_title ?? '-'}, ${conversation.chat_type}) thread=${conversation.message_thread_id}`,
    `memos=${memos?.count ?? 0}`,
    `participation: ${gate}`,
  );
  if (context !== undefined) {
    section('Context');
    out.push(
      `head_seq=${context.head_seq} next_seq=${context.next_seq} live=${context.live}/${context.total} checkpoints=${context.checkpoints} prompt_hash=${context.system_prompt_hash.slice(0, 12)} updated=${context.updated_at}`,
    );
  }
  section(`Recent invocations (${invocations.length})`);
  out.push('id  state      sends tools turns nudges texts  completion      prompt_v  started');
  for (const row of invocations) {
    out.push(
      `${String(row.id).padEnd(3)} ${row.state.padEnd(10)} ${String(row.sends_used).padEnd(5)} ${String(row.tool_calls_used).padEnd(5)} ${String(row.turns_used).padEnd(5)} ${String(row.nudges).padEnd(6)} ${String(row.private_texts).padEnd(6)} ${(row.completion_reason ?? '-').padEnd(15)} ${String(row.prompt_version).padEnd(9)} ${row.started_at ?? '-'}`,
    );
  }
  section(`Recent sends (${sends.length})`);
  for (const send of sends) {
    out.push(
      `#${send.id} ${send.kind} ${send.state} telegram_message_id=${send.telegram_message_id ?? '-'} ${send.created_at}`,
    );
  }
  section(`Recent private assistant texts (${privateTexts.length})`);
  for (const row of privateTexts) {
    out.push(`invocation ${row.invocation_id}: ${preview(row.text, 200)}`);
  }
  return out.join('\n');
}
