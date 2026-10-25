import { eq, sql } from 'drizzle-orm';
import {
  agentMessages,
  hostSends,
  invocationMessages,
  messages,
  modelCalls,
  toolCalls,
} from '../../../store/schema/index.ts';
import { meteredTokens } from '../../../store/sleep.ts';
import type { Orm } from '../../../store/store.ts';
import { bit, num } from './shared.ts';
import { INVOCATION_CHAT_COLUMNS, type InvocationListRow, invocationChat } from './invocations.ts';

interface InvocationDetailRow extends InvocationListRow {
  readonly prompt_version: bigint;
  readonly tool_registry_hash: string | null;
  readonly tool_registry_json: string | null;
  readonly bucket_id: bigint;
}

export function getInvocation(orm: Orm, id: bigint): Record<string, unknown> | null {
  const invocation = orm
    .all<InvocationDetailRow>(sql`SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              i.prompt_version, i.tool_registry_hash, i.tool_registry_json, i.bucket_id,
              ${INVOCATION_CHAT_COLUMNS},
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0) + COALESCE(mc.cache_read_tokens, 0) + COALESCE(mc.cache_write_tokens, 0)), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT COALESCE(SUM(mc.cache_read_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_read_tokens,
              (SELECT COALESCE(SUM(mc.cache_write_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_write_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       WHERE i.id = ${id}`)
    .at(0);
  if (invocation === undefined) {
    return null;
  }
  const toolCallRows = orm
    .select({
      id: toolCalls.id,
      toolCallId: toolCalls.toolCallId,
      toolName: toolCalls.toolName,
      argumentsJson: toolCalls.argumentsJson,
      resultText: toolCalls.resultText,
      state: toolCalls.state,
      sideEffect: toolCalls.sideEffect,
      errorCode: toolCalls.errorCode,
      durationMs: toolCalls.durationMs,
      createdAt: toolCalls.createdAt,
      finishedAt: toolCalls.finishedAt,
    })
    .from(toolCalls)
    .where(eq(toolCalls.invocationId, id))
    .orderBy(toolCalls.id)
    .all();
  const modelCallRows = orm
    .select({
      id: modelCalls.id,
      role: modelCalls.role,
      provider: modelCalls.provider,
      model: modelCalls.model,
      attempt: modelCalls.attempt,
      state: modelCalls.state,
      inputTokens: modelCalls.inputTokens,
      outputTokens: modelCalls.outputTokens,
      cacheReadTokens: modelCalls.cacheReadTokens,
      cacheWriteTokens: modelCalls.cacheWriteTokens,
      totalTokens: modelCalls.totalTokens,
      cost: modelCalls.cost,
      durationMs: modelCalls.durationMs,
      errorCode: modelCalls.errorCode,
      errorDetail: modelCalls.errorDetail,
      requestJson: modelCalls.requestJson,
      responseJson: modelCalls.responseJson,
      createdAt: modelCalls.createdAt,
      finishedAt: modelCalls.finishedAt,
      toolsJson: modelCalls.toolsJson,
    })
    .from(modelCalls)
    .where(eq(modelCalls.invocationId, id))
    .orderBy(modelCalls.id)
    .all();
  const agentMessageRows = orm
    .select({
      sequenceNo: agentMessages.sequenceNo,
      role: agentMessages.role,
      text: agentMessages.text,
      thinkingText: agentMessages.thinkingText,
      createdAt: agentMessages.createdAt,
    })
    .from(agentMessages)
    .where(eq(agentMessages.invocationId, id))
    .orderBy(agentMessages.sequenceNo)
    .all();
  const sendRows = orm
    .select({
      id: hostSends.id,
      toolCallId: toolCalls.toolCallId,
      kind: hostSends.kind,
      requestJson: hostSends.requestJson,
      state: hostSends.state,
      telegramMessageId: hostSends.telegramMessageId,
      roomSeq: messages.localSequenceNo,
      errorCode: hostSends.errorCode,
      createdAt: hostSends.createdAt,
      finishedAt: hostSends.finishedAt,
    })
    .from(hostSends)
    .innerJoin(toolCalls, eq(hostSends.toolCallId, toolCalls.id))
    // Only a room delivery links its outgoing message; a Telegram send is
    // identified by telegram_message_id alone, so room_seq stays null.
    .leftJoin(messages, eq(messages.id, hostSends.messageId))
    .where(eq(toolCalls.invocationId, id))
    .orderBy(hostSends.id)
    .all();
  const contextMessageRows = orm
    .select({
      section: invocationMessages.section,
      sequenceNo: invocationMessages.sequenceNo,
      messageId: invocationMessages.messageId,
      revisionId: invocationMessages.revisionId,
      omittedBefore: invocationMessages.omittedBefore,
      snapshotJson: invocationMessages.snapshotJson,
    })
    .from(invocationMessages)
    .where(eq(invocationMessages.invocationId, id))
    .orderBy(invocationMessages.sequenceNo)
    .all();
  return {
    id: invocation.id.toString(),
    bucket_id: invocation.bucket_id.toString(),
    state: invocation.state,
    created_at: invocation.created_at,
    started_at: invocation.started_at,
    finished_at: invocation.finished_at,
    completion_reason: invocation.completion_reason,
    error_code: invocation.error_code,
    sends_used: Number(invocation.sends_used),
    tool_calls_used: Number(invocation.tool_calls_used),
    turns_used: Number(invocation.turns_used),
    side_effect_started: bit(invocation.side_effect_started),
    config_hash: invocation.config_hash,
    prompt_version: Number(invocation.prompt_version),
    tool_registry_hash: invocation.tool_registry_hash,
    tool_registry: parseToolRegistry(invocation.tool_registry_json),
    chat: invocationChat(invocation),
    total_tokens: Number(invocation.total_tokens),
    cache_read_tokens: Number(invocation.cache_read_tokens),
    cache_write_tokens: Number(invocation.cache_write_tokens),
    total_cost: invocation.total_cost,
    tool_calls: toolCallRows.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.toolCallId,
      tool_name: row.toolName,
      arguments_json: row.argumentsJson,
      result_text: row.resultText,
      state: row.state,
      side_effect: row.sideEffect,
      error_code: row.errorCode,
      duration_ms: num(row.durationMs),
      created_at: row.createdAt,
      finished_at: row.finishedAt,
    })),
    model_calls: modelCallRows.map((row) => ({
      id: row.id.toString(),
      role: row.role,
      provider: row.provider,
      model: row.model,
      attempt: Number(row.attempt),
      state: row.state,
      input_tokens: num(row.inputTokens),
      output_tokens: num(row.outputTokens),
      cache_read_tokens: num(row.cacheReadTokens),
      cache_write_tokens: num(row.cacheWriteTokens),
      total_tokens: Number(
        meteredTokens({
          input: row.inputTokens ?? 0n,
          output: row.outputTokens ?? 0n,
          cacheRead: row.cacheReadTokens ?? 0n,
          cacheWrite: row.cacheWriteTokens ?? 0n,
        }),
      ),
      provider_total_tokens: num(row.totalTokens),
      cost: row.cost,
      duration_ms: num(row.durationMs),
      error_code: row.errorCode,
      error_detail: row.errorDetail,
      request_json: row.requestJson,
      response_json: row.responseJson,
      created_at: row.createdAt,
      finished_at: row.finishedAt,
      tools: parseStringArray(row.toolsJson),
    })),
    agent_messages: agentMessageRows.map((row) => ({
      sequence_no: Number(row.sequenceNo),
      role: row.role,
      text: row.text,
      thinking_text: row.thinkingText,
      created_at: row.createdAt,
    })),
    telegram_sends: sendRows.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.toolCallId,
      kind: row.kind,
      request_json: row.requestJson,
      state: row.state,
      telegram_message_id: row.telegramMessageId === null ? null : row.telegramMessageId.toString(),
      room_seq: row.roomSeq === null ? null : row.roomSeq.toString(),
      error_code: row.errorCode,
      created_at: row.createdAt,
      finished_at: row.finishedAt,
    })),
    context_messages: contextMessageRows.map((row) => ({
      section: row.section,
      sequence_no: Number(row.sequenceNo),
      message_id: row.messageId.toString(),
      revision_id: row.revisionId.toString(),
      omitted_before: Number(row.omittedBefore),
      snapshot_json: row.snapshotJson,
    })),
  };
}

/** Stored JSON is untrusted; only accept a well-formed array of strings. */
function parseStringArray(json: string | null): string[] | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseToolRegistry(
  json: string | null,
): readonly { name: string; label: string; description: string }[] | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const entries = parsed.map((entry): { name: string; label: string; description: string } | null => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const name = record.name;
      const label = record.label;
      const description = record.description;
      if (typeof name !== 'string' || typeof label !== 'string' || typeof description !== 'string') {
        return null;
      }
      return { name, label, description };
    });
    const valid = entries.filter(
      (entry): entry is { name: string; label: string; description: string } => entry !== null,
    );
    if (valid.length !== entries.length) {
      return null;
    }
    return valid;
  } catch {
    return null;
  }
}
