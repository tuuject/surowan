import type { AgentTool } from '@earendil-works/pi-agent-core';
import { eq } from 'drizzle-orm';
import Type from 'typebox';
import { toolCalls } from '../../store/schema/index.ts';
import { finishToolCall, startToolCall } from '../../store/store.ts';
import { recentSendCount } from './guards.ts';
import { replyPolicyText, textConstraintsText } from './prompts.ts';
import { deliverSend } from './publish.ts';
import { recordRejectedSend } from './record.ts';
import { checkReplyParts } from './reply-check.ts';
import {
  type Deliver,
  type SendDetails,
  type SendReplyDetails,
  type SendToolEnvironment,
  sentCountText,
  sentMessagesResult,
  sentReplyDetails,
} from './support.ts';

/** What one Telegram message carries; `send` and every `send_reply` part share it. */
const sendContentProperties = {
  kind: Type.Optional(Type.Enum({ text: 'text', sticker: 'sticker', image: 'image' })),
  resend: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  parse_mode: Type.Optional(Type.Literal('MarkdownV2')),
  sticker_ref: Type.Optional(Type.String({ minLength: 1 })),
  image_generation_id: Type.Optional(Type.String({ pattern: '^[0-9a-f-]{36}$' })),
};
const replyToMessageId = Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' }));

export const SendInputSchema = Type.Object(
  { ...sendContentProperties, reply_to_message_id: replyToMessageId },
  { additionalProperties: false },
);

/** The tools that publish to Telegram; everything else stays private. */
export const SEND_TOOL_NAMES: ReadonlySet<string> = new Set(['send', 'send_reply']);

/** Most messages one `send_reply` call may publish. */
export const SEND_REPLY_MAX_PARTS = 4;

export const SendReplyInputSchema = Type.Object(
  {
    parts: Type.Array(Type.Object(sendContentProperties, { additionalProperties: false }), {
      minItems: 2,
      maxItems: SEND_REPLY_MAX_PARTS,
    }),
    reply_to_message_id: replyToMessageId,
  },
  { additionalProperties: false },
);

export type SendToolInput =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly parse_mode?: 'MarkdownV2';
      readonly reply_to_message_id?: string;
    }
  | { readonly kind: 'sticker'; readonly sticker_ref: string; readonly reply_to_message_id?: string }
  | {
      readonly kind: 'image';
      readonly image_generation_id: string;
      readonly resend?: boolean;
      readonly text?: string;
      readonly reply_to_message_id?: string;
    };

export function createSendTool(environment: SendToolEnvironment): AgentTool<typeof SendInputSchema, SendDetails> {
  return createSendTools(environment).send;
}

/**
 * `send` and `send_reply` over one delivery pipeline, so a completion mention
 * is added once per task whichever tool publishes first.
 */
export function createSendTools(environment: SendToolEnvironment): {
  readonly send: AgentTool<typeof SendInputSchema, SendDetails>;
  readonly sendReply: AgentTool<typeof SendReplyInputSchema, SendReplyDetails>;
} {
  const mentionedTasks = new Set<bigint>();
  const replyPolicy = replyPolicyText(environment);
  const textConstraints = textConstraintsText(environment);
  const deliver: Deliver = (toolCallId, input, signal, options) =>
    deliverSend(environment, mentionedTasks, toolCallId, input, signal, options);
  const send: AgentTool<typeof SendInputSchema, SendDetails> = {
    name: 'send',
    label: 'Send to Telegram',
    description: `Publish exactly one warranted user-visible Telegram message or sticker. You MUST use this only after deciding the new messages or a current task completion require a reply, clarification, or confirmation; you MUST NOT use it merely because the tool is available, to answer history-only content, or to publish private reasoning. Keep the message concise and self-contained. For text, kind MAY be omitted; omit parse_mode for plain text, or set parse_mode to MarkdownV2 only when the text is correctly escaped. ${textConstraints} For generated images, use kind:image with image_generation_id from this conversation. Already delivered outputs are not sent again; a replayed result reports the earlier delivery, not a new message. You MAY set resend:true only when a new user message explicitly asks to resend those pictures, and MUST NOT set it just to handle a completion receipt or retry an unknown outcome. For a sticker, kind MUST be sticker and sticker_ref MUST be a stk_ value returned by the search_stickers capability (via execute); img_ refs MUST NOT be sent. You MUST set reply_to_message_id only to a message visible in this conversation, preferring the relevant new message; when several separate discussions are active, you SHOULD set it on every message so each reply is visibly attached to the one it answers. ${replyPolicy} Success means Telegram accepted the send; if the tool fails or reports an unknown outcome, you MUST NOT claim it was sent and MUST NOT blindly retry. One batch of new messages MAY hold several separate discussions among different people: keep one message to one discussion, calling send once per discussion you choose to answer rather than merging unrelated discussions into a single message, and leave a discussion unanswered when you have nothing to add to it. You SHOULD NOT split one answer across several send calls: when one answer reads better as a few short consecutive messages, or pairs a sticker or generated picture with text, you SHOULD use send_reply once instead. Repeated sends are rate limited per chat.`,
    parameters: SendInputSchema,
    executionMode: 'sequential',
    execute: (toolCallId, input, signal) => deliver(toolCallId, input, signal, { barrier: true }),
  };
  return { send, sendReply: createSendReplyTool(environment, deliver, textConstraints, replyPolicy) };
}

