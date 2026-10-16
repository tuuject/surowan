/**
 * Telegram spoiler spans, shared by the message snapshot and the context
 * renderer.
 *
 * A spoiler is a Telegram MessageEntity of type `spoiler` over a slice of the
 * message body (the text, or the caption of a media message). The adapter
 * (`ingress/telegram-ingestion.ts`) keeps only the body text on a revision, so
 * the entity detail that survives is the revision's `raw_fragment_json`; the
 * spans are recovered from it here when the invocation snapshot is built. The
 * body itself is never rewritten, and no schema or prompt-side storage is
 * needed to carry the information.
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
 * carries a text or a caption, never both, so at most one field is present, and
 * a field is omitted entirely when it has no spoiler.
 */
export interface MessageSpoilers {
  readonly text?: readonly SpoilerRange[];
  readonly caption?: readonly SpoilerRange[];
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
 * Recover the spoiler spans of a revision from its stored raw Telegram message.
 *
 * The adapter stores the raw message fragment verbatim and derives `text` and
 * `caption` from it, so an entity list is only trusted when the fragment still
 * carries exactly the body it belongs to; a fragment that disagrees (or is
 * unreadable) simply yields no span. Losing presentation must never fail an
 * invocation or change a message the model would otherwise read.
 */
export function spoilersFromFragment(
  rawFragmentJson: string | null | undefined,
  body: { readonly text: string | null; readonly caption: string | null },
): MessageSpoilers | undefined {
  const fragment = parseFragment(rawFragmentJson);
  if (fragment === undefined) {
    return undefined;
  }
  const text =
    body.text !== null && fragment.text === body.text
      ? spoilerRanges(readEntities(fragment.entities), body.text.length)
      : [];
  const caption =
    body.caption !== null && fragment.caption === body.caption
      ? spoilerRanges(readEntities(fragment.caption_entities), body.caption.length)
      : [];
  if (text.length === 0 && caption.length === 0) {
    return undefined;
  }
  return {
    ...(text.length === 0 ? {} : { text }),
    ...(caption.length === 0 ? {} : { caption }),
  };
}

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
 * Wrap every spoiler span of a body in `<tg-spoiler>` tags, leaving the rest of
 * the text untouched. The spoiler text is preserved verbatim: the model sees
 * what the sender wrote plus the information that a human chose to fold it.
 */
export function renderSpoilers(body: string, ranges: readonly SpoilerRange[] | undefined): string {
  const spans = normalizeSpoilerRanges(ranges ?? [], body.length);
  if (spans.length === 0) {
    return body;
  }
  let rendered = '';
  let cursor = 0;
  for (const span of spans) {
    rendered += body.slice(cursor, span.start);
    rendered += SPOILER_TAG_OPEN + body.slice(span.start, span.end) + SPOILER_TAG_CLOSE;
    cursor = span.end;
  }
  return rendered + body.slice(cursor);
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function readEntities(value: unknown): SpoilerEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entities: SpoilerEntity[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const { type, offset, length } = item as { type?: unknown; offset?: unknown; length?: unknown };
    if (typeof type !== 'string' || typeof offset !== 'number' || typeof length !== 'number') {
      continue;
    }
    entities.push({ type, offset, length });
  }
  return entities;
}

function clamp(offset: number, bodyLength: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(offset), 0), bodyLength);
}
