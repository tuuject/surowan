import type { SpoilerRange } from '../spoilers.ts';

/**
 * A Telegram body flattened to ordinary Markdown, with the spoiler spans it
 * still carries as UTF-16 ranges into that Markdown. Spoilers stay ranges
 * rather than markup because the runtime tag is only inserted after XML
 * escaping (`renderSpoilers`).
 */
export interface MarkdownBody {
  readonly text: string;
  readonly spoilers: SpoilerRange[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A backtick fence one longer than any backtick run inside `code`, so the code can never close it early. */
export function codeFence(code: string, minimum: number): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(minimum, longest + 1));
}

/** Inline code: padding keeps a leading or trailing backtick from merging into the fence. */
export function inlineCode(code: string): string {
  const fence = codeFence(code, 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** The info string of a fenced block; anything that is not a plain language token is dropped. */
export function fenceLanguage(language: unknown): string {
  return typeof language === 'string' && /^[\w#+.-]{1,32}$/.test(language) ? language : '';
}

/** A link destination that cannot end the `(...)` early or break the line. */
export function linkTarget(url: string): string {
  return url
    .replace(/\s/g, (space) => encodeURIComponent(space))
    .replaceAll('(', '%28')
    .replaceAll(')', '%29');
}
