import { describe, expect, test } from 'vitest';
import { aliasesEqual, formatAliasLines, normalizeAliases, parseAliasLines } from './dictionary.ts';

describe('parseAliasLines', () => {
  test('splits on newlines, trims and drops empty lines', () => {
    expect(parseAliasLines('one\ntwo\n\n three \n')).toEqual(['one', 'two', 'three']);
  });

  test('keeps a comma and a pipe literal inside a single alias', () => {
    expect(parseAliasLines('AB 钙')).toEqual(['AB 钙']);
    expect(parseAliasLines('带,逗号\n带|竖线')).toEqual(['带,逗号', '带|竖线']);
    expect(parseAliasLines('a,b|c')).toEqual(['a,b|c']);
  });

  test('handles CRLF input the same way as LF', () => {
    expect(parseAliasLines('one\r\ntwo\r\nthree')).toEqual(['one', 'two', 'three']);
  });

  test('deduplicates while keeping the first spelling and order', () => {
    expect(parseAliasLines('one\ntwo\none\n two ')).toEqual(['one', 'two']);
  });

  test('an all-blank line becomes nothing rather than alias whitespace', () => {
    expect(parseAliasLines('\n\n')).toEqual([]);
    expect(parseAliasLines('   ')).toEqual([]);
  });
});

describe('formatAliasLines', () => {
  test('round-trips a normalized list back to one alias per line', () => {
    const aliases = ['AB 钙', '带,逗号', '带|竖线'];
    expect(formatAliasLines(aliases)).toBe('AB 钙\n带,逗号\n带|竖线');
    expect(parseAliasLines(formatAliasLines(aliases))).toEqual(aliases);
  });
});

describe('aliasesEqual', () => {
  test('compares by value and order', () => {
    expect(aliasesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(aliasesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(aliasesEqual(['a'], ['a', 'b'])).toBe(false);
    expect(aliasesEqual([], [])).toBe(true);
  });
});

describe('normalizeAliases', () => {
  test('trims, drops empties and deduplicates a raw alias list', () => {
    expect(normalizeAliases([' one ', 'one', '', 'two'])).toEqual(['one', 'two']);
  });
});
