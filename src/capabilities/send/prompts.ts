/**
 * The configuration-dependent sentences shared by these tools' descriptions: the
 * reply policy and the text constraints the model must respect.
 *
 * Split out of send-tool.ts; the wording is unchanged.
 */

import type { SendToolEnvironment } from './support.ts';

/** What the reply policy allows in this configuration, in the model's terms. */
export function replyPolicyText(environment: SendToolEnvironment): string {
  return [
    environment.allowReplyMessageMultipleTimes === true
      ? 'Current configuration permits multiple replies to the same message; each send MUST still be warranted.'
      : 'Each message MAY receive at most one reply across text, stickers, and images, even across later invocations; changing the content or setting resend:true does not permit another reply. A pending or unknown earlier reply also blocks a new one. Once a send is rejected by this check, omitting or changing reply_to_message_id does not lift the rejection for the rest of the run.',
    environment.duplicateSendGuard === undefined
      ? ''
      : "A text or sticker identical to one already sent in this run is rejected, and so is repeating the previous message's text or sticker under another or no reply_to_message_id; you MUST NOT repeat a message that was sent.",
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

/** What the text may contain in this configuration, in the model's terms. */
export function textConstraintsText(environment: SendToolEnvironment): string {
  return [
    environment.maxTextLength === undefined
      ? 'Text MUST fit the schema limit.'
      : `Text MUST NOT exceed ${environment.maxTextLength} characters.`,
    environment.disallowBlankLines ? 'Text MUST NOT contain blank lines; use single newlines between paragraphs.' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}
