import type { SeedContext } from './invocation-search-seed.ts';

/**
 * Invocations 403 (Chat B) and 404/405 (Chat A): the five-match cap, same-second
 * ordering with large Telegram IDs and preview truncation.
 */
export function seedCapInvocations(context: SeedContext): void {
  const { run, insertMessage, insertSnapshot, insertBotSend } = context;

  // Invocation 403 (Chat B): a DST-adjacent incoming message, underscore bait,
  // six cappable matches and an oversized preview.
  const newYork608 = insertMessage({
    id: 608n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1008n,
    telegramDate: '2024-03-10T06:29:30.000Z',
    sentByBot: false,
    kind: 'text',
    text: '苹果在纽约',
    caption: null,
  });
  const plain610 = insertMessage({
    id: 610n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1010n,
    telegramDate: '2024-03-10T06:40:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: 'axb 边界',
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 608n,
    revisionId: newYork608,
    telegramMessageId: 1008n,
    telegramDate: '2024-03-10T06:29:30.000Z',
    text: '苹果在纽约',
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 610n,
    revisionId: plain610,
    telegramMessageId: 1010n,
    telegramDate: '2024-03-10T06:40:00.000Z',
    text: 'axb 边界',
    caption: null,
  });
  for (let index = 1; index <= 6; index++) {
    const messageId = 620n + BigInt(index);
    const telegramMessageId = 1020n + BigInt(index);
    const telegramDate = `2025-01-01T04:0${index}:00.000Z`;
    const revisionId = insertMessage({
      id: messageId,
      chatId: 102n,
      conversationId: 202n,
      telegramMessageId,
      telegramDate,
      sentByBot: false,
      kind: 'text',
      text: `批量消息 ${index}`,
      caption: null,
    });
    insertSnapshot({
      invocationId: 403n,
      sequenceNo: BigInt(index + 2),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate,
      text: `批量消息 ${index}`,
      caption: null,
    });
  }
  const long630 = insertMessage({
    id: 630n,
    chatId: 102n,
    conversationId: 202n,
    telegramMessageId: 1030n,
    telegramDate: '2025-01-01T05:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: `超长${'喵'.repeat(2_400)}`,
    caption: null,
  });
  insertSnapshot({
    invocationId: 403n,
    sequenceNo: 9n,
    section: 'new',
    messageId: 630n,
    revisionId: long630,
    telegramMessageId: 1030n,
    telegramDate: '2025-01-01T05:00:00.000Z',
    text: `超长${'喵'.repeat(2_400)}`,
    caption: null,
  });

  // Invocation 404 (Chat A): seven mixed public matches, so the per-invocation
  // cap has to keep the five newest across both sources.
  run(
    "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (304, 201, 'completed', 'realtime', ?, ?, ?, ?)",
    '2025-01-01T06:00:00.000Z',
    '2025-01-01T06:01:00.000Z',
    '2025-01-01T06:00:00.000Z',
    '2025-01-01T06:10:00.000Z',
  );
  run(
    "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (404, 304, 201, 'completed', 'test-hash', 1, ?, ?, ?)",
    '2025-01-01T06:10:00.000Z',
    '2025-01-01T06:10:00.000Z',
    '2025-01-01T06:10:00.000Z',
  );
  const mixedIncoming: ReadonlyArray<[bigint, string]> = [
    [1101n, '2025-01-01T06:01:00.000Z'],
    [1102n, '2025-01-01T06:02:00.000Z'],
    [1103n, '2025-01-01T06:03:00.000Z'],
    [1104n, '2025-01-01T06:04:00.000Z'],
    [1105n, '2025-01-01T06:05:00.000Z'],
  ];
  mixedIncoming.forEach(([telegramMessageId, telegramDate], index) => {
    const messageId = 640n + BigInt(index);
    const revisionId = insertMessage({
      id: messageId,
      chatId: 101n,
      conversationId: 201n,
      telegramMessageId,
      telegramDate,
      sentByBot: false,
      kind: 'text',
      text: `混流 ${index + 1}`,
      caption: null,
    });
    insertSnapshot({
      invocationId: 404n,
      sequenceNo: BigInt(index + 1),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate,
      text: `混流 ${index + 1}`,
      caption: null,
    });
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 404n,
    toolCallId: 911n,
    sendId: 811n,
    messageId: 645n,
    telegramMessageId: 2101n,
    telegramDate: '2025-01-01T06:04:30.000Z',
    text: '混流 回复 1',
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 404n,
    toolCallId: 912n,
    sendId: 812n,
    messageId: 646n,
    telegramMessageId: 2102n,
    telegramDate: '2025-01-01T06:06:00.000Z',
    text: '混流 回复 2',
  });

  // Invocation 405 (Chat A): four matches inside one public second with
  // large (>2^53) Telegram message IDs, including one bot send.
  run(
    "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (305, 201, 'completed', 'realtime', ?, ?, ?, ?)",
    '2025-01-01T07:00:00.000Z',
    '2025-01-01T07:01:00.000Z',
    '2025-01-01T07:00:00.000Z',
    '2025-01-01T07:10:00.000Z',
  );
  run(
    "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, started_at, finished_at, created_at) VALUES (405, 305, 201, 'completed', 'test-hash', 1, ?, ?, ?)",
    '2025-01-01T07:10:00.000Z',
    '2025-01-01T07:10:00.000Z',
    '2025-01-01T07:10:00.000Z',
  );
  const sameSecond: ReadonlyArray<[bigint, string]> = [
    [9007199254740993n, '同秒 甲'],
    [9007199254740992n, '同秒 乙'],
    [10000000000000000n, '同秒 丙'],
  ];
  sameSecond.forEach(([telegramMessageId, text], index) => {
    const messageId = 650n + BigInt(index);
    const revisionId = insertMessage({
      id: messageId,
      chatId: 101n,
      conversationId: 201n,
      telegramMessageId,
      telegramDate: '2025-01-01T07:00:00.000Z',
      sentByBot: false,
      kind: 'text',
      text,
      caption: null,
    });
    insertSnapshot({
      invocationId: 405n,
      sequenceNo: BigInt(index + 1),
      section: 'new',
      messageId,
      revisionId,
      telegramMessageId,
      telegramDate: '2025-01-01T07:00:00.000Z',
      text,
      caption: null,
    });
  });
  insertBotSend({
    chatId: 101n,
    conversationId: 201n,
    invocationId: 405n,
    toolCallId: 913n,
    sendId: 813n,
    messageId: 653n,
    telegramMessageId: 9999999999999999n,
    telegramDate: '2025-01-01T07:00:00.000Z',
    text: '同秒 回复',
  });
}
