/**
 * A Telegram text or caption with its entities, flattened to Markdown.
 *
 * Telegram never delivers formatting as markup: whether the sender used a
 * Markdown or HTML parse mode or the client toolbar, the message arrives as plain
 * `text` (or `caption`) plus entities over UTF-16 spans. This puts the
 * formatting back as ordinary Markdown so a link keeps its URL and a code block
 * keeps its fence. Entities Telegram detects on its own (mentions, hashtags,
 * bare URLs, commands) already read correctly as text and add no markup, so a
 * message without formatting comes back unchanged.
 */

import { normalizeSpoilerRanges, type SpoilerRange } from '../spoilers.ts';
import { codeFence, fenceLanguage, inlineCode, isRecord, linkTarget, type MarkdownBody } from './shared.ts';

/** Formatting entities, outermost first when two cover the same span. */
const NESTING_ORDER: Readonly<Record<string, number>> = {
  blockquote: 0,
  expandable_blockquote: 0,
  pre: 1,
  spoiler: 2,
  text_link: 3,
  text_mention: 3,
  bold: 4,
  italic: 5,
  strikethrough: 6,
  code: 7,
};

const INLINE_MARKERS: Readonly<Record<string, string>> = {
  bold: '**',
  italic: '_',
  strikethrough: '~~',
};

interface Span {
  readonly type: string;
  readonly start: number;
  end: number;
  readonly target: string | null;
  readonly language: string;
  readonly children: Span[];
}

export function entitiesMarkdown(text: string, entities: unknown): MarkdownBody {
  const spans = nest(readSpans(entities, text.length));
  if (spans.length === 0) {
    return { text, spoilers: [] };
  }
  const writer = new Writer();
  renderRange(writer, text, 0, text.length, spans);
  return { text: writer.out, spoilers: normalizeSpoilerRanges(writer.spoilers, writer.out.length) };
}

function readSpans(value: unknown, bodyLength: number): Span[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const spans: Span[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const { type, offset, length } = item;
    if (typeof type !== 'string' || !Object.hasOwn(NESTING_ORDER, type)) {
      continue;
    }
    if (typeof offset !== 'number' || typeof length !== 'number') {
      continue;
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset >= bodyLength) {
      continue;
    }
    const target = linkOf(type, item);
    if ((type === 'text_link' || type === 'text_mention') && target === null) {
      continue;
    }
    spans.push({
      type,
      start: offset,
      end: Math.min(offset + length, bodyLength),
      target,
      language: type === 'pre' ? fenceLanguage(item.language) : '',
      children: [],
    });
  }
  return spans;
}

function linkOf(type: string, entity: Record<string, unknown>): string | null {
  if (type === 'text_link') {
    return typeof entity.url === 'string' ? entity.url : null;
  }
  if (type === 'text_mention') {
    const user = entity.user;
    return isRecord(user) && typeof user.id === 'number' ? `tg://user?id=${user.id}` : null;
  }
  return null;
}

/**
 * Telegram nests entities properly, but stored fragments are still data: a span
 * that crosses its parent is clipped to it, nothing nests inside code, and a
 * span repeating an enclosing format is dropped instead of doubling markers.
 */
function nest(spans: Span[]): Span[] {
  const order = (span: Span): number => NESTING_ORDER[span.type] ?? 0;
  spans.sort((left, right) => left.start - right.start || right.end - left.end || order(left) - order(right));
  const roots: Span[] = [];
  const stack: Span[] = [];
  for (const span of spans) {
    while (stack.length > 0 && span.start >= (stack.at(-1)?.end ?? 0)) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent !== undefined) {
      if (parent.type === 'code' || parent.type === 'pre') {
        continue;
      }
      span.end = Math.min(span.end, parent.end);
    }
    if (stack.some((open) => order(open) === order(span))) {
      continue;
    }
    (parent?.children ?? roots).push(span);
    stack.push(span);
  }
  return roots;
}

function renderRange(writer: Writer, text: string, start: number, end: number, spans: readonly Span[]): void {
  let cursor = start;
  for (const span of spans) {
    writer.text(text.slice(cursor, span.start));
    renderSpan(writer, text, span);
    cursor = span.end;
  }
  writer.text(text.slice(cursor, end));
}

function renderSpan(writer: Writer, text: string, span: Span): void {
  const content = (): void => renderRange(writer, text, span.start, span.end, span.children);
  switch (span.type) {
    case 'blockquote':
    case 'expandable_blockquote':
      writer.enterQuote();
      content();
      writer.leaveQuote();
      return;
    case 'pre': {
      const code = text.slice(span.start, span.end);
      const fence = codeFence(code, 3);
      writer.openLine();
      writer.text(`${fence}${span.language}\n${code}`);
      writer.openLine();
      writer.text(fence);
      writer.closeBlock();
      return;
    }
    case 'code':
      writer.text(inlineCode(text.slice(span.start, span.end)));
      return;
    case 'text_link':
    case 'text_mention':
      writer.text('[');
      content();
      writer.text(`](${linkTarget(span.target ?? '')})`);
      return;
    case 'spoiler': {
      const start = writer.out.length;
      content();
      writer.spoilers.push({ start, end: writer.out.length });
      return;
    }
    default: {
      const marker = INLINE_MARKERS[span.type] ?? '';
      writer.text(marker);
      content();
      writer.text(marker);
    }
  }
}

/**
 * Appends Markdown while keeping block structure: every line inside a quote
 * starts with `> `, and a fenced block always sits on lines of its own.
 */
class Writer {
  out = '';
  readonly spoilers: SpoilerRange[] = [];
  #quoteDepth = 0;
  /** The current line holds something beyond its quote prefix. */
  #lineOpen = false;
  /** A block just closed, so the next text must start on a new line. */
  #breakOwed = false;

  text(value: string): void {
    if (value.length === 0) {
      return;
    }
    if (this.#breakOwed) {
      this.#breakOwed = false;
      if (!value.startsWith('\n')) {
        this.#newline();
      }
    }
    value.split('\n').forEach((line, index) => {
      if (index > 0) {
        this.#newline();
      }
      if (line.length > 0) {
        this.out += line;
        this.#lineOpen = true;
      }
    });
  }

  openLine(): void {
    if (this.#breakOwed || this.#lineOpen) {
      this.#breakOwed = false;
      this.#newline();
    }
  }

  closeBlock(): void {
    this.#breakOwed = true;
  }

  enterQuote(): void {
    this.openLine();
    this.#quoteDepth += 1;
    this.out += '> ';
  }

  leaveQuote(): void {
    // A quote span that swallowed its trailing newline would leave a bare
    // `> ` line behind; the break owed below already ends the quote.
    const emptyLine = `\n${'> '.repeat(this.#quoteDepth)}`;
    if (!this.#lineOpen && this.out.endsWith(emptyLine)) {
      this.out = this.out.slice(0, -emptyLine.length);
      this.#lineOpen = true;
      for (const [index, range] of this.spoilers.entries()) {
        this.spoilers[index] = {
          start: Math.min(range.start, this.out.length),
          end: Math.min(range.end, this.out.length),
        };
      }
    }
    this.#quoteDepth -= 1;
    this.closeBlock();
  }

  #newline(): void {
    this.out += `\n${'> '.repeat(this.#quoteDepth)}`;
    this.#lineOpen = false;
  }
}
