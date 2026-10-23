import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { conversations } from './core.ts';
import { messages } from './messaging.ts';
import { invocations } from './invocation.ts';

export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'cascade',
    }),
    mediaAnalysisId: sqliteBigInt('media_analysis_id'),
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attempt: sqliteBigInt('attempt').notNull(),
    state: text('state').notNull(),
    inputTokens: sqliteBigInt('input_tokens'),
    outputTokens: sqliteBigInt('output_tokens'),
    cacheReadTokens: sqliteBigInt('cache_read_tokens'),
    cacheWriteTokens: sqliteBigInt('cache_write_tokens'),
    totalTokens: sqliteBigInt('total_tokens'),
    cost: real('cost'),
    durationMs: sqliteBigInt('duration_ms'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    toolsJson: text('tools_json'),
    requestJson: text('request_json'),
    responseJson: text('response_json'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('model_calls_invocation_idx').on(t.invocationId),
    check('model_calls_role_check', sql`role IN ('agent', 'vision_chat', 'vision_sticker', 'doctor', 'tool')`),
    check(
      'model_calls_state_check',
      sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`,
    ),
  ],
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    thinkingText: text('thinking_text').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('agent_messages_role_check', sql`role IN ('assistant', 'tool_result', 'harness_nudge')`),
    uniqueIndex('agent_messages_invocation_sequence_unique').on(t.invocationId, t.sequenceNo),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull().unique(),
    toolName: text('tool_name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    resultText: text('result_text'),
    state: text('state').notNull(),
    sideEffect: integer('side_effect', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    durationMs: sqliteBigInt('duration_ms'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('tool_calls_invocation_idx').on(t.invocationId),
    check('tool_calls_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`),
  ],
);

export const hostSends = sqliteTable(
  'host_sends',
  {
    id: sqliteBigIntId('id').primaryKey(),
    toolCallId: sqliteBigInt('tool_call_id')
      .notNull()
      .references(() => toolCalls.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    kind: text('kind').notNull(),
    requestJson: text('request_json').notNull(),
    state: text('state').notNull(),
    telegramMessageId: sqliteBigInt('telegram_message_id'),
    // The message a virtual host published for this send, if it publishes one.
    messageId: sqliteBigInt('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    responseJson: text('response_json'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('host_sends_reply_delivery_idx')
      .on(table.conversationId, sql`json_extract(${table.requestJson}, '$.reply_to_message_id')`)
      .where(sql`${table.state} IN ('success', 'pending', 'outcome_unknown')`),
    index('host_sends_image_delivery_idx')
      .on(table.conversationId, sql`json_extract(${table.requestJson}, '$.generation_id')`)
      .where(sql`${table.kind} = 'image'`),
    index('host_sends_message_idx').on(table.messageId).where(sql`${table.messageId} IS NOT NULL`),
    check('host_sends_kind_check', sql`kind IN ('text', 'sticker', 'image')`),
    check('host_sends_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown')`),
  ],
);
