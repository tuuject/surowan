/**
 * Keyword search shared by the runtime's discovery tools (`execute.search` and
 * `mcp.search`).
 *
 * A model asks in whatever language the conversation is in, and Chinese or
 * Japanese queries carry no spaces: splitting on non-ASCII characters left such
 * a query with no tokens at all, so it could only match as one whole phrase.
 * `Intl.Segmenter` (ICU word boundaries, bundled with Node) cuts both scripts
 * into words and keeps Latin words intact, so each word scores on its own.
 * Matching stays plain lower-cased substring containment over the fields a
 * caller provides; this is a ranking hint for a model, not a search engine.
 */

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Han, kana and Hangul: no spaces between words, so a short token can carry meaning. */
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A lone kana is an inflection or particle (`検索して` leaves `し` and `て`), never a topic. */
const SINGLE_KANA_PATTERN = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/**
 * Function words that would otherwise match almost every Chinese description
 * and drown the words that carry the request.
 */
const CJK_STOP_WORDS: ReadonlySet<string> = new Set([
  '的',
  '了',
  '和',
  '与',
  '或',
  '是',
  '在',
  '我',
  '你',
  '他',
  '她',
  '它',
  '们',
  '吗',
  '呢',
  '吧',
  '啊',
  '把',
  '被',
  '给',
  '要',
  '想',
  '用',
  '请',
  '帮',
  '一下',
  '一个',
  '这个',
  '那个',
  '可以',
  '能',
]);

/**
 * The words of one query, lower-cased and deduplicated. `_` joins words in tool
 * names (`web_fetch`), so a token keeps it as a space and matches the spaced
 * form a caller adds next to the raw name. Latin tokens shorter than two
 * characters are noise; a CJK token is kept unless it is a function word or a
 * lone kana.
 */
export function searchTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const { segment, isWordLike } of segmenter.segment(query.trim().toLowerCase())) {
    if (isWordLike !== true) {
      continue;
    }
    const token = segment.replaceAll('_', ' ').trim();
    if (token.length === 0) {
      continue;
    }
    if (CJK_PATTERN.test(token) ? CJK_STOP_WORDS.has(token) || SINGLE_KANA_PATTERN.test(token) : token.length < 2) {
      continue;
    }
    tokens.add(token);
  }
  return [...tokens];
}

/** One searchable field and what a token found in it is worth. */
export type SearchField = readonly [text: string, weight: number];

/** A prepared query: its normalized phrase and its words. */
export interface SearchQuery {
  readonly phrase: string;
  readonly tokens: readonly string[];
}

export function searchQuery(query: string): SearchQuery {
  return { phrase: query.trim().toLowerCase(), tokens: searchTokens(query) };
}

/**
 * The score of one candidate: 10 when the whole query appears in the joined
 * fields, then for every token the weight of the first field (in the given
 * order) that contains it. Zero means no match.
 */
export function searchScore(query: SearchQuery, fields: readonly SearchField[]): number {
  const texts = fields.map(([text, weight]) => [text.toLowerCase(), weight] as const);
  let score = 0;
  if (
    query.phrase.length > 0 &&
    texts
      .map(([text]) => text)
      .join(' ')
      .includes(query.phrase)
  ) {
    score += 10;
  }
  for (const token of query.tokens) {
    const field = texts.find(([text]) => text.includes(token));
    if (field !== undefined) {
      score += field[1];
    }
  }
  return score;
}
