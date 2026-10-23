import { expect } from 'vitest';
import type { SeedContext } from './invocation-search-seed.ts';

/**
 * Invocations 401 and 402 (Chat A): public vs private text, frozen snapshots and
 * bot send timing.
 */
export function seedMatchingInvocations(context: SeedContext): void {
  const { run, insertMessage, insertSnapshot } = context;

  // Invocation 401: two public incoming messages, one history snapshot, a
  // private assistant text, a tool result, and two sends of which one succeeded.
  const text601 = insertMessage({
    id: 601n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1001n,
    telegramDate: '2025-01-01T00:00:10.000Z',
    sentByBot: false,
    kind: 'text',
    text: '苹果 100% 好吃',
    caption: null,
  });
  const photo602 = insertMessage({
    id: 602n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1002n,
    telegramDate: '2025-01-01T00:05:20.000Z',
    sentByBot: false,
    kind: 'photo',
    text: null,
    caption: '夜晚的猫',
  });
  const history603 = insertMessage({
    id: 603n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1003n,
    telegramDate: '2025-01-01T00:06:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '历史里的秘密',
    caption: null,
  });
  const edge605 = insertMessage({
    id: 605n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1005n,
    telegramDate: '2025-01-01T00:00:10.500Z',
    sentByBot: false,
    kind: 'text',
    text: '边缘 3.5 秒',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 601n,
    revisionId: text601,
    telegramMessageId: 1001n,
    telegramDate: '2025-01-01T00:00:10.000Z',
    text: '苹果 100% 好吃',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 602n,
    revisionId: photo602,
    telegramMessageId: 1002n,
    telegramDate: '2025-01-01T00:05:20.000Z',
    text: null,
    caption: '夜晚的猫',
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 3n,
    section: 'history',
    messageId: 603n,
    revisionId: history603,
    telegramMessageId: 1003n,
    telegramDate: '2025-01-01T00:06:00.000Z',
    text: '历史里的秘密',
    caption: null,
  });
  insertSnapshot({
    invocationId: 401n,
    sequenceNo: 4n,
    section: 'new',
    messageId: 605n,
    revisionId: edge605,
    telegramMessageId: 1005n,
    telegramDate: '2025-01-01T00:00:10.500Z',
    text: '边缘 3.5 秒',
    caption: null,
  });
  run(
    "INSERT INTO agent_messages(id, invocation_id, sequence_no, role, text, created_at) VALUES (701, 401, 1, 'assistant', '私密思考 苹果', ?)",
    '2025-01-01T00:00:30.000Z',
  );
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (902, 401, 'call-read-a', 'read', '{}', '工具结果 苹果', 'success', 0, ?, ?)",
    '2025-01-01T00:00:40.000Z',
    '2025-01-01T00:00:41.000Z',
  );
  const outgoing604 = insertMessage({
    id: 604n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 2001n,
    telegramDate: '2025-01-01T00:06:30.000Z',
    sentByBot: true,
    kind: 'text',
    text: '机器人回复 苹果',
    caption: null,
  });
  expect(outgoing604).toBe(6041n);
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (901, 401, 'call-send-a', 'send', '{\"kind\":\"text\",\"text\":\"机器人回复 苹果\"}', 'telegram_message_id=2001', 'success', 1, ?, ?)",
    '2025-01-01T00:06:29.000Z',
    '2025-01-01T00:07:00.000Z',
  );
  run(
    'INSERT INTO host_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (801, 901, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', 2001, \'{"message_id":2001}\', ?, ?)',
    '2025-01-01T00:06:29.000Z',
    '2025-01-01T00:07:00.000Z',
  );
  run(
    'INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at, finished_at) VALUES (905, 401, \'call-send-unknown\', \'send\', \'{"kind":"text","text":"也许失败 苹果Y"}\', \'outcome_unknown\', 1, ?, ?)',
    '2025-01-01T00:07:59.000Z',
    '2025-01-01T00:08:00.000Z',
  );
  run(
    'INSERT INTO host_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (802, 905, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'outcome_unknown\', NULL, ?, ?)',
    '2025-01-01T00:07:59.000Z',
    '2025-01-01T00:08:00.000Z',
  );

  // Invocation 402: a snapshot whose live message is edited afterwards, plus
  // literal-wildcard bait and a successful send with no outgoing row.
  const frozen607 = insertMessage({
    id: 607n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1007n,
    telegramDate: '2025-01-01T01:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '旧版本文本',
    caption: null,
  });
  const edited609 = insertMessage({
    id: 609n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1009n,
    telegramDate: '2025-01-01T02:00:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: '100x 好吃',
    caption: null,
  });
  const underscore611 = insertMessage({
    id: 611n,
    chatId: 101n,
    conversationId: 201n,
    telegramMessageId: 1011n,
    telegramDate: '2025-01-01T02:10:00.000Z',
    sentByBot: false,
    kind: 'text',
    text: 'a_b 边界',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 1n,
    section: 'new',
    messageId: 607n,
    revisionId: frozen607,
    telegramMessageId: 1007n,
    telegramDate: '2025-01-01T01:00:00.000Z',
    text: '旧版本文本',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 2n,
    section: 'new',
    messageId: 609n,
    revisionId: edited609,
    telegramMessageId: 1009n,
    telegramDate: '2025-01-01T02:00:00.000Z',
    text: '100x 好吃',
    caption: null,
  });
  insertSnapshot({
    invocationId: 402n,
    sequenceNo: 3n,
    section: 'new',
    messageId: 611n,
    revisionId: underscore611,
    telegramMessageId: 1011n,
    telegramDate: '2025-01-01T02:10:00.000Z',
    text: 'a_b 边界',
    caption: null,
  });
  // Edit message 607 after its snapshot was frozen: revision 2 becomes live.
  run(
    "INSERT INTO message_revisions(id, message_id, revision_no, sender_id, kind, text, caption, created_at, raw_fragment_json) VALUES (6072, 607, 2, 501, 'text', '新版本文本', NULL, ?, ?)",
    '2025-01-01T02:30:00.000Z',
    '{"message_id":1007}',
  );
  run('UPDATE messages SET current_revision_id = 6072 WHERE id = 607');
  run(
    'INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at, finished_at) VALUES (903, 402, \'call-send-no-row\', \'send\', \'{"kind":"text","text":"没有落盘的发送"}\', \'success\', 1, ?, ?)',
    '2025-01-01T02:59:59.000Z',
    '2025-01-01T03:00:00.000Z',
  );
  run(
    'INSERT INTO host_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, created_at, finished_at) VALUES (803, 903, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'success\', 3003, \'{"message_id":3003}\', ?, ?)',
    '2025-01-01T02:59:59.000Z',
    '2025-01-01T03:00:00.000Z',
  );
  run(
    "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, error_code, created_at, finished_at) VALUES (904, 402, 'call-send-b', 'send', '{\"kind\":\"text\",\"text\":\"失败的发送 苹果X\"}', 'error', 1, 'send_error', ?, ?)",
    '2025-01-01T03:29:59.000Z',
    '2025-01-01T03:30:00.000Z',
  );
  run(
    'INSERT INTO host_sends(id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, created_at, finished_at) VALUES (804, 904, 201, \'text\', \'{"kind":"text","reply_to_message_id":null}\', \'error\', NULL, ?, ?)',
    '2025-01-01T03:29:59.000Z',
    '2025-01-01T03:30:00.000Z',
  );
}
