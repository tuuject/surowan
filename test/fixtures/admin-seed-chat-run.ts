import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  agentMessages,
  buckets,
  hostSends,
  invocationBuckets,
  invocationMessages,
  modelCalls,
  toolCalls,
} from '../../src/store/schema/index.ts';
import { T } from './admin-seed-data.ts';

/**
 * A long-lived run for the Overview conversation view, written onto the first
 * bulk invocation (4100, bucket 3100) so no list gains a row: one retained
 * history message, two batches the model read and one it never did, a skill
 * read, an `execute` call, a failed model call with its retry, a `send` and a
 * two-part `send_reply`. Call after `seedAdminBulkRows`. Do not wire this into
 * any production code path.
 */

export const CHAT_RUN = {
  invocation: 4_100n,
  openingBucket: 3_100n,
  attachedBucket: 3_200n,
  unreadBucket: 3_201n,
} as const;

const at = (seconds: number): string =>
  new Date(Date.parse('2026-09-11T08:01:00.000Z') + seconds * 1_000).toISOString();

function snapshot(messageNo: number, sender: 'alice' | 'bob', text: string, sentAt: string): string {
  return JSON.stringify({
    message_id: String(messageNo),
    telegram_date: sentAt,
    sent_by_bot: false,
    sender:
      sender === 'alice' ? { id: '42', name: 'Alice', username: 'alice' } : { id: '43', name: 'Bob', username: null },
    kind: 'text',
    text,
  });
}

