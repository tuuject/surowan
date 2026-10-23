import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import {
  ALREADY_DELIVERED,
  ASSET_ID,
  detailsOf,
  FIRST_PHOTO_MESSAGE_ID,
  finished,
  fixture,
  GENERATION_ID,
  imageDeliveryOf,
  installImageDeliveryHooks,
  queryImageSends,
  queryInvocations,
  queryReceipts,
  querySendToolCalls,
  RECEIPT_MARKER,
  RESENT_PHOTO_MESSAGE_ID,
  retainedContext,
  sendImage,
  textOf,
  update,
} from './image-delivery-runtime-fixtures.ts';

installImageDeliveryHooks();

/**
 * Runtime regression for repeated picture delivery (audit 3486).
 *
 * The ordinary tool chain can deliver an image before its completion receipt is
 * injected: `image_generate` settles while the tool chain is still open, the
 * scheduler claims the receipt onto the running invocation, the model already
 * sends the picture, and only then does a no-tool turn inject the receipt. A
 * model reading that receipt naturally sends the same generation again.
 *
 * The contract under test:
 *  - `send kind:image` is deduplicated per conversation + generation + asset id
 *    against successful `host_sends` audit rows. A repeat is a successful
 *    no-op: details `${telegramMessageId, replayed: true}`, tool call success
 *    with `side_effect = false`, a result text that says the picture was already
 *    delivered, no new `host_sends` row, no `sends_used` increment and no
 *    canonical `send_count_total` / `send_seq` increment.
 *  - A real image delivery keeps its existing details and now records the
 *    delivered `asset_ids` in `host_sends.request_json`.
 *  - The injected image completion receipt carries `image_delivery` with the
 *    delivered / pending / unknown asset ids as of the injection instant.
 *  - A later ordinary user invocation may still resend the same generation once,
 *    but only when it passes `resend: true`; without it the call stays a no-op.
 *
 * Real store, AgentRuntime, ConversationRuntime, BucketScheduler and
 * LongTaskService; a Faux agent, mock picture bytes, and no network, real
 * config/key.json, `serve` or configuration reload.
 */

