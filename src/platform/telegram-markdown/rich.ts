/**
 * A Telegram rich message (`Message.rich_message`), flattened to Markdown.
 *
 * A rich message has no `text`: its content is a tree of blocks (headings,
 * lists, tables, quotes, media) holding rich text runs. This renders the tree
 * as the ordinary Markdown a reader would expect, so the model can read the
 * document. Photos and image Documents inside it become the message's media,
 * in document order; the Markdown keeps a placeholder at each of them (a
 * "slot") that the context renderer replaces with the media line. Other media
 * kinds stay a short bracketed placeholder, since nothing downstream reads
 * them.
 *
 * The flattening is deterministic: ingestion stores its text on the revision,
 * and the snapshot builder runs it again on the raw fragment to recover the
 * spoiler and slot ranges, trusting them only while the text still matches.
 */

import { normalizeSpoilerRanges, type SpoilerRange } from '../spoilers.ts';
import { codeFence, fenceLanguage, inlineCode, isRecord, linkTarget, type MarkdownBody } from './shared.ts';

const IMAGE_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Telegram allows 16 levels; anything deeper is malformed data, not a message. */
const MAX_DEPTH = 32;
/** Telegram allows 20 columns; a wider grid can only come from bad spans. */
const MAX_TABLE_COLUMNS = 20;

/** The part of a Telegram PhotoSize the runtime stores. */
export interface TelegramPhoto {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

/** The part of a Telegram Document the runtime stores, once it is known to be an image. */
export interface ImageDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly mime_type: string;
  readonly file_size: number;
  readonly thumbnail?: { readonly width: number; readonly height: number };
}

/** A Document the runtime reads like a photo. */
export function isImageDocument<T extends { readonly mime_type?: string; readonly file_size?: number }>(
  document: T,
): document is T & { readonly mime_type: string; readonly file_size: number } {
  return (
    document.mime_type !== undefined &&
    IMAGE_DOCUMENT_TYPES.has(document.mime_type) &&
    document.file_size !== undefined &&
    document.file_size <= MAX_IMAGE_DOCUMENT_BYTES
  );
}

export type RichMedia =
  | { readonly kind: 'photo'; readonly photo: TelegramPhoto }
  | { readonly kind: 'document'; readonly document: ImageDocument };

export interface RichMarkdown extends MarkdownBody {
  /** One placeholder range per entry of `media`, in the same order. */
  readonly slots: SpoilerRange[];
  readonly media: readonly RichMedia[];
}

interface Piece {
  readonly text: string;
  readonly spoiler: boolean;
  /** The placeholder of one stored media item. */
  readonly slot: boolean;
}

type Line = readonly Piece[];

export function richMessageMarkdown(value: unknown): RichMarkdown {
  const media: RichMedia[] = [];
  const lines = isRecord(value) ? blockList(value.blocks, media, 0, true) : [];
  let text = '';
  const spoilers: SpoilerRange[] = [];
  const slots: SpoilerRange[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      text += '\n';
    }
    for (const piece of line) {
      const start = text.length;
      text += piece.text;
      if (piece.slot) {
        slots.push({ start, end: text.length });
      } else if (piece.spoiler) {
        spoilers.push({ start, end: text.length });
      }
    }
  });
  return { text, spoilers: normalizeSpoilerRanges(spoilers, text.length), slots, media };
}

/** Blocks in order; `loose` separates them with a blank line, as top-level paragraphs are. */
function blockList(value: unknown, media: RichMedia[], depth: number, loose: boolean): Line[] {
  if (!Array.isArray(value) || depth > MAX_DEPTH) {
    return [];
  }
  const lines: Line[] = [];
  for (const item of value) {
    const rendered = trimBlankLines(block(item, media, depth + 1));
    if (rendered.length === 0) {
      continue;
    }
    if (loose && lines.length > 0) {
      lines.push([]);
    }
    lines.push(...rendered);
  }
  return lines;
}

