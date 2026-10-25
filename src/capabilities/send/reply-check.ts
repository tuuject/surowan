/**
 * Every check a multi-part reply runs before its first part is published, so a
 * predictable rejection never leaves half a reply behind.
 *
 * Split out of send-tool.ts's createSendReplyTool; the checks and their order
 * are unchanged, and the caller supplies the rejection that records them.
 */

import type { Static } from 'typebox';
import type { SendReplyInputSchema } from './index.ts';
import { isDuplicateSend, repeatsLastSend, sendContentKey, wasRejectedByReplyPolicy } from './guards.ts';
import { narrowSendInput, type SendToolEnvironment } from './support.ts';

export function checkReplyParts(
  environment: SendToolEnvironment,
  input: Static<typeof SendReplyInputSchema>,
  reject: (errorCode: string, message: string) => never,
): void {
  const partKeys = new Set<string>();
  let previousPartKey: string | null = null;
  for (const [index, part] of input.parts.entries()) {
    const label = `part ${index + 1}`;
    const narrowed = narrowSendInput(
      index === 0 && input.reply_to_message_id !== undefined
        ? { ...part, reply_to_message_id: input.reply_to_message_id }
        : part,
    );
    if ('problem' in narrowed) {
      reject('send_input_invalid', `${label} does not match its kind: ${narrowed.problem}`);
    }
    const { send } = narrowed;
    // A part 1 repeating a published reply is left to deliver(): its
    // send_duplicate row then burns the content like a single send's.
    // Nothing goes out either way, since part 1 is the first to send.
    const leftToDeliver = send.reply_to_message_id !== undefined && environment.allowReplyMessageMultipleTimes !== true;
    if (environment.duplicateSendGuard !== undefined && send.kind !== 'image') {
      const key = JSON.stringify(send);
      if (partKeys.has(key) || (!leftToDeliver && isDuplicateSend(environment, send))) {
        environment.duplicateSendGuard.onRejected();
        reject(
          'send_duplicate',
          `${label} repeats a message already published in this run or an earlier part; do not send it again`,
        );
      }
      partKeys.add(key);
    }
    if (wasRejectedByReplyPolicy(environment, send)) {
      environment.duplicateSendGuard?.onRejected();
      reject(
        'send_bypass',
        `${label} was already rejected by the reply policy in this run; omitting or changing reply_to_message_id does not lift it`,
      );
    }
    if (environment.duplicateSendGuard !== undefined) {
      // Part 1 follows the run's last send; each later part follows the part before it.
      const contentKey = sendContentKey(send, environment.capabilities.resolveStickerRef);
      const repeatsPrevious =
        index === 0
          ? !leftToDeliver && repeatsLastSend(environment, send)
          : contentKey !== null && contentKey === previousPartKey;
      if (repeatsPrevious) {
        environment.duplicateSendGuard.onRejected();
        reject('send_duplicate', `${label} repeats the content of the message right before it; do not send it again`);
      }
      previousPartKey = contentKey;
    }
    if (send.kind === 'text') {
      if (environment.maxTextLength !== undefined && send.text.length > environment.maxTextLength) {
        reject(
          'send_text_too_long',
          `${label} text length ${send.text.length} exceeds the configured limit of ${environment.maxTextLength} characters`,
        );
      }
      if (environment.disallowBlankLines && /\n[ \t]*\n/.test(send.text)) {
        reject('send_blank_lines', `${label} text must not contain blank lines`);
      }
    } else if (send.kind === 'sticker') {
      if (environment.capabilities.resolveStickerRef(send.sticker_ref) === undefined) {
        reject('sticker_ref_not_authorized', `${label} sticker_ref is not authorized in this conversation context`);
      }
    } else {
      if ((send.text?.length ?? 0) > 1024) {
        reject('send_caption_too_long', `${label} image caption must not exceed 1024 characters`);
      }
      let pictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>;
      try {
        pictures = environment.imageGeneration?.resolve(send.image_generation_id, environment.context.conversationId);
      } catch {
        reject('image_generation_unavailable', `${label} generated output files could not be read`);
      }
      if (pictures === undefined || pictures.length === 0) {
        reject(
          'image_generation_not_authorized',
          `${label} image_generation_id does not name a finished generation of this conversation`,
        );
      }
    }
  }
}