test('a delivered generation is replayed as a no-op when its receipt is answered again, and resends only on an explicit request', async () => {
  const f = await fixture();

  // --- First invocation: deliver while the receipt waits, then answer the receipt --------
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      // No-tool turn: the claimed receipt is injected at this boundary, after
      // the first delivery already went out.
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      // Receipt round: the model sees the receipt and the first send's success
      // result, and deliberately sends the same generation again.
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.snapshots.receiptStateWhileToolChainOpen).toBe('claimed');
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID]);

  // The receipt was claimed onto this invocation and injected exactly once.
  const receipts = queryReceipts(f.store);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    state: 'handled',
    invocation_outcome: 'completed',
    completion_reason: 'completed',
  });
  const invocationId = receipts[0]!.invocation_id;
  expect(queryInvocations(f.store)).toEqual([{ id: invocationId, state: 'completed', sends_used: 1n }]);
  const attached = f.store.db
    .prepare<[], { bucket_id: bigint; invocation_id: bigint; injected_at: string | null }>(
      'SELECT bucket_id, invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
    )
    .all();
  expect(attached).toHaveLength(2);
  expect(attached.map((row) => row.invocation_id)).toEqual([invocationId, invocationId]);
  expect(attached.map((row) => row.injected_at)).toEqual([expect.any(String), expect.any(String)]);
  expect(attached[1]!.bucket_id).toBe(receipts[0]!.bucket_id);
  expect(attached[0]!.bucket_id).not.toBe(attached[1]!.bucket_id);

  // One real delivery, recorded with its asset ids; the second call is an
  // audited success that never reached Telegram.
  const firstSends = queryImageSends(f.store);
  expect(firstSends).toHaveLength(1);
  expect(firstSends[0]!.state).toBe('success');
  expect(firstSends[0]!.telegram_message_id).toBe(BigInt(FIRST_PHOTO_MESSAGE_ID));
  const sendRequest = JSON.parse(firstSends[0]!.request_json) as Record<string, unknown>;
  expect(sendRequest.kind).toBe('image');
  expect(sendRequest.generation_id).toBe(GENERATION_ID);
  expect(sendRequest.asset_ids).toEqual([ASSET_ID]);
  const sendCalls = querySendToolCalls(f.store);
  expect(sendCalls.map(({ tool_call_id, state, side_effect }) => ({ tool_call_id, state, side_effect }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success', side_effect: 1n },
    { tool_call_id: 'call-send-2', state: 'success', side_effect: 0n },
  ]);
  expect(sendCalls[0]!.result_text ?? '').toContain(String(FIRST_PHOTO_MESSAGE_ID));
  expect(sendCalls[1]!.result_text ?? '').toMatch(ALREADY_DELIVERED);
  for (const call of sendCalls) {
    expect(call.error_code).toBeNull();
    expect(call.invocation_id).toBe(invocationId);
  }

  // Canonical history: two send tool results, the second one replayed; the
  // replay added neither a canonical send nor a reference.
  const firstContext = retainedContext(f.store, 1n);
  const sendResults = firstContext.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(sendResults).toHaveLength(2);
  expect(textOf(sendResults[0]!.message.content)).toContain(`Sent Telegram message ${FIRST_PHOTO_MESSAGE_ID}`);
  expect(detailsOf(sendResults[0]!.message)).toMatchObject({
    telegramMessageId: String(FIRST_PHOTO_MESSAGE_ID),
  });
  expect(detailsOf(sendResults[0]!.message).replayed).not.toBe(true);
  expect(textOf(sendResults[1]!.message.content)).toMatch(ALREADY_DELIVERED);
  expect(detailsOf(sendResults[1]!.message)).toMatchObject({
    telegramMessageId: String(FIRST_PHOTO_MESSAGE_ID),
    replayed: true,
  });
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([{ seq: sendResults[0]!.seq, send_seq: 1n }]);
  expect(
    f.store.db
      .prepare<[bigint], { send_seq: bigint | null }>('SELECT send_seq FROM context_messages WHERE seq = ?')
      .get(sendResults[1]!.seq),
  ).toEqual({ send_seq: null });
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 1n });
  expect(firstContext.header.headSeq).toBe(1n);
  expect(firstContext.header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(
    f.store.db.prepare('SELECT ref, kind, source_seq, target_conversation_id FROM context_refs ORDER BY ref').all(),
  ).toEqual([{ ref: 'reply:1', kind: 'reply', source_seq: 1n, target_conversation_id: 1n }]);

  // Faux decision order: the receipt is absent before its boundary, and the
  // second decision sees both the receipt (with image_delivery) and the first
  // send's success result; the turn after the replay sees the replay result.
  expect(f.requests[1]).not.toContain(RECEIPT_MARKER);
  expect(f.requests[2]).not.toContain(RECEIPT_MARKER);
  expect(f.requests[3]).toContain(RECEIPT_MARKER);
  expect(f.requests[3]).toContain(GENERATION_ID);
  expect(f.requests[3]).toContain(`Sent Telegram message ${FIRST_PHOTO_MESSAGE_ID}`);
  expect(f.requests[4]).toMatch(ALREADY_DELIVERED);

  // --- Second invocation: an ordinary new message still may resend, but only on request ----
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-3');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-4', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('resent');
    },
  ]);
  f.ingestion.ingest(update(2, 'can you send it again?'));
  f.scheduler.processDue();
  f.scheduler.wake();
  await finished(f, 2n);

  expect(f.requests).toHaveLength(8);
  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID, RESENT_PHOTO_MESSAGE_ID]);
  const invocations = queryInvocations(f.store);
  expect(invocations).toHaveLength(2);
  expect(invocations.map(({ state, sends_used }) => ({ state, sends_used }))).toEqual([
    { state: 'completed', sends_used: 1n },
    { state: 'completed', sends_used: 1n },
  ]);
  const allCalls = querySendToolCalls(f.store);
  expect(allCalls.map(({ tool_call_id, state, side_effect }) => ({ tool_call_id, state, side_effect }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success', side_effect: 1n },
    { tool_call_id: 'call-send-2', state: 'success', side_effect: 0n },
    { tool_call_id: 'call-send-3', state: 'success', side_effect: 0n },
    { tool_call_id: 'call-send-4', state: 'success', side_effect: 1n },
  ]);
  expect(allCalls[2]!.result_text ?? '').toMatch(ALREADY_DELIVERED);
  expect(allCalls[3]!.result_text ?? '').toContain(String(RESENT_PHOTO_MESSAGE_ID));
  expect(queryImageSends(f.store).map(({ state, telegram_message_id }) => ({ state, telegram_message_id }))).toEqual([
    { state: 'success', telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) },
    { state: 'success', telegram_message_id: BigInt(RESENT_PHOTO_MESSAGE_ID) },
  ]);
  for (const row of queryImageSends(f.store)) {
    const request = JSON.parse(row.request_json) as Record<string, unknown>;
    expect(request.asset_ids).toEqual([ASSET_ID]);
  }

  const secondContext = retainedContext(f.store, 1n);
  const allResults = secondContext.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(allResults).toHaveLength(4);
  expect(textOf(allResults[2]!.message.content)).toMatch(ALREADY_DELIVERED);
  expect(textOf(allResults[3]!.message.content)).toContain(`Sent Telegram message ${RESENT_PHOTO_MESSAGE_ID}`);
  expect(detailsOf(allResults[3]!.message)).toMatchObject({
    telegramMessageId: String(RESENT_PHOTO_MESSAGE_ID),
  });
  expect(detailsOf(allResults[3]!.message).replayed).not.toBe(true);
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([
    { seq: allResults[0]!.seq, send_seq: 1n },
    { seq: allResults[3]!.seq, send_seq: 2n },
  ]);
  for (const replay of [allResults[1]!, allResults[2]!]) {
    expect(
      f.store.db
        .prepare<[bigint], { send_seq: bigint | null }>('SELECT send_seq FROM context_messages WHERE seq = ?')
        .get(replay.seq),
    ).toEqual({ send_seq: null });
  }
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 2n });
  expect(secondContext.header.headSeq).toBe(1n);
  expect(secondContext.header.nextSeq).toBe(
    f.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()!.count + 1n,
  );
  expect(queryReceipts(f.store)).toHaveLength(1);
  const attachedAll = f.store.db
    .prepare<[], { bucket_id: bigint; invocation_id: bigint; injected_at: string | null }>(
      'SELECT bucket_id, invocation_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
    )
    .all();
  expect(attachedAll.filter((row) => row.invocation_id === invocations[0]!.id)).toHaveLength(2);
  expect(attachedAll.filter((row) => row.invocation_id === invocations[1]!.id)).toHaveLength(1);
  for (const row of attachedAll) {
    expect(row.injected_at).toEqual(expect.any(String));
  }

  // References stay consistent across the replay: one per ordinary batch, none minted by
  // either replay. Rendering the retained history in the second invocation authorizes the
  // one delivered picture, so exactly one media ref points at the bot's photo message.
  const userSeqs = f.store.db
    .prepare<[], { seq: bigint }>("SELECT seq FROM context_messages WHERE role = 'user' ORDER BY seq")
    .all();
  expect(userSeqs).toHaveLength(3);
  const refs = f.store.db
    .prepare<[], { ref: string; kind: string; source_seq: bigint; target_conversation_id: bigint | null }>(
      'SELECT ref, kind, source_seq, target_conversation_id FROM context_refs ORDER BY ref',
    )
    .all();
  expect(refs.map((row) => row.kind).sort()).toEqual(['media', 'reply', 'reply']);
  expect(
    refs
      .filter((row) => row.kind === 'reply')
      .map(({ ref, source_seq, target_conversation_id }) => ({ ref, source_seq, target_conversation_id })),
  ).toEqual([
    { ref: 'reply:1', source_seq: userSeqs[0]!.seq, target_conversation_id: 1n },
    { ref: 'reply:2', source_seq: userSeqs[2]!.seq, target_conversation_id: 1n },
  ]);
  expect(
    f.store.db
      .prepare<[], { telegram_message_id: bigint }>(
        `SELECT m.telegram_message_id AS telegram_message_id
         FROM context_refs r
         JOIN media md ON md.id = r.media_id
         JOIN message_revisions mr ON mr.id = md.revision_id
         JOIN messages m ON m.id = mr.message_id
         WHERE r.kind = 'media'`,
      )
      .all(),
  ).toEqual([{ telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) }]);

  // The receipt injection the model actually read: one receipt, marked delivered.
  const receiptMessages = firstContext.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER)
      ? [{ text: textOf(message.content) }]
      : [],
  );
  expect(receiptMessages).toHaveLength(1);
  const receiptText = receiptMessages[0]!.text;
  expect(receiptText).toContain(GENERATION_ID);
  const delivery = imageDeliveryOf(receiptText);
  expect(delivery).toBeDefined();
  expect(delivery?.delivered_asset_ids).toEqual([ASSET_ID]);
  expect(delivery?.pending_asset_ids).toEqual([]);
  expect(delivery?.unknown_asset_ids).toEqual([]);
  expect(f.requests[3]).toContain('image_delivery');
});