/**
 * One reply as several consecutive messages. Every part is checked before the
 * first goes out, so a predictable rejection never leaves half a reply; each
 * part then runs the whole `send` pipeline as its own audited call
 * (`<tool_call_id>:<n>`). Only the first part carries the reply target and
 * meets the send barrier: once it is out, the rest follow it back to back.
 */
export function createSendReplyTool(
  environment: SendToolEnvironment,
  deliver: Deliver,
  textConstraints: string,
  replyPolicy: string,
): AgentTool<typeof SendReplyInputSchema, SendReplyDetails> {
  return {
    name: 'send_reply',
    label: 'Send a multi-part reply to Telegram',
    description: `Publish one warranted reply as 2 to ${SEND_REPLY_MAX_PARTS} consecutive Telegram messages, sent in the listed order: for example a sticker and then text, a generated picture and then its explanation, or a medium-length answer that reads more naturally as a few short messages. You SHOULD use send for a single message; you MUST NOT pad an answer into parts, and MUST NOT use send_reply to merge separate discussions (answer each with its own send). Each part is one message with the same fields as send: text (kind MAY be omitted, optional parse_mode), kind:sticker with a stk_ sticker_ref, or kind:image with image_generation_id and an optional caption in text. ${textConstraints} reply_to_message_id applies to the first part only; the later parts follow it without a reply. ${replyPolicy} Every part is checked before anything is sent, so a rejection means nothing went out. Once the first part is out the rest follow without waiting for new messages. If a later part fails, the earlier ones stay published and the error lists them: you MUST NOT send those again. Each part counts against the per-chat send rate limit.`,
    parameters: SendReplyInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const reject = (errorCode: string, message: string): never => {
        recordRejectedSend(environment, toolCallId, input, errorCode, 'send_reply');
        throw new Error(`Nothing was sent: ${message}`);
      };
      if (input.parts.length < 2 || input.parts.length > SEND_REPLY_MAX_PARTS) {
        reject('send_input_invalid', `send_reply takes 2 to ${SEND_REPLY_MAX_PARTS} parts; use send for one message`);
      }
      if (
        input.reply_to_message_id !== undefined &&
        environment.capabilities.resolveReplyTarget(input.reply_to_message_id) === undefined
      ) {
        reject('reply_not_visible', 'reply_to_message_id is not visible in this conversation context');
      }
      checkReplyParts(environment, input, reject);
      if (signal?.aborted === true || Date.now() >= environment.deadline) {
        reject(signal?.aborted === true ? 'aborted' : 'deadline_exceeded', 'the run was cancelled or timed out');
      }
      const { sendsPerWindow, windowSeconds } = environment.sendRateLimit;
      if (recentSendCount(environment, new Date()) + input.parts.length > sendsPerWindow) {
        reject(
          'send_rate_limited',
          `${input.parts.length} messages would exceed the send rate limit of ${sendsPerWindow} per ${windowSeconds}s window`,
        );
      }
      const startedAt = performance.now();
      const auditId = startToolCall(
        environment.store.orm,
        environment.context.invocationId,
        toolCallId,
        'send_reply',
        JSON.stringify(input),
        true,
      );
      const sent: string[] = [];
      for (const [index, part] of input.parts.entries()) {
        const partCallId = `${toolCallId}:${index + 1}`;
        const first = index === 0;
        try {
          const result = await deliver(
            partCallId,
            first && input.reply_to_message_id !== undefined
              ? { ...part, reply_to_message_id: input.reply_to_message_id }
              : part,
            signal,
            { barrier: first },
          );
          const detail = result.details;
          const published = detail.telegramMessageId ?? detail.messageId;
          if (published === undefined) {
            throw new Error('the host reported a delivery without a message id');
          }
          sent.push(published);
        } catch (error) {
          const failed = environment.store.orm
            .select({ errorCode: toolCalls.errorCode })
            .from(toolCalls)
            .where(eq(toolCalls.toolCallId, partCallId))
            .get();
          finishToolCall(
            environment.store.orm,
            auditId,
            'error',
            sent.length === 0 ? null : sentMessagesResult(environment.host, sent),
            failed?.errorCode ?? 'send_error',
            { startedAt },
          );
          const reason = error instanceof Error ? error.message : String(error);
          if (sent.length === 0) {
            throw new Error(`Nothing was sent: part 1 failed. ${reason}`);
          }
          const rest = input.parts.length - index - 1;
          throw new Error(
            `Parts 1-${index} were published as Telegram messages ${sent.join(', ')}; do not send them again. Part ${index + 1} failed: ${reason}${rest > 0 ? ` The remaining ${rest} part(s) were not attempted.` : ''}`,
          );
        }
      }
      finishToolCall(environment.store.orm, auditId, 'success', sentMessagesResult(environment.host, sent), null, {
        startedAt,
      });
      return {
        content: [{ type: 'text', text: sentCountText(environment.host, sent.length, sent) }],
        details: sentReplyDetails(environment.host, sent),
      };
    },
  };
}
