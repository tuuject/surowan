/**
 * The `send` and `send_reply` replay tools together with the current
 * configuration checks they run before recording a synthesized send.
 *
 * Split out of `replay-tools.ts`; check and dispatch order is unchanged.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Static } from 'typebox';
import { SEND_REPLY_MAX_PARTS, type SendInputSchema } from '../capabilities/send-tool.ts';
import type { ReplayState, ReplayToolDefinition } from './replay-tools.ts';
import { SendInputValidator, SendReplyInputValidator, replayToolBase } from './replay-tools-spec.ts';
import { narrowSendInput } from '../capabilities/send-tool-support.ts';
import { sendContentKey } from '../capabilities/send-tool-guards.ts';

export function replaySendTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      if (!SendInputValidator.Check(params)) {
        throw new Error('send input does not match the tool schema');
      }
      const input = params;
      checkReplaySend(input, state, 'send');
      state.dispatches.push({ tool_call_id: toolCallId, tool_name: 'send', mode: 'synthetic' });
      checkReplayNotDuplicate([input], state);
      checkReplayNotBypassed([input], state);
      checkReplayNotRepeatingPrevious([input], state);
      checkReplayReplyUnused(input, state);
      const messageId = recordReplaySend(toolCallId, input, state);
      return {
        content: [{ type: 'text' as const, text: `Sent Telegram message ${messageId}` }],
        details: { telegramMessageId: messageId },
      };
    },
  };
}

/** Every part is checked first, then each becomes one synthesized `send` output (`<id>:<n>`). */
export function replaySendReplyTool(definition: ReplayToolDefinition, state: ReplayState): AgentTool {
  return {
    ...replayToolBase(definition),
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      if (!SendReplyInputValidator.Check(params)) {
        throw new Error(`send_reply input does not match the tool schema (2 to ${SEND_REPLY_MAX_PARTS} parts)`);
      }
      const replyTo = typeof params.reply_to_message_id === 'string' ? params.reply_to_message_id : undefined;
      const parts = params.parts.map(
        (part, index): Static<typeof SendInputSchema> =>
          index === 0 && replyTo !== undefined ? { ...part, reply_to_message_id: replyTo } : { ...part },
      );
      for (const [index, part] of parts.entries()) {
        checkReplaySend(part, state, `send_reply part ${index + 1}`);
      }
      state.dispatches.push({ tool_call_id: toolCallId, tool_name: 'send_reply', mode: 'synthetic' });
      checkReplayNotDuplicate(parts, state);
      checkReplayNotBypassed(parts, state);
      checkReplayNotRepeatingPrevious(parts, state);
      if (parts[0] !== undefined) {
        checkReplayReplyUnused(parts[0], state);
      }
      const messageIds = parts.map((part, index) => recordReplaySend(`${toolCallId}:${index + 1}`, part, state));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Sent ${messageIds.length} Telegram messages in order: ${messageIds.join(', ')}`,
          },
        ],
        details: { telegramMessageIds: messageIds },
      };
    },
  };
}

/** The current configuration's text and reply-target rules for one synthesized message. */
function checkReplaySend(input: Static<typeof SendInputSchema>, state: ReplayState, label: string): void {
  const narrowed = narrowSendInput(input);
  if ('problem' in narrowed) {
    throw new Error(`${label} input does not match its kind: ${narrowed.problem}`);
  }
  if (typeof input.text === 'string') {
    if (input.text.length > (state.options.maxTextLength ?? 4_096)) {
      throw new Error(`${label} text exceeds the current configured length limit`);
    }
    if (state.options.disallowBlankLines === true && /\n\s*\n/.test(input.text)) {
      throw new Error(`${label} text contains blank lines disallowed by current configuration`);
    }
  }
  if (
    typeof input.reply_to_message_id === 'string' &&
    state.options.replyMessageIds !== undefined &&
    !state.options.replyMessageIds.has(input.reply_to_message_id)
  ) {
    throw new Error('reply_to_message_id is not visible in this scene');
  }
}

/** The production duplicate send guard over this scene's synthesized sends; images are exempt there too. */
function checkReplayNotDuplicate(inputs: readonly Static<typeof SendInputSchema>[], state: ReplayState): void {
  const guard = state.options.duplicateSendGuard;
  if (guard === undefined) {
    return;
  }
  const sent = new Set(state.outputs.flatMap((output) => duplicateKey(output.arguments)));
  for (const input of inputs) {
    const [key] = duplicateKey(input);
    if (key === undefined) {
      continue;
    }
    if (sent.has(key)) {
      // Like production: repeating a published reply burns the content.
      const burned = replayContentKey(input);
      if (
        burned !== null &&
        state.options.allowReplyMessageMultipleTimes !== true &&
        typeof input.reply_to_message_id === 'string'
      ) {
        state.burnedContentKeys.add(burned);
      }
      guard.onRejected();
      throw new Error('Not sent: send_duplicate. This exact message was already published in this scene.');
    }
    sent.add(key);
  }
}

/**
 * The production guard's other half: a text or sticker may not repeat the
 * content of the message right before it (the scene's last output, or the
 * previous part) under another or no reply target.
 */
function checkReplayNotRepeatingPrevious(inputs: readonly Static<typeof SendInputSchema>[], state: ReplayState): void {
  const guard = state.options.duplicateSendGuard;
  if (guard === undefined) {
    return;
  }
  const last = state.outputs.at(-1);
  let previous = last === undefined ? null : replayContentKey(last.arguments);
  for (const input of inputs) {
    const key = replayContentKey(input);
    if (key !== null && key === previous) {
      if (state.options.allowReplyMessageMultipleTimes !== true && typeof input.reply_to_message_id === 'string') {
        state.burnedContentKeys.add(key);
      }
      guard.onRejected();
      throw new Error('Not sent: send_duplicate. The message right before it already published this content.');
    }
    previous = key;
  }
}

function duplicateKey(input: Record<string, unknown>): string[] {
  if (!SendInputValidator.Check(input)) {
    return [];
  }
  const narrowed = narrowSendInput(input);
  return 'problem' in narrowed || narrowed.send.kind === 'image' ? [] : [JSON.stringify(narrowed.send)];
}

/** Content key one scene send carries, identical to the production burn key. */
function replayContentKey(input: Record<string, unknown>): string | null {
  if (!SendInputValidator.Check(input)) {
    return null;
  }
  const narrowed = narrowSendInput(input);
  // Sticker search never runs in a scene, so no fresh ref can name a sticker
  // that another ref already names: the ref itself is the sticker's identity.
  return 'problem' in narrowed ? null : sendContentKey(narrowed.send, (ref) => ref);
}

/**
 * Mirrors the production reply-policy burn: content a `reply_already_sent`
 * rejection burned stays unsendable in this scene, retargeted or not.
 */
function checkReplayNotBypassed(inputs: readonly Static<typeof SendInputSchema>[], state: ReplayState): void {
  for (const input of inputs) {
    const key = replayContentKey(input);
    if (key !== null && state.burnedContentKeys.has(key)) {
      state.options.duplicateSendGuard?.onRejected();
      throw new Error(
        'Not sent: send_bypass. This exact message was already rejected by the reply policy in this scene.',
      );
    }
  }
}

function checkReplayReplyUnused(input: Record<string, unknown>, state: ReplayState): void {
  if (
    state.options.allowReplyMessageMultipleTimes !== true &&
    typeof input.reply_to_message_id === 'string' &&
    state.outputs.some((output) => output.reply_to_message_id === input.reply_to_message_id)
  ) {
    const key = replayContentKey(input);
    if (key !== null) {
      state.burnedContentKeys.add(key);
    }
    throw new Error('Not sent: reply_already_sent. This message has already been replied to in this scene.');
  }
}

function recordReplaySend(toolCallId: string, input: Record<string, unknown>, state: ReplayState): string {
  state.sends += 1;
  state.outputs.push({
    tool_call_id: toolCallId,
    tool_name: 'send',
    arguments: { ...input },
    reply_to_message_id: typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id : null,
  });
  return String(state.sends);
}
