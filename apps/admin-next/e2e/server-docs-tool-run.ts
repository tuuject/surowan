/**
 * The completed, tool-using run the Tool calls and Reviews shots document: one
 * read of a real bundled document, one `send` with its Telegram row, and frozen
 * messages taken from the run's own message rows.
 */
import { eq } from 'drizzle-orm';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import {
  agentMessages,
  bucketMessages,
  buckets,
  hostSends,
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

export function seedDocsToolRun(store: SqliteStore, text: DocsSeedText): void {
  const orm = store.orm;
  // --- the completed run with tool calls and a Telegram send ---
  // Its frozen messages are its own rows, so the snapshot and the message
  // record agree on text, sender, message id and time.
  orm
    .insert(messages)
    .values([
      {
        hostKind: 'telegram',
        id: DOCS_IDS.toolHistoryMessage,
        conversationId: T.conversation,
        chatId: T.chat,
        messageNo: 1_101n,
        currentRevisionId: null,
        visible: true,
        sentByBot: false,
        sentAt: '2026-09-10T18:30:00.000Z',
        receivedAt: '2026-09-10T18:30:00.000Z',
      },
      {
        hostKind: 'telegram',
        id: DOCS_IDS.toolMessage,
        conversationId: T.conversation,
        chatId: T.chat,
        messageNo: 1_102n,
        currentRevisionId: null,
        visible: true,
        sentByBot: false,
        sentAt: '2026-09-11T10:00:00.000Z',
        receivedAt: '2026-09-11T10:00:00.000Z',
      },
    ])
    .run();
  orm
    .insert(messageRevisions)
    .values([
      {
        id: DOCS_IDS.toolHistoryRevision,
        messageId: DOCS_IDS.toolHistoryMessage,
        revisionNo: 1n,
        senderId: 5_003n,
        kind: 'text',
        text: text.toolRun.history,
        caption: null,
        replyToMessageId: null,
        replySnapshotJson: null,
        forwardOriginJson: null,
        mediaGroupId: null,
        serviceJson: null,
        createdAt: '2026-09-10T18:30:00.000Z',
        rawFragmentJson: '{}',
      },
      {
        id: DOCS_IDS.toolRevision,
        messageId: DOCS_IDS.toolMessage,
        revisionNo: 1n,
        senderId: T.sender,
        kind: 'text',
        text: text.toolRun.incoming,
        caption: null,
        replyToMessageId: null,
        replySnapshotJson: null,
        forwardOriginJson: null,
        mediaGroupId: null,
        serviceJson: null,
        createdAt: '2026-09-11T10:00:00.000Z',
        rawFragmentJson: '{}',
      },
    ])
    .run();
  orm
    .update(messages)
    .set({ currentRevisionId: DOCS_IDS.toolHistoryRevision })
    .where(eq(messages.id, DOCS_IDS.toolHistoryMessage))
    .run();
  orm
    .update(messages)
    .set({ currentRevisionId: DOCS_IDS.toolRevision })
    .where(eq(messages.id, DOCS_IDS.toolMessage))
    .run();
  orm
    .insert(buckets)
    .values({
      id: DOCS_IDS.toolBucket,
      conversationId: T.conversation,
      state: 'completed',
      kind: 'realtime',
      firstReceivedAt: '2026-09-11T10:00:00.000Z',
      deadlineAt: '2026-09-11T10:00:15.000Z',
      queuedAt: '2026-09-11T10:00:15.000Z',
      startedAt: '2026-09-11T10:00:16.000Z',
      finishedAt: '2026-09-11T10:00:24.000Z',
      errorCode: null,
      createdAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:00:24.000Z',
      windowSeconds: 15n,
      maxSeconds: 15n,
    })
    .run();
  orm
    .insert(bucketMessages)
    .values({ bucketId: DOCS_IDS.toolBucket, messageId: DOCS_IDS.toolMessage, sequenceNo: 1n })
    .run();
  orm
    .insert(invocations)
    .values({
      id: DOCS_IDS.toolInvocation,
      bucketId: DOCS_IDS.toolBucket,
      conversationId: T.conversation,
      state: 'completed',
      configHash: 'docs-config-hash-tools',
      promptVersion: 7n,
      toolRegistryHash: 'docs-registry-hash-tools',
      toolRegistryJson: TOOL_REGISTRY,
      startedAt: '2026-09-11T10:00:16.000Z',
      finishedAt: '2026-09-11T10:00:24.000Z',
      completionReason: 'turn_limit_reached',
      errorCode: null,
      sendsUsed: 1n,
      toolCallsUsed: 2n,
      turnsUsed: 2n,
      sideEffectStarted: true,
      createdAt: '2026-09-11T10:00:15.000Z',
    })
    .run();
  orm
    .insert(invocationBuckets)
    .values({
      invocationId: DOCS_IDS.toolInvocation,
      bucketId: DOCS_IDS.toolBucket,
      attachedAt: '2026-09-11T10:00:15.000Z',
      injectedAt: '2026-09-11T10:00:16.000Z',
    })
    .run();
  orm
    .insert(modelCalls)
    .values({
      id: DOCS_IDS.toolModelCall,
      invocationId: DOCS_IDS.toolInvocation,
      role: 'agent',
      provider: 'relay',
      model: 'relay-model-a',
      attempt: 1n,
      state: 'success',
      inputTokens: 980n,
      outputTokens: 212n,
      cacheReadTokens: 640n,
      cacheWriteTokens: 0n,
      totalTokens: 1_832n,
      cost: 0.0028,
      durationMs: 1_180n,
      errorCode: null,
      errorDetail: null,
      toolsJson: JSON.stringify(['send', 'read']),
      requestJson: null,
      responseJson: JSON.stringify({ status: 'ok', usage: { total_tokens: 1832 } }),
      createdAt: '2026-09-11T10:00:16.000Z',
      finishedAt: '2026-09-11T10:00:17.000Z',
    })
    .run();
  orm
    .insert(toolCalls)
    .values([
      {
        id: DOCS_IDS.toolReadCall,
        invocationId: DOCS_IDS.toolInvocation,
        toolCallId: 'call_read_202',
        toolName: 'read',
        argumentsJson: JSON.stringify({ uri: text.toolRun.readUri }),
        resultText: bundledDocument(text.toolRun.readUri),
        state: 'success',
        sideEffect: false,
        errorCode: null,
        durationMs: 9n,
        createdAt: '2026-09-11T10:00:18.000Z',
        finishedAt: '2026-09-11T10:00:18.000Z',
      },
      {
        id: DOCS_IDS.toolSendCall,
        invocationId: DOCS_IDS.toolInvocation,
        toolCallId: 'call_send_202',
        toolName: 'send',
        argumentsJson: JSON.stringify({ kind: 'text', text: text.toolRun.reply }),
        resultText: 'sent',
        state: 'success',
        sideEffect: true,
        errorCode: null,
        durationMs: 168n,
        createdAt: '2026-09-11T10:00:22.000Z',
        finishedAt: '2026-09-11T10:00:22.000Z',
      },
    ])
    .run();
  orm
    .insert(hostSends)
    .values({
      id: DOCS_IDS.toolHostSend,
      toolCallId: DOCS_IDS.toolSendCall,
      conversationId: T.conversation,
      kind: 'text',
      requestJson: JSON.stringify({ chat_id: 123_456_789, text: text.toolRun.reply }),
      state: 'success',
      messageNo: 1_100n,
      responseJson: JSON.stringify({ message_id: 1100 }),
      errorCode: null,
      createdAt: '2026-09-11T10:00:22.000Z',
      finishedAt: '2026-09-11T10:00:22.000Z',
    })
    .run();
  orm
    .insert(agentMessages)
    .values([
      {
        invocationId: DOCS_IDS.toolInvocation,
        sequenceNo: 1n,
        role: 'assistant',
        text: text.toolRun.reasoning,
        thinkingText: '',
        createdAt: '2026-09-11T10:00:17.000Z',
      },
      {
        invocationId: DOCS_IDS.toolInvocation,
        sequenceNo: 2n,
        role: 'tool_result',
        text: bundledDocument(text.toolRun.readUri),
        thinkingText: '',
        createdAt: '2026-09-11T10:00:18.000Z',
      },
      {
        invocationId: DOCS_IDS.toolInvocation,
        sequenceNo: 3n,
        role: 'assistant',
        text: text.toolRun.sendIntro,
        thinkingText: '',
        createdAt: '2026-09-11T10:00:21.000Z',
      },
    ])
    .run();
  orm
    .insert(invocationMessages)
    .values([
      {
        invocationId: DOCS_IDS.toolInvocation,
        messageId: DOCS_IDS.toolHistoryMessage,
        revisionId: DOCS_IDS.toolHistoryRevision,
        section: 'history',
        sequenceNo: 1n,
        sourceBucketId: null,
        omittedBefore: 0n,
        snapshotJson: snapshot({
          senderName: text.otherSenderName,
          text: text.toolRun.history,
          messageId: '1101',
          date: '2026-09-10T18:30:00.000Z',
        }),
      },
      {
        invocationId: DOCS_IDS.toolInvocation,
        messageId: DOCS_IDS.toolMessage,
        revisionId: DOCS_IDS.toolRevision,
        section: 'new',
        sequenceNo: 2n,
        sourceBucketId: DOCS_IDS.toolBucket,
        omittedBefore: 0n,
        snapshotJson: snapshot({
          senderName: text.senderName,
          text: text.toolRun.incoming,
          messageId: '1102',
          date: '2026-09-11T10:00:00.000Z',
        }),
      },
    ])
    .run();
}
