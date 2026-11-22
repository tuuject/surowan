/**
 * The failed run the Resume shot documents: the newest of its own Conversation,
 * with the batch attached to its bucket and already injected into the context,
 * one successful opening model call that asked for the read, and the next call
 * that timed out.
 */
import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import {
  agentMessages,
  bucketMessages,
  buckets,
  contextMessages,
  conversationContexts,
  invocationBuckets,
  invocationMessages,
  invocations,
  messageRevisions,
  messages,
  modelCalls,
  toolCalls,
} from '../../../src/store/schema/index.ts';
import { T } from '../../../test/fixtures/admin-seed-data.ts';
import type { DocsSeedText } from './docs-locale.ts';
import { bundledDocument, DOCS_IDS, snapshot, TOOL_REGISTRY } from './server-docs-ids.ts';

export function seedDocsFailedRun(store: SqliteStore, text: DocsSeedText): void {
  const orm = store.orm;
  // --- the failed run of the group Chat: latest of its Conversation ---
  orm
    .insert(messages)
    .values({
      hostKind: 'telegram',
      id: DOCS_IDS.resumeMessage,
      conversationId: DOCS_IDS.groupConversation,
      chatId: DOCS_IDS.groupChat,
      messageNo: 1_200n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      sentAt: '2026-09-11T09:00:00.000Z',
      receivedAt: '2026-09-11T09:00:00.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: DOCS_IDS.resumeRevision,
      messageId: DOCS_IDS.resumeMessage,
      revisionNo: 1n,
      senderId: T.sender,
      kind: 'text',
      text: text.resumeRun.incoming,
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-11T09:00:00.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .update(messages)
    .set({ currentRevisionId: DOCS_IDS.resumeRevision })
    .where(eq(messages.id, DOCS_IDS.resumeMessage))
    .run();
  // The batch reached the canonical Context before the first model call, which
  // is the case a Resume continues from.
  orm
    .insert(conversationContexts)
    .values({
      id: DOCS_IDS.groupContext,
      conversationId: DOCS_IDS.groupConversation,
      headSeq: 1n,
      nextSeq: 2n,
      sendCountTotal: 0n,
      systemPromptHash: 'seed-docs-group-prompt',
      activeInvocationId: null,
      lastActiveAt: '2026-09-11T09:00:20.000Z',
      lastGcAt: null,
      createdAt: '2026-09-11T08:59:00.000Z',
      updatedAt: '2026-09-11T09:00:20.000Z',
    })
    .run();
  orm
    .insert(buckets)
    .values({
      id: DOCS_IDS.resumeBucket,
      conversationId: DOCS_IDS.groupConversation,
      state: 'failed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-11T09:00:00.000Z',
      deadlineAt: '2026-09-11T09:00:15.000Z',
      queuedAt: '2026-09-11T09:00:15.000Z',
      startedAt: '2026-09-11T09:00:16.000Z',
      finishedAt: '2026-09-11T09:00:46.000Z',
      errorCode: 'model_failed',
      createdAt: '2026-09-11T09:00:00.000Z',
      updatedAt: '2026-09-11T09:00:46.000Z',
      windowSeconds: 15n,
      maxSeconds: 15n,
    })
    .run();
  orm
    .insert(bucketMessages)
    .values({ bucketId: DOCS_IDS.resumeBucket, messageId: DOCS_IDS.resumeMessage, sequenceNo: 1n })
    .run();
  orm
    .insert(invocations)
    .values({
      id: DOCS_IDS.resumeInvocation,
      bucketId: DOCS_IDS.resumeBucket,
      conversationId: DOCS_IDS.groupConversation,
      state: 'failed',
      configHash: 'docs-config-hash-resume',
      promptVersion: 7n,
      toolRegistryHash: 'docs-registry-hash-resume',
      toolRegistryJson: TOOL_REGISTRY,
      startedAt: '2026-09-11T09:00:16.000Z',
      finishedAt: '2026-09-11T09:00:46.000Z',
      completionReason: 'model_error',
      errorCode: 'model_failed',
      sendsUsed: 0n,
      toolCallsUsed: 1n,
      turnsUsed: 2n,
      sideEffectStarted: false,
      createdAt: '2026-09-11T09:00:15.000Z',
    })
    .run();
  orm
    .insert(invocationBuckets)
    .values({
      invocationId: DOCS_IDS.resumeInvocation,
      bucketId: DOCS_IDS.resumeBucket,
      attachedAt: '2026-09-11T09:00:15.000Z',
      injectedAt: '2026-09-11T09:00:16.000Z',
    })
    .run();
  orm
    .insert(contextMessages)
    .values({
      contextId: DOCS_IDS.groupContext,
      seq: 1n,
      role: 'user',
      payloadJson: JSON.stringify({ text: text.resumeRun.incoming }),
      invocationId: DOCS_IDS.resumeInvocation,
      isCheckpoint: true,
      sendSeq: null,
      estTokens: 24n,
      evictedAt: null,
      createdAt: '2026-09-11T09:00:16.000Z',
    })
    .run();
  // Attempt 1 succeeded and asked for the read; attempt 2 timed out.
  orm
    .insert(modelCalls)
    .values({
      id: DOCS_IDS.resumeOpeningCall,
      invocationId: DOCS_IDS.resumeInvocation,
      role: 'agent',
      provider: 'relay',
      model: 'relay-model-a',
      attempt: 1n,
      state: 'success',
      inputTokens: 720n,
      outputTokens: 48n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      totalTokens: 768n,
      cost: 0.0011,
      durationMs: 2_400n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: null,
      responseJson: JSON.stringify({ status: 'ok', usage: { total_tokens: 768 } }),
      createdAt: '2026-09-11T09:00:17.000Z',
      finishedAt: '2026-09-11T09:00:19.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values({
      id: DOCS_IDS.resumeToolCall,
      invocationId: DOCS_IDS.resumeInvocation,
      toolCallId: 'call_read_201',
      toolName: 'read',
      argumentsJson: JSON.stringify({ uri: text.resumeRun.readUri }),
      resultText: bundledDocument(text.resumeRun.readUri),
      state: 'success',
      sideEffect: false,
      errorCode: null,
      durationMs: 4n,
      createdAt: '2026-09-11T09:00:20.000Z',
      finishedAt: '2026-09-11T09:00:20.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: DOCS_IDS.resumeFailedCall,
      invocationId: DOCS_IDS.resumeInvocation,
      role: 'agent',
      provider: 'relay',
      model: 'relay-model-a',
      attempt: 2n,
      state: 'error',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      cost: null,
      durationMs: 25_000n,
      errorCode: 'provider_timeout',
      errorDetail: text.resumeRun.errorDetail,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: null,
      responseJson: null,
      createdAt: '2026-09-11T09:00:21.000Z',
      finishedAt: '2026-09-11T09:00:46.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values([
      {
        invocationId: DOCS_IDS.resumeInvocation,
        sequenceNo: 1n,
        role: 'assistant',
        text: text.resumeRun.reasoning,
        thinkingText: '',
        createdAt: '2026-09-11T09:00:19.000Z',
      },
      {
        invocationId: DOCS_IDS.resumeInvocation,
        sequenceNo: 2n,
        role: 'tool_result',
        text: bundledDocument(text.resumeRun.readUri),
        thinkingText: '',
        createdAt: '2026-09-11T09:00:20.000Z',
      },
    ])
    .run();
  orm
    .insert(invocationMessages)
    .values({
      invocationId: DOCS_IDS.resumeInvocation,
      messageId: DOCS_IDS.resumeMessage,
      revisionId: DOCS_IDS.resumeRevision,
      section: 'new',
      sequenceNo: 1n,
      sourceBucketId: DOCS_IDS.resumeBucket,
      omittedBefore: 0n,
      snapshotJson: snapshot({
        senderName: text.senderName,
        text: text.resumeRun.incoming,
        messageId: '1200',
        date: '2026-09-11T09:00:00.000Z',
      }),
    })
    .run();
}
