/**
 * A rich message as the trigger rules read it.
 *
 * Keywords and mentions are matched against what a reader sees. For a plain
 * message that is its text; a rich message has none, and its Markdown would
 * add link targets and media placeholders nobody reads. This collects only the
 * visible text of its runs, one line per field so a keyword never joins the end
 * of one block to the start of the next, and the mentions inside it.
 */

import { isRecord } from './shared.ts';

/**
 * Fields that hold visible rich text. Everything else (link targets, file
 * ids and names, list labels, node types) is never matched.
 */
const VISIBLE_KEYS: ReadonlySet<string> = new Set([
  'text',
  'summary',
  'credit',
  'caption',
  'alternative_text',
  'expression',
  'button',
]);
/** Telegram allows 16 levels of nesting; anything deeper is malformed data. */
const MAX_DEPTH = 64;

export type RichMention =
  | { readonly kind: 'username'; readonly username: string }
  | { readonly kind: 'user'; readonly id: number };

export function richMessagePlainText(value: unknown): string {
  const lines: string[] = [];
  collectLines(value, lines, 0);
  return lines.join('\n');
}

/** Every mention in the message, by username or by user id, wherever it sits. */
export function richMessageMentions(value: unknown): RichMention[] {
  const mentions: RichMention[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (node.type === 'text_mention' && isRecord(node.user) && typeof node.user.id === 'number') {
      mentions.push({ kind: 'user', id: node.user.id });
    } else if (node.type === 'mention') {
      const username = (typeof node.username === 'string' ? node.username : runText(node.text, depth)).replace(
        /^@/,
        '',
      );
      if (username.length > 0) {
        mentions.push({ kind: 'username', username });
      }
    }
    for (const field of Object.values(node)) {
      visit(field, depth + 1);
    }
  };
  visit(value, 0);
  return mentions;
}

/** Outside rich text: each visible field becomes a line of its own. */
function collectLines(value: unknown, lines: string[], depth: number): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLines(item, lines, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (VISIBLE_KEYS.has(key)) {
      const line = runText(field, depth + 1);
      if (line.length > 0) {
        lines.push(line);
      }
    } else {
      collectLines(field, lines, depth + 1);
    }
  }
}

/** Inside rich text: runs join in place, so formatting never splits a word. */
function runText(value: unknown, depth: number): string {
  if (typeof value === 'string') {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map((item) => runText(item, depth + 1)).join('');
  }
  if (!isRecord(value)) {
    return '';
  }
  return Object.entries(value)
    .filter(([key]) => VISIBLE_KEYS.has(key))
    .map(([, field]) => runText(field, depth + 1))
    .filter((part) => part.length > 0)
    .join(' ');
}
