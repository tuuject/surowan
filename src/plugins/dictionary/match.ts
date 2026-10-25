import type { DictionaryDraft } from './tools.ts';

export const DICTIONARY_TERM_MAX_LENGTH = 200;
export const DICTIONARY_DEFINITION_MAX_LENGTH = 4000;
export const DICTIONARY_ALIAS_MAX_LENGTH = 200;
export const DICTIONARY_MAX_ALIASES = 50;

/** Validation/dispatch failure with a stable code the API and tools report. */
export class DictionaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DictionaryError';
    this.code = code;
  }
}

/** Trims, drops blanks and de-duplicates aliases, keeping the first spelling. */
export function normalizeAliases(aliases: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Horizontal whitespace folded at a Han/ASCII boundary: a normal space, a tab,
 * or the full-width space. Line breaks are deliberately absent — a newline
 * between a Latin word and a Han character is a real separator, not pangu
 * spacing, so it must never match. Zero-width joiners and other punctuation are
 * left untouched.
 */
const BOUNDARY_SPACE_PATTERN = /[\t\u0020\u3000]/;

/** Han script: CJK Unified Ideographs plus the compatibility-ideograph block. */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** The ASCII half of a Han/ASCII boundary: an ASCII letter or digit. */
const ASCII_ALNUM_PATTERN = /[0-9A-Za-z]/;

/**
 * Folds the Han/ASCII spacing convention known as pangu ("盘古之白"): a run of
 * horizontal whitespace that sits *between a Han character and an ASCII letter
 * or digit* is dropped, in both directions and across consecutive boundaries.
 *
 * Only that boundary is touched. Case, spaces between two ASCII words, spaces
 * between two Han characters, and every other character survive verbatim, so a
 * term and its aliases keep their original spelling and the match is never
 * broadened past the one convention it targets. No NFKC or other Unicode
 * folding happens here.
 */
export function normalizeDictionaryMatch(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? '';
    if (!BOUNDARY_SPACE_PATTERN.test(character)) {
      result += character;
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && BOUNDARY_SPACE_PATTERN.test(value[end] ?? '')) {
      end += 1;
    }
    const left = index === 0 ? undefined : value[index - 1];
    const right = value[end];
    const crossed =
      left !== undefined &&
      right !== undefined &&
      ((isHan(left) && isAsciiAlnum(right)) || (isHan(right) && isAsciiAlnum(left)));
    if (!crossed) {
      result += value.slice(index, end);
    }
    index = end;
  }
  return result;
}

function isHan(character: string): boolean {
  return HAN_PATTERN.test(character);
}

function isAsciiAlnum(character: string): boolean {
  return ASCII_ALNUM_PATTERN.test(character);
}

/**
 * True when `text` contains `needle`, tolerating pangu spacing at a Han/ASCII
 * boundary. The literal substring test runs first so an exact hit never depends
 * on normalization; otherwise both sides are normalized and compared, which
 * covers `AB 钙` in the text against an `AB钙` needle and the reverse.
 */
export function dictionaryTextMatches(text: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  if (text.includes(needle)) {
    return true;
  }
  return normalizeDictionaryMatch(text).includes(normalizeDictionaryMatch(needle));
}

/**
 * True when a stored term/alias equals a lookup input under the same spacing
 * rule. The input keeps the trimming the lookup tool always applied.
 */
export function dictionaryValueMatches(value: string, input: string): boolean {
  const wanted = input.trim();
  if (wanted.length === 0) {
    return false;
  }
  return wanted === value || normalizeDictionaryMatch(wanted) === normalizeDictionaryMatch(value);
}

/** Validates and normalizes one draft; every field is required to be meaningful. */
export function normalizeDraft(draft: DictionaryDraft): DictionaryDraft {
  const term = draft.term.trim();
  if (term.length === 0) {
    throw new DictionaryError('invalid_term', 'A term is required');
  }
  if (term.length > DICTIONARY_TERM_MAX_LENGTH) {
    throw new DictionaryError('invalid_term', `A term may be at most ${DICTIONARY_TERM_MAX_LENGTH} characters`);
  }
  const definition = draft.definition.trim();
  if (definition.length === 0) {
    throw new DictionaryError('invalid_definition', 'A definition is required');
  }
  if (definition.length > DICTIONARY_DEFINITION_MAX_LENGTH) {
    throw new DictionaryError(
      'invalid_definition',
      `A definition may be at most ${DICTIONARY_DEFINITION_MAX_LENGTH} characters`,
    );
  }
  const aliases = normalizeAliases(draft.aliases);
  if (aliases.length > DICTIONARY_MAX_ALIASES) {
    throw new DictionaryError('invalid_alias', `An entry may have at most ${DICTIONARY_MAX_ALIASES} aliases`);
  }
  for (const alias of aliases) {
    if (alias.length > DICTIONARY_ALIAS_MAX_LENGTH) {
      throw new DictionaryError('invalid_alias', `An alias may be at most ${DICTIONARY_ALIAS_MAX_LENGTH} characters`);
    }
  }
  if (draft.scope === 'global') {
    if (draft.chatId !== null) {
      throw new DictionaryError('invalid_scope', 'A global entry cannot name a chat');
    }
  } else if (draft.chatId === null || draft.chatId === 0n) {
    throw new DictionaryError('chat_required', 'A group entry must name its chat');
  }
  return {
    term,
    definition,
    aliases,
    scope: draft.scope,
    chatId: draft.scope === 'global' ? null : draft.chatId,
    enabled: draft.enabled,
  };
}
