/**
 * The trigger cues a Telegram message carries, read off the message shape.
 *
 * The input is a structural subset of the Telegram `Message` — the same fields
 * a parsed `raw_fragment_json` record exposes — so live updates, stored
 * revisions and catch-up backlog rows all answer the same questions. Every
 * field is read defensively: a fragment that lost its shape degrades to no
 * cues, never a crash.
 */

import type { BotIdentity, MessageCues } from '../im-host/cues.ts';
import { richMessageMentions, richMessagePlainText } from './matching.ts';
import { isRecord } from './shared.ts';

/** The fields of a Telegram `Message` the cues inspect; a grammy `Message` and a parsed fragment both satisfy it. */
export interface TelegramCueSource {
  readonly text?: unknown;
  readonly caption?: unknown;
  readonly entities?: unknown;
  readonly caption_entities?: unknown;
  readonly rich_message?: unknown;
  readonly reply_to_message?: unknown;
  readonly from?: unknown;
  readonly sender_chat?: unknown;
  readonly edit_date?: unknown;
}

/** Cues for a stored revision's `raw_fragment_json`; anything malformed yields no cues. */
export function cuesFromFragment(rawFragmentJson: string | null | undefined, bot: BotIdentity): MessageCues {
  const parsed = parseFragment(rawFragmentJson);
  // A stored revision's ask is the *original* ask: revision one can itself be
  // an edit when the original update was never received.
  return parsed === null ? EMPTY_CUES : { ...telegramCues(parsed, bot), asksBot: originalAsk(parsed, bot) };
}

/**
 * Only the original-ask cue of a stored fragment. Backlog scans that answer
 * "was this message an ask" never walk mention entities or rich text.
 */
export function asksFromFragment(rawFragmentJson: string | null | undefined, bot: BotIdentity): boolean {
  const parsed = parseFragment(rawFragmentJson);
  return parsed !== null && originalAsk(parsed, bot);
}

function parseFragment(rawFragmentJson: string | null | undefined): Record<string, unknown> | null {
  if (rawFragmentJson === null || rawFragmentJson === undefined || rawFragmentJson === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFragmentJson);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** The original-ask rule for a stored revision: an edited-in ask does not count. */
function originalAsk(source: TelegramCueSource, bot: BotIdentity): boolean {
  return source.edit_date === undefined && isAsk(source, bot.username);
}

/** The cues one live Telegram message carries. */
export function telegramCues(source: TelegramCueSource, bot: BotIdentity): MessageCues {
  return {
    mentionsBot: mentionsBot(source, bot),
    repliesToBot: repliesToBot(source, bot),
    // The update kind, not an edit_date inside the payload, decides the edit
    // path: a live `message` is judged by the same isAsk the ignore bypass uses.
    asksBot: isAsk(source, bot.username),
    texts: searchableTexts(source),
  };
}

const EMPTY_CUES: MessageCues = { mentionsBot: false, repliesToBot: false, asksBot: false, texts: [] };

/**
 * Whether the message @-mentions the bot by username or by a text mention of
 * its id, in its text, its caption, or anywhere in a rich message.
 */
export function mentionsBot(source: TelegramCueSource, bot: BotIdentity): boolean {
  const username = bot.username?.toLowerCase() ?? null;
  if (
    source.rich_message !== undefined &&
    richMessageMentions(source.rich_message).some((mention) =>
      mention.kind === 'user' ? sameUserId(mention.id, bot.id) : mention.username.toLowerCase() === username,
    )
  ) {
    return true;
  }
  // `entities` offsets index `text`; `caption_entities` offsets index `caption`.
  const sources = [
    [source.text, source.entities],
    [source.caption, source.caption_entities],
  ] as const;
  for (const [content, entities] of sources) {
    if (!Array.isArray(entities)) {
      continue;
    }
    for (const entity of entities) {
      if (!isRecord(entity)) {
        continue;
      }
      if (entity.type === 'text_mention') {
        if (isRecord(entity.user) && sameUserId(entity.user.id, bot.id)) {
          return true;
        }
        continue;
      }
      // A plain `mention` only carries "@username" text, so the token must be
      // compared against this bot's username rather than trusted as-is.
      if (entity.type !== 'mention' || username === null || typeof content !== 'string') {
        continue;
      }
      if (
        typeof entity.offset === 'number' &&
        typeof entity.length === 'number' &&
        content
          .slice(entity.offset, entity.offset + entity.length)
          .slice(1)
          .toLowerCase() === username
      ) {
        return true;
      }
    }
  }
  return false;
}

function repliesToBot(source: TelegramCueSource, bot: BotIdentity): boolean {
  const reply = source.reply_to_message;
  return isRecord(reply) && isRecord(reply.from) && sameUserId(reply.from.id, bot.id);
}

/** Fractional or overflowing numbers are not ids: they match nobody, they never throw. */
function sameUserId(id: unknown, botId: bigint): boolean {
  return typeof id === 'number' && Number.isSafeInteger(id) && BigInt(id) === botId;
}

/** The strings keyword rules search: text, caption, then a rich message's visible text. */
function searchableTexts(source: TelegramCueSource): readonly string[] {
  const texts: string[] = [];
  for (const content of [source.text, source.caption]) {
    if (typeof content === 'string') {
      texts.push(content);
    }
  }
  // A rich message has no text; its visible text stands in for it.
  if (source.rich_message !== undefined) {
    texts.push(richMessagePlainText(source.rich_message));
  }
  return texts;
}

/** Tokenization shared by control commands and model-facing /ask. */
export function botCommandToken(
  source: TelegramCueSource,
  botUsername: string | null,
): { name: string; length: number } | null {
  if (typeof source.text !== 'string') {
    return null;
  }
  const entities = Array.isArray(source.entities) ? source.entities : [];
  const entity = entities.find((entry) => isRecord(entry) && entry.type === 'bot_command' && entry.offset === 0);
  if (!isRecord(entity) || typeof entity.length !== 'number') {
    return null;
  }
  const token = source.text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) {
    return null;
  }
  return { name, length: entity.length };
}

export function isAsk(source: TelegramCueSource, botUsername: string | null): boolean {
  const senderIsBot = isRecord(source.from) && source.from.is_bot === true;
  return (source.sender_chat !== undefined || !senderIsBot) && botCommandToken(source, botUsername)?.name === 'ask';
}
