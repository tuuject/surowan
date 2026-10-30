/**
 * The body of a Telegram message as the model reads it: ordinary Markdown.
 *
 * Ingestion keeps a revision's `text` and `caption` exactly as Telegram sent
 * them (a rich message, which has no text, stores its flattened Markdown) and
 * the whole message in `raw_fragment_json`. The snapshot builder calls
 * `bodyFromFragment` to turn that pair into the frozen body: the Markdown, the
 * spoiler spans inside it, and where a rich message's pictures sit.
 *
 * All offsets are UTF-16 code units, the unit of both Telegram entities and
 * JavaScript string indexing (see `spoilers.ts`).
 */

import {
  type MessageSpoilers,
  normalizeSpoilerRanges,
  type SpoilerEntity,
  type SpoilerRange,
  spoilerRanges,
} from '../spoilers.ts';
import { entitiesMarkdown } from './entities.ts';
import { richMessagePlainText } from './matching.ts';
import { richMessageMarkdown } from './rich.ts';
import { isRecord, type MarkdownBody } from './shared.ts';

export { entitiesMarkdown } from './entities.ts';
export { type RichMention, richMessageMentions, richMessagePlainText } from './matching.ts';
export { type ImageDocument, isImageDocument, type RichMedia, type TelegramPhoto } from './rich-media.ts';
export { type RichMarkdown, richMessageMarkdown } from './rich.ts';

export interface RenderedBody {
  readonly text: string | null;
  readonly caption: string | null;
  /** Frozen visible text for literal matching, without Markdown syntax or link targets. */
  readonly match_text?: string[];
  readonly spoilers?: MessageSpoilers;
  /**
   * A rich message's media placeholders in `text`, one per stored media item
   * in media order. The context renderer puts each media line there.
   */
  readonly media_slots?: SpoilerRange[];
}

/**
 * Render a revision's stored body from its raw Telegram message.
 *
 * Formatting is only trusted while the fragment still carries exactly the
 * stored body (an edit gets its own revision and fragment); otherwise the
 * stored body is used as-is. Losing presentation must never fail an
 * invocation or change what the message says.
 */
export function bodyFromFragment(
  rawFragmentJson: string | null | undefined,
  stored: {
    readonly text: string | null;
    readonly caption: string | null;
    readonly reply_snapshot?: unknown;
    /** Media rows of the revision; slots are only kept when they match one to one. */
    readonly mediaCount: number;
  },
): RenderedBody {
  const fragment = parseFragment(rawFragmentJson);
  if (fragment === undefined) {
    return { text: stored.text, caption: stored.caption };
  }
  const text = textBody(fragment, stored.text, stored.mediaCount);
  const caption =
    stored.caption !== null && fragment.caption === stored.caption
      ? entitiesMarkdown(stored.caption, fragment.caption_entities)
      : undefined;
  const reply = replySpoilers(fragment.reply_to_message, stored.reply_snapshot);
  const spoilers: MessageSpoilers = {
    ...(text === undefined || text.spoilers.length === 0 ? {} : { text: text.spoilers }),
    ...(caption === undefined || caption.spoilers.length === 0 ? {} : { caption: caption.spoilers }),
    ...(reply.length === 0 ? {} : { reply }),
  };
  const renderedText = text?.text ?? stored.text;
  const renderedCaption = caption?.text ?? stored.caption;
  const plainText = text?.plainText ?? stored.text;
  return {
    text: renderedText,
    caption: renderedCaption,
    ...(plainText === renderedText && stored.caption === renderedCaption
      ? {}
      : {
          match_text: [plainText, stored.caption].filter(
            (value): value is string => value !== null && value.length > 0,
          ),
        }),
    ...(Object.keys(spoilers).length === 0 ? {} : { spoilers }),
    ...(text?.slots === undefined ? {} : { media_slots: text.slots }),
  };
}

function textBody(
  fragment: Record<string, unknown>,
  stored: string | null,
  mediaCount: number,
): (MarkdownBody & { readonly plainText?: string; readonly slots?: SpoilerRange[] }) | undefined {
  if (stored === null) {
    return undefined;
  }
  if (isRecord(fragment.rich_message)) {
    const rich = richMessageMarkdown(fragment.rich_message);
    if (rich.text !== stored) {
      return undefined;
    }
    return {
      text: rich.text,
      plainText: richMessagePlainText(fragment.rich_message),
      spoilers: rich.spoilers,
      ...(rich.slots.length > 0 && rich.slots.length === mediaCount ? { slots: rich.slots } : {}),
    };
  }
  return fragment.text === stored ? entitiesMarkdown(stored, fragment.entities) : undefined;
}

/**
 * The reply preview is the replied-to body cut to a prefix by the adapter, so
 * its spans are the replied-to message's own spoilers clamped to that prefix.
 * The preview stays plain text (a rich message's is its Markdown), and only a
 * preview that is still a prefix of the fragment's body is trusted.
 */
function replySpoilers(replyFragment: unknown, replySnapshot: unknown): SpoilerRange[] {
  if (!isRecord(replyFragment) || !isRecord(replySnapshot)) {
    return [];
  }
  const { content } = replySnapshot;
  const { text, entities, caption, caption_entities, rich_message } = replyFragment;
  const source =
    typeof text === 'string'
      ? { text, spoilers: spoilerRanges(readEntities(entities), text.length) }
      : typeof caption === 'string'
        ? { text: caption, spoilers: spoilerRanges(readEntities(caption_entities), caption.length) }
        : isRecord(rich_message)
          ? richMessageMarkdown(rich_message)
          : undefined;
  if (typeof content !== 'string' || source === undefined || !source.text.startsWith(content)) {
    return [];
  }
  return normalizeSpoilerRanges(source.spoilers, content.length);
}

function parseFragment(rawFragmentJson: string | null | undefined): Record<string, unknown> | undefined {
  if (rawFragmentJson === null || rawFragmentJson === undefined || rawFragmentJson === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFragmentJson);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function readEntities(value: unknown): SpoilerEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entities: SpoilerEntity[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const { type, offset, length } = item;
    if (typeof type !== 'string' || typeof offset !== 'number' || typeof length !== 'number') {
      continue;
    }
    entities.push({ type, offset, length });
  }
  return entities;
}