export function seedAdminChatRun(store: SqliteStore): void {
  const orm = store.orm;
  const id = CHAT_RUN.invocation;
  for (const [bucketId, state] of [
    [CHAT_RUN.attachedBucket, 'completed'],
    // Terminal, so no scheduler in the E2E server ever picks it up.
    [CHAT_RUN.unreadBucket, 'expired'],
  ] as const) {
    orm
      .insert(buckets)
      .values({
        id: bucketId,
        conversationId: T.conversation,
        state,
        kind: 'realtime',
        firstReceivedAt: at(20),
        deadlineAt: at(25),
        queuedAt: at(25),
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        createdAt: at(20),
        updatedAt: at(25),
      })
      .run();
  }
  orm
    .insert(invocationBuckets)
    .values([
      { invocationId: id, bucketId: CHAT_RUN.openingBucket, attachedAt: at(-60), injectedAt: at(0) },
      { invocationId: id, bucketId: CHAT_RUN.attachedBucket, attachedAt: at(25), injectedAt: at(30) },
      { invocationId: id, bucketId: CHAT_RUN.unreadBucket, attachedAt: at(50), injectedAt: null },
    ])
    .run();

  // The frozen messages reuse the bulk message rows; only the snapshots are read.
  const frozen: readonly [string, bigint | null, string][] = [
    ['history', null, snapshot(1000, 'bob', 'Morning, everyone', at(-120))],
    ['new', CHAT_RUN.openingBucket, snapshot(1001, 'alice', 'Can you fetch the weather page?', at(-30))],
    ['new', CHAT_RUN.openingBucket, snapshot(1002, 'bob', 'and keep it short', at(-25))],
    ['new', CHAT_RUN.attachedBucket, snapshot(1003, 'alice', 'Thanks! A sticker too, please', at(24))],
    ['new', CHAT_RUN.unreadBucket, snapshot(1004, 'bob', 'One more question for later', at(50))],
  ];
  frozen.forEach(([section, sourceBucketId, snapshotJson], index) => {
    orm
      .insert(invocationMessages)
      .values({
        invocationId: id,
        messageId: 6_100n + BigInt(index),
        revisionId: 6_300n + BigInt(index),
        section,
        sequenceNo: BigInt(index + 1),
        sourceBucketId,
        omittedBefore: 0n,
        snapshotJson,
      })
      .run();
  });

  const model = (modelId: bigint, attempt: bigint, second: number, failed: boolean) =>
    orm
      .insert(modelCalls)
      .values({
        id: modelId,
        invocationId: id,
        role: 'agent',
        provider: 'openai',
        model: 'e2e-chat-model',
        attempt,
        state: failed ? 'error' : 'success',
        inputTokens: failed ? null : 900n,
        outputTokens: failed ? null : 60n,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: failed ? null : 960n,
        cost: failed ? null : 0.001,
        durationMs: 800n,
        errorCode: failed ? 'provider_timeout' : null,
        errorDetail: failed ? 'status=504 upstream timed out' : null,
        toolsJson: JSON.stringify(['read', 'execute', 'send', 'send_reply']),
        requestJson: null,
        responseJson: null,
        createdAt: at(second),
        finishedAt: at(second + 1),
      })
      .run();
  model(7_100n, 1n, 1, true);
  model(7_101n, 2n, 3, false);
  model(7_102n, 1n, 31, false);

  const tool = (toolId: bigint, callId: string, name: string, args: unknown, second: number) =>
    orm
      .insert(toolCalls)
      .values({
        id: toolId,
        invocationId: id,
        toolCallId: callId,
        toolName: name,
        argumentsJson: JSON.stringify(args),
        resultText: name.startsWith('send') ? 'sent' : 'ok',
        state: 'success',
        sideEffect: name.startsWith('send'),
        errorCode: null,
        durationMs: 40n,
        createdAt: at(second),
        finishedAt: at(second),
      })
      .run();
  tool(8_100n, 'call_chat_skill', 'read', { uri: 'system:///skills/web-fetch/SKILL.md' }, 5);
  tool(
    8_101n,
    'call_chat_fetch',
    'execute',
    { action: 'call', tool: 'web_fetch', input: { url: 'https://example.com/weather' } },
    7,
  );
  tool(8_102n, 'call_chat_send', 'send', { text: 'Sunny and 22°C today.', reply_to_message_id: 1001 }, 10);
  tool(
    8_103n,
    'call_chat_reply',
    'send_reply',
    { parts: [{ kind: 'sticker', sticker_ref: 'stk_e2e_sun' }, { text: 'Here you go!' }], reply_to_message_id: 1003 },
    33,
  );

  const agent = (sequence: bigint, role: string, text: string, second: number, toolCallId: string | null = null) =>
    orm
      .insert(agentMessages)
      .values({
        invocationId: id,
        sequenceNo: sequence,
        role,
        text,
        thinkingText: '',
        toolCallId,
        createdAt: at(second),
      })
      .run();
  agent(1n, 'assistant', 'Read the fetch skill, then fetch the page.', 4);
  agent(2n, 'tool_result', 'skill text', 5, 'call_chat_skill');
  agent(3n, 'tool_result', 'Sunny, 22°C', 7, 'call_chat_fetch');
  agent(4n, 'assistant', '', 9);
  agent(5n, 'tool_result', 'sent', 10, 'call_chat_send');
  agent(6n, 'assistant', 'Answer with a sticker and a line.', 32);
  agent(7n, 'tool_result', 'sent', 33, 'call_chat_reply');

  const deliveries = [
    { sendId: 8_150n, toolCallId: 8_102n, kind: 'text', messageNo: 1_050n },
    { sendId: 8_151n, toolCallId: 8_103n, kind: 'sticker', messageNo: 1_051n },
    { sendId: 8_152n, toolCallId: 8_103n, kind: 'text', messageNo: 1_052n },
  ];
  orm
    .insert(hostSends)
    .values(
      deliveries.map((delivery) => ({
        id: delivery.sendId,
        toolCallId: delivery.toolCallId,
        conversationId: T.conversation,
        kind: delivery.kind,
        requestJson: '{}',
        state: 'success',
        messageNo: delivery.messageNo,
        responseJson: '{}',
        errorCode: null,
        createdAt: at(33),
        finishedAt: at(33),
      })),
    )
    .run();
}
