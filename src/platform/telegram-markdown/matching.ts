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
const VISIBLE_KEYS: Readonly<Record<string, true>> = {
  text: true,
  summary: true,
  credit: true,
  caption: true,
  alternative_text: true,
  expression: true,
  button: true,
};
const STRUCTURAL_KEYS: Readonly<Record<string, true>> = {
  blocks: true,
  items: true,
  cells: true,
  buttons: true,
};
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
    if (key === 'caption' && isRecord(field) && field.type === undefined) {
      collectLines(field, lines, depth + 1);
    } else if (VISIBLE_KEYS[key] === true) {
      const line = runText(field, depth + 1);
      if (line.length > 0) {
        lines.push(line);
      }
    } else if (STRUCTURAL_KEYS[key] === true) {
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
  if (value.type === 'custom_emoji' && typeof value.alternative_text === 'string') {
    return value.alternative_text;
  }
  if (value.type === 'mathematical_expression' && typeof value.expression === 'string') {
    return value.expression;
  }
  if (value.type === 'button' && isRecord(value.button)) {
    return runText(value.button.text, depth + 1);
  }
  return 'text' in value ? runText(value.text, depth + 1) : '';
}
