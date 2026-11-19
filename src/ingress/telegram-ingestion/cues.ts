/**
 * The ingestion-side entry to Telegram cue extraction: a live update's message
 * becomes the neutral `MessageCues` participation and the immediate-mention
 * check consume. Stored fragments go through `rawFragmentReader` instead.
 */

import type { Message } from 'grammy/types';
import type { BotIdentity, MessageCues } from '../../platform/im-host/cues.ts';
import { telegramCues } from '../../platform/telegram-markdown/cues.ts';

export function telegramMessageCues(message: Message, bot: BotIdentity): MessageCues {
  return telegramCues(message, bot);
}