function block(value: unknown, media: RichMedia[], depth: number): Line[] {
  if (!isRecord(value)) {
    return [];
  }
  const text = (field: unknown): Piece[] => inline(field, false, depth);
  switch (value.type) {
    case 'paragraph':
    case 'footer':
      return lines(text(value.text));
    case 'heading': {
      const title = oneLine(text(value.text));
      const size = typeof value.size === 'number' ? Math.min(Math.max(Math.trunc(value.size), 1), 6) : 1;
      return title.length === 0 ? [] : [[plain(`${'#'.repeat(size)} `), ...title]];
    }
    case 'pre':
      return codeBlock(plainText(text(value.text)), fenceLanguage(value.language));
    case 'divider':
      return [[plain('---')]];
    case 'mathematical_expression':
      return typeof value.expression === 'string'
        ? [[plain('$$')], ...value.expression.split('\n').map((line) => [plain(line)]), [plain('$$')]]
        : [];
    case 'list':
      return list(value.items, media, depth);
    case 'blockquote':
      return quote([...blockList(value.blocks, media, depth, true), ...credit(value.credit, depth)]);
    case 'expandable_blockquote':
    case 'pullquote':
      return quote([...lines(text(value.text)), ...credit(value.credit, depth)]);
    case 'collage':
    case 'slideshow':
      return [...blockList(value.blocks, media, depth, false), ...caption(value.caption, depth)];
    case 'table':
      return table(value, depth);
    case 'details':
      return [[...wrap('**', oneLine(text(value.summary)), false)], [], ...blockList(value.blocks, media, depth, true)];
    case 'map':
      return [[plain(mapLabel(value.location))], ...caption(value.caption, depth)];
    case 'photo':
      return [[photoSlot(value.photo, media)], ...caption(value.caption, depth)];
    case 'document':
      return [[documentSlot(value.document, media)], ...caption(value.caption, depth)];
    case 'audio':
      return [[plain(audioLabel(value.audio))], ...caption(value.caption, depth)];
    case 'animation':
      return [[plain('[animation]')], ...caption(value.caption, depth)];
    case 'video':
      return [[plain('[video]')], ...caption(value.caption, depth)];
    case 'voice_note':
      return [[plain('[voice note]')], ...caption(value.caption, depth)];
    case 'buttons':
      return Array.isArray(value.buttons)
        ? lines(
            value.buttons.flatMap((button, index) => [
              ...(index > 0 ? [plain(' ')] : []),
              ...buttonPieces(button, false, depth),
            ]),
          )
        : [];
    // An anchor is only a link target, and a "Thinking…" block only exists in
    // drafts; neither is content.
    case 'anchor':
    case 'thinking':
      return [];
    default:
      return Array.isArray(value.blocks) ? blockList(value.blocks, media, depth, true) : lines(text(value.text));
  }
}

function list(items: unknown, media: RichMedia[], depth: number): Line[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const lines: Line[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const marker = listMarker(item);
    const body = blockList(item.blocks, media, depth, false);
    lines.push(...prefix(body.length === 0 ? [[]] : body, marker, ' '.repeat(marker.length)));
  }
  return lines;
}

/** Telegram supplies the visible label ("•", "1.", "a."); bullets become `-`, ordinals stay. */
function listMarker(item: Record<string, unknown>): string {
  const label = typeof item.label === 'string' ? item.label.trim() : '';
  const bullet = label === '' || /^[•◦▪▫‣⁃∙·*+\-–—]$/u.test(label) ? '-' : /[.)]$/.test(label) ? label : `${label}.`;
  const checkbox = item.has_checkbox === true ? (item.is_checked === true ? ' [x]' : ' [ ]') : '';
  return `${bullet}${checkbox} `;
}

function quote(lines: readonly Line[]): Line[] {
  return prefix(lines, '> ', '> ');
}

function credit(value: unknown, depth: number): Line[] {
  const pieces = inline(value, false, depth);
  return pieces.length === 0 ? [] : lines([plain('— '), ...pieces]);
}

function caption(value: unknown, depth: number): Line[] {
  if (!isRecord(value)) {
    return [];
  }
  const text = inline(value.text, false, depth);
  const by = inline(value.credit, false, depth);
  return lines(by.length === 0 ? text : [...text, plain(' — '), ...by]);
}

function codeBlock(code: string, language: string): Line[] {
  const fence = codeFence(code, 3);
  return [[plain(`${fence}${language}`)], ...code.split('\n').map((line) => [plain(line)]), [plain(fence)]];
}

