import type Database from 'better-sqlite3';
import { AGENT_PROMPT_VERSION } from '../../src/platform/agent-protocol.ts';
import { field, parseSnapshot, preview } from './support.ts';

interface InvocationRow {
  readonly id: number;
  readonly state: string;
  readonly config_hash: string;
  readonly prompt_version: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly bucket_id: number;
  readonly bucket_kind: string;
  readonly bucket_state: string;
  readonly first_received_at: string;
  readonly deadline_at: string;
  readonly conversation_id: number;
  readonly message_thread_id: number;
  readonly telegram_chat_id: number;
  readonly chat_title: string | null;
  readonly chat_type: string;
}

interface InvocationMessageRow {
  readonly sequence_no: number;
  readonly section: string;
  readonly source_bucket_id: number | null;
  readonly snapshot_json: string;
}

interface ModelCallRow {
  readonly id: number;
  readonly state: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly request_messages: number | null;
  readonly request_tools: number | null;
}

interface ToolCallRow {
  readonly id: number;
  readonly tool_name: string;
  readonly state: string;
  readonly side_effect: number;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly arguments_json: string;
  readonly result_text: string | null;
}

interface SendRow {
  readonly id: number;
  readonly kind: string;
  readonly state: string;
  readonly telegram_message_id: number | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly request_json: string;
}

