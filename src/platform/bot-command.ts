import type { Message } from 'grammy/types';

/** Tokenization shared by control commands and model-facing /ask. */
export function botCommandToken(message: Message, botUsername: string | null): { name: string; length: number } | null {
  if (message.text === undefined) {
    return null;
  }
  const text = message.text;
  const entity = message.entities?.find((entry) => entry.type === 'bot_command' && entry.offset === 0);
  if (entity === undefined) {
    return null;
  }
  const token = text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) {
    return null;
  }
  return { name, length: entity.length };
}

export function isAsk(message: Message, botUsername: string | null): boolean {
  return (
    (message.sender_chat !== undefined || message.from?.is_bot !== true) &&
    botCommandToken(message, botUsername)?.name === 'ask'
  );
}

/** Revision one can itself be an edit when the original update was never received. */
export function isOriginalAsk(message: Message, botUsername: string | null): boolean {
  return message.edit_date === undefined && isAsk(message, botUsername);
}