function table(value: Record<string, unknown>, depth: number): Line[] {
  const rows = Array.isArray(value.cells) ? value.cells.filter((row): row is unknown[] => Array.isArray(row)) : [];
  // HTML table layout: a cell spanning rows or columns occupies those grid
  // positions, so later cells of an affected row move right past them.
  const grid = new Map<string, Piece[]>();
  let columns = 0;
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row) {
      while (grid.has(`${rowIndex}:${column}`)) {
        column += 1;
      }
      if (column >= MAX_TABLE_COLUMNS) {
        break;
      }
      const entry = isRecord(cell) ? cell : {};
      const colspan = spanCount(entry.colspan, MAX_TABLE_COLUMNS - column);
      const rowspan = spanCount(entry.rowspan, rows.length - rowIndex);
      for (let down = 0; down < rowspan; down += 1) {
        for (let across = 0; across < colspan; across += 1) {
          const content = down === 0 && across === 0 ? tableCell(inline(entry.text, false, depth)) : [];
          grid.set(`${rowIndex + down}:${column + across}`, content);
        }
      }
      column += colspan;
      columns = Math.max(columns, column);
    }
  });
  if (columns === 0) {
    return [];
  }
  const rowLine = (rowIndex: number): Line => {
    const pieces: Piece[] = [plain('|')];
    for (let column = 0; column < columns; column += 1) {
      pieces.push(plain(' '), ...(grid.get(`${rowIndex}:${column}`) ?? []), plain(' |'));
    }
    return pieces;
  };
  const first = rows[0] ?? [];
  const headed = first.length > 0 && first.every((cell) => isRecord(cell) && cell.is_header === true);
  const header: Line = headed ? rowLine(0) : [plain(`|${'  |'.repeat(columns)}`)];
  const body: Line[] = [];
  for (let rowIndex = headed ? 1 : 0; rowIndex < rows.length; rowIndex += 1) {
    body.push(rowLine(rowIndex));
  }
  const title = oneLine(inline(value.caption, false, depth));
  return [...(title.length === 0 ? [] : [title, []]), header, [plain(`|${' --- |'.repeat(columns)}`)], ...body];
}

function spanCount(value: unknown, limit: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? Math.min(value, Math.max(limit, 1)) : 1;
}

/** A table cell holds one line, and a literal pipe would end it. */
function tableCell(pieces: readonly Piece[]): Piece[] {
  return oneLine(pieces).map((piece) => ({ ...piece, text: piece.text.replaceAll('|', '\\|') }));
}

function photoSlot(value: unknown, media: RichMedia[]): Piece {
  // Telegram lists sizes smallest first; like a photo message, only the
  // largest is kept.
  const photo = Array.isArray(value) ? value.at(-1) : undefined;
  if (!isPhotoSize(photo)) {
    return plain('[photo]');
  }
  media.push({ kind: 'photo', photo });
  return { text: '[photo]', spoiler: false, slot: true };
}

function documentSlot(value: unknown, media: RichMedia[]): Piece {
  if (!isRecord(value)) {
    return plain('[document]');
  }
  const name = typeof value.file_name === 'string' ? singleLine(value.file_name) : '';
  const label = name.length === 0 ? '[document]' : `[document: ${name}]`;
  if (!isFileRecord(value) || (value.thumbnail !== undefined && !hasSize(value.thumbnail))) {
    return plain(label);
  }
  const document = value as unknown as Omit<ImageDocument, 'mime_type' | 'file_size'> & {
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  if (!isImageDocument(document)) {
    return plain(label);
  }
  media.push({ kind: 'document', document });
  return { text: label, spoiler: false, slot: true };
}

function isPhotoSize(value: unknown): value is TelegramPhoto {
  return isFileRecord(value) && hasSize(value);
}

function hasSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    Number.isInteger(value.width) &&
    typeof value.height === 'number' &&
    Number.isInteger(value.height)
  );
}

function isFileRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.file_id === 'string' &&
    typeof value.file_unique_id === 'string' &&
    (value.file_size === undefined || (typeof value.file_size === 'number' && Number.isInteger(value.file_size))) &&
    (value.mime_type === undefined || typeof value.mime_type === 'string')
  );
}

function audioLabel(value: unknown): string {
  if (!isRecord(value)) {
    return '[audio]';
  }
  const performer = typeof value.performer === 'string' ? singleLine(value.performer) : '';
  const title = typeof value.title === 'string' ? singleLine(value.title) : '';
  const name = typeof value.file_name === 'string' ? singleLine(value.file_name) : '';
  const label = [performer, title].filter((part) => part.length > 0).join(' – ') || name;
  return label.length === 0 ? '[audio]' : `[audio: ${label}]`;
}

function mapLabel(value: unknown): string {
  if (!isRecord(value) || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') {
    return '[map]';
  }
  return `[map: ${value.latitude}, ${value.longitude}]`;
}

