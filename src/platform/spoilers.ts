/**
 * Telegram spoiler spans, shared by the message snapshot and the context
 * renderer.
 *
 * A spoiler is a Telegram MessageEntity of type `spoiler` (or a rich-text
 * spoiler run) over a slice of the message body. The spans are recovered from
 * the revision's `raw_fragment_json` together with the rest of the formatting
 * (`telegram-markdown/`) when the invocation snapshot is built, as ranges into
 * the Markdown body, and become `<tg-spoiler>` tags only here, after escaping.
 *
 * Offsets are UTF-16 code units counted from the start of the body they belong
 * to. Telegram's Bot API also reports entity offsets and lengths in UTF-16 code
 * units, and JavaScript string indexing and `slice` use that same unit, so the
 * two line up without conversion: `body.slice(start, end)` is always the
 * spoiler text. Never rebuild these offsets from code points (`Array.from`,
 * `for..of`, spread, `Intl.Segmenter`): a single emoji before a spoiler would
 * shift every later offset and silently move the markup.
 */

export interface SpoilerRange {
  /** Inclusive UTF-16 code unit offset into the body. */
  readonly start: number;
  /** Exclusive UTF-16 code unit offset into the body. */
  readonly end: number;
}

/**
 * Spoiler ranges keyed by the body field they belong to. A Telegram message
 * carries a text or a caption, never both, so at most one of them is present,
 * and a field is omitted entirely when it has no spoiler. `reply` covers the
 * stored reply preview (`reply_snapshot.content`), which quotes the replied-to
 * body and would otherwise show its folded text unmarked.
 */
export interface MessageSpoilers {
  readonly text?: SpoilerRange[];
  readonly caption?: SpoilerRange[];
  readonly reply?: SpoilerRange[];
}

/** The part of a Telegram message entity that spoiler extraction cares about. */
export interface SpoilerEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

export const SPOILER_TAG_OPEN = '<tg-spoiler>';
export const SPOILER_TAG_CLOSE = '</tg-spoiler>';

/**
 * Extract the spoiler ranges of one Telegram entity list, clamped to the body
 * it belongs to. Entries that are malformed, out of range, or empty are
 * dropped; overlapping ranges are merged into one, so the result is sorted and
 * non-overlapping and always renders as balanced markup.
 */
export function spoilerRanges(entities: readonly SpoilerEntity[] | undefined, bodyLength: number): SpoilerRange[] {
  const ranges: SpoilerRange[] = [];
  for (const entity of entities ?? []) {
    if (entity.type !== 'spoiler') {
      continue;
    }
    if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length)) {
      continue;
    }
    if (entity.offset < 0 || entity.length <= 0 || entity.offset >= bodyLength) {
      continue;
    }
    ranges.push({ start: entity.offset, end: Math.min(entity.offset + entity.length, bodyLength) });
  }
  return normalizeSpoilerRanges(ranges, bodyLength);
}

/** Sort, clamp, and merge ranges into a canonical non-overlapping set. */
export function normalizeSpoilerRanges(ranges: readonly SpoilerRange[], bodyLength: number): SpoilerRange[] {
  const sorted = ranges
    .map((range) => ({ start: clamp(range.start, bodyLength), end: clamp(range.end, bodyLength) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SpoilerRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: range.end };
      }
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/**
 * Escape the five XML predefined entities in untrusted batch text so user or
 * stored strings cannot forge runtime XML tags.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Restore the five XML predefined entities when reading back a rendered header. */
export function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

/**
 * Escape XML entities in a body and wrap every spoiler span in `<tg-spoiler>`
 * tags. Slicing by Telegram's UTF-16 offsets before escaping each slice gives
 * the exact same result as adding `<tg-spoiler>` after escaping while keeping
 * UTF-16 offsets aligned; literal `<tg-spoiler>` typed by a user is escaped.
 */
export function renderSpoilers(body: string, ranges: readonly SpoilerRange[] | undefined): string {
  const spans = normalizeSpoilerRanges(ranges ?? [], body.length);
  if (spans.length === 0) {
    return escapeXml(body);
  }
  let rendered = '';
  let cursor = 0;
  for (const span of spans) {
    rendered += escapeXml(body.slice(cursor, span.start));
    rendered += SPOILER_TAG_OPEN + escapeXml(body.slice(span.start, span.end)) + SPOILER_TAG_CLOSE;
    cursor = span.end;
  }
  return rendered + escapeXml(body.slice(cursor));
}

function clamp(offset: number, bodyLength: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(offset), 0), bodyLength);
}