interface AgentMessageRow {
  readonly id: number;
  readonly sequence_no: number;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

function loadInvocation(database: Database.Database, id: number): InvocationRow {
  const row = database
    .prepare<[number], InvocationRow>(
      `SELECT i.id, i.state, i.config_hash, i.prompt_version, i.started_at, i.finished_at,
              i.completion_reason, i.error_code, i.sends_used, i.tool_calls_used, i.turns_used,
              i.bucket_id, b.kind AS bucket_kind, b.state AS bucket_state, b.first_received_at, b.deadline_at,
              i.conversation_id, v.message_thread_id, c.telegram_chat_id, c.title AS chat_title, c.type AS chat_type
       FROM invocations i
       JOIN buckets b ON b.id = i.bucket_id
       JOIN conversations v ON v.id = i.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE i.id = ?`,
    )
    .get(id);
  if (row === undefined) {
    throw new Error(`Invocation ${id} does not exist`);
  }
  return row;
}

function loadModelCalls(database: Database.Database, id: number): ModelCallRow[] {
  return database
    .prepare<[number], ModelCallRow>(
      `SELECT id, state, provider, model, attempt, input_tokens, output_tokens, cache_read_tokens,
              duration_ms, error_code, substr(error_detail, 1, 300) AS error_detail, created_at, finished_at,
              CASE WHEN request_json IS NULL THEN NULL
                   ELSE json_array_length(json_extract(request_json, '$.messages')) END AS request_messages,
              CASE WHEN request_json IS NULL THEN NULL
                   ELSE json_array_length(json_extract(request_json, '$.tools')) END AS request_tools
       FROM model_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
}

function loadToolCalls(database: Database.Database, id: number): ToolCallRow[] {
  return database
    .prepare<[number], ToolCallRow>(
      `SELECT id, tool_name, state, side_effect, error_code, duration_ms,
              substr(arguments_json, 1, 300) AS arguments_json, substr(result_text, 1, 300) AS result_text
       FROM tool_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
}

function loadSends(database: Database.Database, id: number): SendRow[] {
  return database
    .prepare<[number], SendRow>(
      `SELECT s.id, s.kind, s.state, s.telegram_message_id, s.error_code, s.created_at,
              substr(s.request_json, 1, 300) AS request_json
       FROM host_sends s JOIN tool_calls t ON t.id = s.tool_call_id
       WHERE t.invocation_id = ? ORDER BY s.id`,
    )
    .all(id);
}

function loadAgentMessages(database: Database.Database, id: number): AgentMessageRow[] {
  return database
    .prepare<[number], AgentMessageRow>(
      `SELECT id, sequence_no, role, text, created_at
       FROM agent_messages WHERE invocation_id = ? ORDER BY sequence_no`,
    )
    .all(id);
}

function loadBatch(database: Database.Database, id: number): InvocationMessageRow[] {
  return database
    .prepare<[number], InvocationMessageRow>(
      `SELECT sequence_no, section, source_bucket_id, snapshot_json
       FROM invocation_messages WHERE invocation_id = ? ORDER BY sequence_no`,
    )
    .all(id);
}

/** The batch messages that were allowed to create the current task. */
function newestMessages(batch: readonly InvocationMessageRow[]): {
  readonly messageId: string;
  readonly sender: string;
  readonly text: string;
  readonly fromBot: boolean;
  readonly media: number;
}[] {
  const out: {
    messageId: string;
    sender: string;
    text: string;
    fromBot: boolean;
    media: number;
  }[] = [];
  for (const row of batch) {
    if (row.section !== 'new') {
      continue;
    }
    const snapshot = parseSnapshot(row.snapshot_json);
    if (snapshot === null) {
      continue;
    }
    const username = field(snapshot.sender?.username);
    out.push({
      messageId: field(snapshot.message_id),
      sender: field(snapshot.sender?.name) || username || 'unknown',
      text: preview(field(snapshot.text) || field(snapshot.caption), 120),
      fromBot: username.toLowerCase().endsWith('bot'),
      media: Array.isArray(snapshot.media) ? snapshot.media.length : 0,
    });
  }
  return out;
}

/**
 * The verdict is deliberately mechanical: it only states what the audit rows
 * prove. Judging whether the silence was *right* is the reader's job.
 */
function verdict(input: {
  readonly invocation: InvocationRow;
  readonly sends: readonly SendRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly messages: readonly AgentMessageRow[];
  readonly newest: readonly {
    readonly messageId: string;
    readonly sender: string;
    readonly text: string;
    readonly fromBot: boolean;
  }[];
}): string[] {
  const lines: string[] = [];
  const succeeded = input.sends.filter((send) => send.state === 'success');
  const assistantTexts = input.messages.filter(
    (message) => message.role === 'assistant' && message.text.trim().length > 0,
  );
  const nudges = input.messages.filter((message) => message.role === 'harness_nudge');

  if (succeeded.length > 0) {
    lines.push(`已产生 ${succeeded.length} 次成功的 Telegram 发送`);
  } else if (input.sends.length > 0) {
    lines.push(
      `有 ${input.sends.length} 次 send 调用但没有成功（${input.sends.map((send) => send.state).join(', ')}）`,
    );
  } else if (nudges.length > 0) {
    lines.push(`harness 提醒过 ${nudges.length} 次（harness_nudge）但仍未调用 send：模型自己选择不发言`);
  } else if (assistantTexts.length > 0) {
    lines.push(
      '模型产生了私有文本但未调用 send，且没有 harness_nudge 记录：检查 agent.send_nudge_enabled 与提醒判定条件',
    );
  } else {
    lines.push('模型没有任何输出：既没有私有文本，也没有 Tool Call');
  }
  if (input.toolCalls.length === 0 && input.sends.length === 0) {
    lines.push('本 Invocation 没有任何 Tool Call');
  }
  if (input.invocation.completion_reason !== null && input.invocation.completion_reason !== 'completed') {
    lines.push(`结束原因不是 completed，而是 ${input.invocation.completion_reason}`);
  }
  if (input.invocation.state !== 'completed') {
    lines.push(`Invocation state = ${input.invocation.state}`);
  }
  if (input.invocation.prompt_version !== Number(AGENT_PROMPT_VERSION)) {
    lines.push(
      `该 Invocation 用的是 prompt_version ${input.invocation.prompt_version}，当前代码是 ${AGENT_PROMPT_VERSION.toString()}：当时的系统提示词与现在不同`,
    );
  }
  if (input.newest.length === 0) {
    lines.push('本批没有任何 new 段消息（只有 history）');
  } else {
    const botAuthored = input.newest.filter((message) => message.fromBot).length;
    lines.push(
      `本批 new 消息 ${input.newest.length} 条，最新一条来自「${input.newest.at(-1)?.sender ?? 'unknown'}」：${input.newest.at(-1)?.text ?? ''}`,
    );
    if (botAuthored > 0) {
      lines.push(`其中 ${botAuthored} 条来自 Bot（Core Protocol 的 bot-to-bot 规则适用）`);
    }
  }
  return lines;
}

export function renderInvocation(database: Database.Database, id: number, json: boolean): string {
  const invocation = loadInvocation(database, id);
  const modelCalls = loadModelCalls(database, id);
  const toolCalls = loadToolCalls(database, id);
  const sends = loadSends(database, id);
  const messages = loadAgentMessages(database, id);
  const batch = loadBatch(database, id);
  const newest = newestMessages(batch);
  const lines = verdict({ invocation, sends, toolCalls, messages, newest });

  if (json) {
    return JSON.stringify(
      { invocation, modelCalls, toolCalls, sends, messages, batch: newest, verdict: lines },
      null,
      2,
    );
  }

  const out: string[] = [];
  const section = (title: string): void => {
    out.push('', `=== ${title} ===`);
  };
  section('Invocation');
  out.push(
    `id=${invocation.id} state=${invocation.state} completion=${invocation.completion_reason ?? '-'} error=${invocation.error_code ?? '-'}`,
    `chat=${invocation.telegram_chat_id} (${invocation.chat_title ?? '-'}, ${invocation.chat_type}) conversation=${invocation.conversation_id} thread=${invocation.message_thread_id}`,
    `bucket=${invocation.bucket_id} kind=${invocation.bucket_kind} state=${invocation.bucket_state} received=${invocation.first_received_at} deadline=${invocation.deadline_at}`,
    `started=${invocation.started_at ?? '-'} finished=${invocation.finished_at ?? '-'}`,
    `prompt_version=${invocation.prompt_version} (current=${AGENT_PROMPT_VERSION.toString()}) config_hash=${invocation.config_hash.slice(0, 12)}`,
    `sends=${invocation.sends_used} tool_calls=${invocation.tool_calls_used} turns=${invocation.turns_used}`,
  );
  section(`本批 new 消息 (${newest.length})`);
  for (const message of newest) {
    out.push(
      `#${message.messageId} ${message.sender}${message.fromBot ? ' [bot]' : ''}${message.media > 0 ? ` [media ${message.media}]` : ''}: ${message.text}`,
    );
  }
  section(`Model calls (${modelCalls.length})`);
  for (const call of modelCalls) {
    out.push(
      `#${call.id} ${call.state} ${call.provider}/${call.model} messages=${call.request_messages ?? '-'} tools=${call.request_tools ?? '-'} in=${call.input_tokens ?? '-'} out=${call.output_tokens ?? '-'} cache_read=${call.cache_read_tokens ?? '-'} ${call.error_code ?? ''}`,
    );
  }
  section(`Tool calls (${toolCalls.length})`);
  for (const call of toolCalls) {
    out.push(
      `#${call.id} ${call.tool_name} ${call.state} side_effect=${call.side_effect === 1} ${call.error_code ?? ''}`,
    );
    out.push(`    args: ${preview(call.arguments_json, 200)}`);
    if (call.result_text !== null) {
      out.push(`    result: ${preview(call.result_text, 200)}`);
    }
  }
  section(`Telegram sends (${sends.length})`);
  for (const send of sends) {
    out.push(
      `#${send.id} ${send.kind} ${send.state} telegram_message_id=${send.telegram_message_id ?? '-'} ${send.error_code ?? ''} ${preview(send.request_json, 120)}`,
    );
  }
  section(`Agent messages (${messages.length})`);
  for (const message of messages) {
    out.push(`[${message.sequence_no}] ${message.role}: ${preview(message.text, 240)}`);
  }
  section('判读');
  for (const line of lines) {
    out.push(`- ${line}`);
  }
  return out.join('\n');
}
