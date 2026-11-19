/**
 * Prompt-reference helpers for the image workspace. The prompt text is the
 * single source of truth for which images a generation references: picking an
 * asset inserts its `{{image:<id>}}` token, and this module parses that text
 * back for rendering and removal. Malformed text never throws here — the
 * resolve preview and the server report it instead.
 */

const REFERENCE = /\{\{(?:prompt|image):([0-9a-fA-F-]{36})\}\}/g;

export interface ImageRefSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/** Every `{{image:UUID}}` span in the text, in order; other tokens are skipped. */
export function scanImageRefs(text: string): readonly ImageRefSpan[] {
  const spans: ImageRefSpan[] = [];
  REFERENCE.lastIndex = 0;
  let match = REFERENCE.exec(text);
  while (match !== null) {
    const id = match[1]?.toLowerCase();
    if (match[0].startsWith('{{image:') && id !== undefined) {
      spans.push({ id, start: match.index, end: REFERENCE.lastIndex });
    }
    match = REFERENCE.exec(text);
  }
  return spans;
}

/** Distinct referenced asset ids, in order of first appearance. */
export function referencedAssetIds(text: string): readonly string[] {
  const ids: string[] = [];
  for (const span of scanImageRefs(text)) {
    if (!ids.includes(span.id)) {
      ids.push(span.id);
    }
  }
  return ids;
}

/** The token the picker inserts for one asset. */
export function imageRefToken(id: string): string {
  return `{{image:${id}}}`;
}

/** Removes every `{{image:<id>}}` token from the text, from the end backwards. */
export function removeImageRefTokens(text: string, id: string): string {
  const target = id.toLowerCase();
  let result = text;
  for (const span of [...scanImageRefs(text)].reverse()) {
    if (span.id === target) {
      result = result.slice(0, span.start) + result.slice(span.end);
    }
  }
  return result;
}
