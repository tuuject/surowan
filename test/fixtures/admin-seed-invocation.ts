import type { Orm } from '../../src/store/store.ts';
import {
  agentMessages,
  buckets,
  hostSends,
  invocationMessages,
  invocations,
  modelCalls,
  toolCalls,
} from '../../src/store/schema.ts';
import { AT, OVERSIZED_REQUEST_JSON, REDACTED_ERROR_DETAIL, T } from './admin-seed-data.ts';

/**
 * Invocation-side rows: buckets and invocations, their model calls, tool calls
 * and host sends, the agent transcript and the frozen invocation context.
 */

/** Buckets + invocations. */
export function seedAdminBuckets(orm: Orm): void {
  orm
    .insert(buckets)
    .values({
      id: T.bucketA,
      conversationId: T.conversation,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-10T07:59:30.000Z',
      deadlineAt: '2026-09-10T07:59:45.000Z',
      queuedAt: '2026-09-10T07:59:45.000Z',
      startedAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T08:00:06.000Z',
      errorCode: null,
      createdAt: AT,
      updatedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(buckets)
    .values({
      id: T.bucketB,
      conversationId: T.conversation,
      state: 'failed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-10T09:00:00.000Z',
      deadlineAt: '2026-09-10T09:00:15.000Z',
      queuedAt: '2026-09-10T09:00:15.000Z',
      startedAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
      errorCode: 'model_failed',
      createdAt: '2026-09-10T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:40.000Z',
    })
    .run();

  orm
    .insert(invocations)
    .values({
      id: T.invocationA,
      bucketId: T.bucketA,
      conversationId: T.conversation,
      state: 'completed',
      configHash: 'seed-config-hash-aaaa',
      promptVersion: 7n,
      toolRegistryHash: 'seed-registry-hash-1',
      toolRegistryJson: JSON.stringify([
        { name: 'send', label: 'Send message', description: 'Sends a message to Telegram.' },
        { name: 'read', label: 'Read document', description: 'Reads a system resource.' },
      ]),
      startedAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T08:00:06.000Z',
      completionReason: 'turn_limit_reached',
      errorCode: null,
      sendsUsed: 1n,
      toolCallsUsed: 2n,
      turnsUsed: 3n,
      sideEffectStarted: true,
      createdAt: '2026-09-10T07:59:45.000Z',
    })
    .run();
  orm
    .insert(invocations)
    .values({
      id: T.invocationB,
      bucketId: T.bucketB,
      conversationId: T.conversation,
      state: 'failed',
      configHash: 'seed-config-hash-bbbb',
      promptVersion: 7n,
      toolRegistryHash: 'seed-registry-hash-2',
      toolRegistryJson: null,
      startedAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
      completionReason: 'model_error',
      errorCode: 'model_failed',
      sendsUsed: 0n,
      toolCallsUsed: 1n,
      turnsUsed: 1n,
      sideEffectStarted: false,
      createdAt: '2026-09-10T09:00:15.000Z',
    })
    .run();
}

/** Model calls: A success ×2, B failed with redacted detail. */
export function seedAdminModelCalls(orm: Orm): void {
  orm
    .insert(modelCalls)
    .values({
      id: T.modelOkA,
      invocationId: T.invocationA,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 1n,
      state: 'success',
      inputTokens: 1_000n,
      outputTokens: 250n,
      cacheReadTokens: 500n,
      cacheWriteTokens: 0n,
      totalTokens: 1_750n,
      cost: 0.0032,
      durationMs: 1_234n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: OVERSIZED_REQUEST_JSON,
      responseJson: JSON.stringify({ status: 'ok', usage: { total_tokens: 1750 } }),
      createdAt: '2026-09-10T07:59:46.000Z',
      finishedAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: T.modelOkB,
      invocationId: T.invocationA,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 2n,
      state: 'success',
      inputTokens: 1_200n,
      outputTokens: 80n,
      cacheReadTokens: 900n,
      cacheWriteTokens: 0n,
      totalTokens: 2_180n,
      cost: 0.0016,
      durationMs: 812n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send']),
      requestJson: null,
      responseJson: null,
      createdAt: '2026-09-10T08:00:01.000Z',
      finishedAt: '2026-09-10T08:00:02.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: T.modelFailedB,
      invocationId: T.invocationB,
      role: 'agent',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      attempt: 1n,
      state: 'error',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      cost: null,
      durationMs: 5_000n,
      errorCode: 'provider_timeout',
      errorDetail: REDACTED_ERROR_DETAIL,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: OVERSIZED_REQUEST_JSON,
      responseJson: null,
      createdAt: '2026-09-10T09:00:16.000Z',
      finishedAt: '2026-09-10T09:00:40.000Z',
    })
    .run();
}

/** Tool calls + telegram sends (send call linked by tool_call_id string). */
export function seedAdminToolCalls(orm: Orm): void {
  orm
    .insert(toolCalls)
    .values({
      id: T.toolReadA,
      invocationId: T.invocationA,
      toolCallId: 'call_read_001',
      toolName: 'read',
      argumentsJson: '{"path":"system:///skills/readme.md"}',
      resultText: 'ok',
      state: 'success',
      sideEffect: false,
      errorCode: null,
      durationMs: 12n,
      createdAt: '2026-09-10T07:59:48.000Z',
      finishedAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values({
      id: T.toolSendA,
      invocationId: T.invocationA,
      toolCallId: 'call_send_001',
      toolName: 'send',
      argumentsJson: '{"kind":"text","text":"Hello from the seeded invocation","reply_to_message_id":900}',
      resultText: 'sent',
      state: 'success',
      sideEffect: true,
      errorCode: null,
      durationMs: 204n,
      createdAt: '2026-09-10T08:00:03.000Z',
      finishedAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values({
      id: T.toolReadB,
      invocationId: T.invocationB,
      toolCallId: 'call_read_002',
      toolName: 'read',
      argumentsJson: '{"path":"system:///skills/missing.md"}',
      resultText: null,
      state: 'error',
      sideEffect: false,
      errorCode: 'not_found',
      durationMs: 3n,
      createdAt: '2026-09-10T09:00:38.000Z',
      finishedAt: '2026-09-10T09:00:38.000Z',
    })
    .run();
  orm
    .insert(hostSends)
    .values({
      id: T.sendA,
      toolCallId: T.toolSendA,
      conversationId: T.conversation,
      kind: 'text',
      requestJson: '{"chat_id":123456789,"text":"Hello from the seeded invocation"}',
      state: 'success',
      telegramMessageId: 902n,
      responseJson: '{"message_id":902}',
      errorCode: null,
      createdAt: '2026-09-10T08:00:03.000Z',
      finishedAt: '2026-09-10T08:00:03.000Z',
    })
    .run();
}

/** Agent transcript. */
export function seedAdminTranscript(orm: Orm): void {
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 1n,
      role: 'assistant',
      text: 'private reasoning before calling read',
      thinkingText: '',
      createdAt: '2026-09-10T07:59:46.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 2n,
      role: 'tool_result',
      text: '{"path":"system:///skills/readme.md","ok":true}',
      thinkingText: '',
      createdAt: '2026-09-10T07:59:48.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationA,
      sequenceNo: 3n,
      role: 'assistant',
      text: 'I will send the reply via the send tool.',
      thinkingText: '',
      createdAt: '2026-09-10T08:00:02.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values({
      invocationId: T.invocationB,
      sequenceNo: 1n,
      role: 'assistant',
      text: 'trying to answer but the model call failed',
      thinkingText: '',
      createdAt: '2026-09-10T09:00:16.000Z',
    })
    .run();
}

/** Frozen context (history + new partitions). */
export function seedAdminFrozenContext(orm: Orm): void {
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationA,
      messageId: T.messageA,
      revisionId: T.revisionA2,
      section: 'history',
      sequenceNo: 1n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { id: '42', username: 'alice', name: 'Alice' },
        kind: 'photo',
        caption: 'edited caption',
        telegram_date: '2026-09-10T07:59:30.000Z',
        message_id: '900',
        media: [{ kind: 'photo' }],
      }),
    })
    .run();
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationA,
      messageId: T.messageB,
      revisionId: T.revisionB1,
      section: 'new',
      sequenceNo: 2n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { id: '42', username: 'alice', name: 'Alice' },
        kind: 'text',
        text: 'plain text message with a reply',
        telegram_date: '2026-09-10T08:00:05.000Z',
        message_id: '901',
      }),
    })
    .run();
  orm
    .insert(invocationMessages)
    .values({
      invocationId: T.invocationB,
      messageId: T.messageB,
      revisionId: T.revisionB1,
      section: 'new',
      sequenceNo: 1n,
      sourceBucketId: null,
      omittedBefore: 0n,
      snapshotJson: JSON.stringify({
        sender: { username: 'alice', name: 'Alice' },
        kind: 'text',
        text: 'plain text message with a reply',
        telegram_date: '2026-09-10T09:00:00.000Z',
        message_id: '901',
      }),
    })
    .run();
}
