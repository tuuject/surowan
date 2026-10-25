/**
 * The send guards: what this invocation already published, what it already had
 * rejected, and how many attempts this chat made in the rate-limit window.
 *
 * Split out of send-tool.ts; the checks themselves are unchanged.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Static } from 'typebox';
import { toolCalls } from '../../store/schema/index.ts';
import type { SendInputSchema, SendToolInput } from './index.ts';
import { narrowSendInput, type SendToolEnvironment } from './support.ts';

/**
 * Send attempts recorded in this chat inside the rate-limit window. Every state
 * counts, including pending, unknown and error: those are exactly what a
 * runaway loop piles up when the host hiccups or when every attempt is rejected
 * (a markup escape the model keeps getting wrong, for example).
 *
 * The scope is the internal chat that owns this conversation, not a Telegram
 * chat id, so a host without a wire is limited by exactly the same rule.
 */
export function recentSendCount(environment: SendToolEnvironment, now: Date): number {
  const since = new Date(now.getTime() - environment.sendRateLimit.windowSeconds * 1_000).toISOString();
  const row = environment.store.orm
    .all<{ count: bigint }>(
      sql`SELECT COUNT(*) AS count
       FROM host_sends ts
       JOIN conversations v ON v.id = ts.conversation_id
       WHERE v.chat_id = (SELECT owner.chat_id FROM conversations owner WHERE owner.id = ${environment.context.conversationId})
         AND ts.created_at >= ${since}`,
    )
    .at(0);
  return Number(row?.count ?? 0n);
}

/**
 * Whether this invocation already published exactly this text or sticker. The
 * audit row stores the narrowed input, so equal sends serialize identically.
 * Images are left to their own per-asset delivery dedup: a generation that
 * gained pictures may be sent again with the same input and deliver only those.
 */
export function isDuplicateSend(environment: SendToolEnvironment, send: SendToolInput): boolean {
  if (environment.duplicateSendGuard === undefined || send.kind === 'image') {
    return false;
  }
  const previous = environment.store.orm
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.invocationId, environment.context.invocationId),
        eq(toolCalls.toolName, 'send'),
        eq(toolCalls.state, 'success'),
        eq(toolCalls.sideEffect, true),
        eq(toolCalls.argumentsJson, JSON.stringify(send)),
      ),
    )
    .limit(1)
    .get();
  return previous !== undefined;
}

/**
 * Whether this text or sticker repeats the content of the last message this
 * invocation published, whatever its reply target or parse mode: one message
 * re-aimed at the next person ("answering" several people with the same line)
 * is the loop this catches. Only the immediately preceding send counts, so a
 * short line such as an acknowledgement may still recur later in the run.
 */
export function repeatsLastSend(environment: SendToolEnvironment, send: SendToolInput): boolean {
  if (environment.duplicateSendGuard === undefined) {
    return false;
  }
  const resolveStickerRef = environment.capabilities.resolveStickerRef;
  const key = sendContentKey(send, resolveStickerRef);
  if (key === null) {
    return false;
  }
  const last = environment.store.orm
    .select({ argumentsJson: toolCalls.argumentsJson })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.invocationId, environment.context.invocationId),
        eq(toolCalls.toolName, 'send'),
        eq(toolCalls.state, 'success'),
        eq(toolCalls.sideEffect, true),
      ),
    )
    .orderBy(desc(toolCalls.id))
    .limit(1)
    .get();
  const previous = last === undefined ? null : auditedSend(last.argumentsJson);
  return previous !== null && sendContentKey(previous, resolveStickerRef) === key;
}

/**
 * Content identity with the reply target and parse mode stripped: the unit a
 * reply-policy rejection burns for the rest of the run. A sticker is keyed on
 * the file its ref resolves to, because every `search_stickers` call mints a
 * fresh `stk_` ref for the same sticker; an unresolvable ref has no key.
 * Images stay exempt for the same reason they skip the duplicate guard — a
 * generation may gain pictures and be sent again with the same input,
 * delivering only the new ones. Exported so the replay scene keys burned
 * content identically.
 */
export function sendContentKey(
  send: SendToolInput,
  resolveStickerRef: (ref: string) => string | undefined,
): string | null {
  if (send.kind === 'text') {
    return JSON.stringify(['text', send.text]);
  }
  if (send.kind === 'sticker') {
    const fileId = resolveStickerRef(send.sticker_ref);
    return fileId === undefined ? null : JSON.stringify(['sticker', fileId]);
  }
  return null;
}

/**
 * Whether this invocation's reply policy (`reply_already_sent` or
 * `reply_delivery_unknown`) already rejected exactly this text or sticker:
 * that rejection tells the model not to retry under a changed or omitted
 * reply_to_message_id, and this check enforces it. A `send_duplicate` that
 * carried a reply target burns too while the policy is on: an exact repeat of
 * a published reply aims at a message already replied to, and the duplicate
 * guard only answered before the policy could. Barrier and rate-limit
 * rejections never burn content, since both explicitly allow a later retry.
 */
export function wasRejectedByReplyPolicy(environment: SendToolEnvironment, send: SendToolInput): boolean {
  const resolveStickerRef = environment.capabilities.resolveStickerRef;
  const key = sendContentKey(send, resolveStickerRef);
  if (key === null) {
    return false;
  }
  const replyPolicyOn = environment.allowReplyMessageMultipleTimes !== true;
  const rejected = environment.store.orm
    .select({ argumentsJson: toolCalls.argumentsJson, errorCode: toolCalls.errorCode })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.invocationId, environment.context.invocationId),
        eq(toolCalls.toolName, 'send'),
        eq(toolCalls.state, 'error'),
        inArray(
          toolCalls.errorCode,
          replyPolicyOn
            ? ['reply_already_sent', 'reply_delivery_unknown', 'send_duplicate']
            : ['reply_already_sent', 'reply_delivery_unknown'],
        ),
      ),
    )
    .all();
  return rejected.some((row) => {
    const previous = auditedSend(row.argumentsJson);
    return (
      previous !== null &&
      (row.errorCode !== 'send_duplicate' || previous.reply_to_message_id !== undefined) &&
      sendContentKey(previous, resolveStickerRef) === key
    );
  });
}

/**
 * The send one audit row asked for. Rejections record the model's raw input
 * (placeholder fields included), so it is narrowed again; a malformed row
 * yields nothing and so never matches a real send.
 */
function auditedSend(argumentsJson: string): SendToolInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const narrowed = narrowSendInput(parsed as Static<typeof SendInputSchema>);
  return 'problem' in narrowed ? null : narrowed.send;
}