function inline(value: unknown, spoiler: boolean, depth: number): Piece[] {
  if (typeof value === 'string') {
    return value.length === 0 ? [] : [{ text: value, spoiler, slot: false }];
  }
  if (depth > MAX_DEPTH) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => inline(item, spoiler, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const inner = (hidden = spoiler): Piece[] => inline(value.text, hidden, depth + 1);
  const mark = (text: string): Piece => ({ text, spoiler, slot: false });
  switch (value.type) {
    case 'bold':
      return wrap('**', inner(), spoiler);
    case 'italic':
      return wrap('_', inner(), spoiler);
    case 'strikethrough':
      return wrap('~~', inner(), spoiler);
    case 'marked':
      return wrap('==', inner(), spoiler);
    case 'superscript':
      return wrap('^', inner(), spoiler);
    case 'subscript':
      return wrap('~', inner(), spoiler);
    case 'spoiler':
      return inner(true);
    case 'code': {
      const code = plainText(inner());
      return code.length === 0 ? [] : [mark(inlineCode(code))];
    }
    case 'custom_emoji':
      return typeof value.alternative_text === 'string' && value.alternative_text.length > 0
        ? [mark(value.alternative_text)]
        : [];
    case 'mathematical_expression':
      return typeof value.expression === 'string' && value.expression.length > 0 ? [mark(`$${value.expression}$`)] : [];
    case 'text_mention':
      return isRecord(value.user) && typeof value.user.id === 'number'
        ? link(inner(), `tg://user?id=${value.user.id}`, spoiler)
        : inner();
    case 'url':
      return typeof value.url === 'string' ? autoLink(inner(), value.url, spoiler) : inner();
    case 'email_address':
      return typeof value.email_address === 'string'
        ? autoLink(inner(), `mailto:${value.email_address}`, spoiler)
        : inner();
    case 'phone_number':
      return typeof value.phone_number === 'string' ? autoLink(inner(), `tel:${value.phone_number}`, spoiler) : inner();
    case 'anchor_link':
      return typeof value.anchor_name === 'string' ? link(inner(), `#${value.anchor_name}`, spoiler) : inner();
    case 'reference_link':
      return typeof value.reference_name === 'string' ? link(inner(), `#${value.reference_name}`, spoiler) : inner();
    case 'button':
      return buttonPieces(value.button, spoiler, depth);
    case 'anchor':
      return [];
    // Underline, date and time, references, and Telegram's own detected
    // mentions, hashtags, cashtags, commands and card numbers read as their text.
    default:
      return inner();
  }
}

function buttonPieces(value: unknown, spoiler: boolean, depth: number): Piece[] {
  if (!isRecord(value)) {
    return [];
  }
  const label = inline(value.text, spoiler, depth + 1);
  const target =
    typeof value.url === 'string'
      ? value.url
      : isRecord(value.web_app) && typeof value.web_app.url === 'string'
        ? value.web_app.url
        : isRecord(value.login_url) && typeof value.login_url.url === 'string'
          ? value.login_url.url
          : null;
  return target === null
    ? [{ text: '[', spoiler, slot: false }, ...label, { text: ']', spoiler, slot: false }]
    : link(label, target, spoiler);
}

function wrap(marker: string, pieces: Piece[], spoiler: boolean): Piece[] {
  return pieces.length === 0
    ? []
    : [{ text: marker, spoiler, slot: false }, ...pieces, { text: marker, spoiler, slot: false }];
}

function link(label: Piece[], target: string, spoiler: boolean): Piece[] {
  return [{ text: '[', spoiler, slot: false }, ...label, { text: `](${linkTarget(target)})`, spoiler, slot: false }];
}

/** A detected link whose text already is its address reads best as the bare text. */
function autoLink(label: Piece[], target: string, spoiler: boolean): Piece[] {
  const bare = (value: string): string => value.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '').replace(/\/$/, '');
  return bare(plainText(label)) === bare(target) ? label : link(label, target, spoiler);
}

function plain(text: string): Piece {
  return { text, spoiler: false, slot: false };
}

function plainText(pieces: readonly Piece[]): string {
  return pieces.map((piece) => piece.text).join('');
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function oneLine(pieces: readonly Piece[]): Piece[] {
  return pieces.map((piece) => ({ ...piece, text: piece.text.replace(/\s*\n\s*/g, ' ') }));
}

/** Splits pieces at their newlines; a run of text with no pieces has no lines at all. */
function lines(pieces: readonly Piece[]): Line[] {
  if (pieces.length === 0) {
    return [];
  }
  const result: Piece[][] = [[]];
  for (const piece of pieces) {
    piece.text.split('\n').forEach((part, index) => {
      if (index > 0) {
        result.push([]);
      }
      if (part.length > 0) {
        result.at(-1)?.push({ ...piece, text: part });
      }
    });
  }
  return trimBlankLines(result);
}

/** Prefixes each line; a blank line gets the prefix without its trailing space. */
function prefix(lines: readonly Line[], first: string, rest: string): Line[] {
  return lines.map((line, index) => {
    const value = index === 0 ? first : rest;
    const text = line.length === 0 ? value.trimEnd() : value;
    return text.length === 0 ? line : [plain(text), ...line];
  });
}

function trimBlankLines(lines: readonly Line[]): Line[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}
