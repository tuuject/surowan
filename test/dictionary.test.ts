import { expect, test } from 'vitest';
import { createDictionaryTools } from '../src/plugins/dictionary/dictionary.ts';
import {
  conflictGroups,
  conflictGroupsFromValues,
  matchingEntries,
} from '../src/plugins/dictionary/dictionary-conflicts.ts';
import { DictionaryStore } from '../src/plugins/dictionary/dictionary-store.ts';
import {
  dictionaryTextMatches,
  dictionaryValueMatches,
  normalizeAliases,
  normalizeDictionaryMatch,
} from '../src/plugins/dictionary/dictionary-match.ts';
import { fixture } from './dictionary-fixtures.ts';

test('aliases are normalized, matched literally and reported as conflicts', async () => {
  const { store } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    expect(normalizeAliases([' 碗 ', '碗', '', '塑料'])).toEqual(['碗', '塑料']);

    const bowl = dictionary.create({
      term: '塑料碗',
      definition: '群内对 Bot 的昵称',
      aliases: ['碗'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const bowlTwo = dictionary.create({
      term: '塑料碗',
      definition: '另一个含义',
      aliases: ['碗'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const group = dictionary.create({
      term: '运维',
      definition: '负责服务器的人',
      aliases: [],
      scope: 'group',
      chatId: 123456789n,
      enabled: true,
    });

    // Exact literal substring matching, including inside a longer message.
    const matches = matchingEntries(dictionary.effective(123456789n), ['今天碗怎么不说话了？']);
    expect(matches.map((entry) => entry.id).sort()).toEqual([bowl.id, bowlTwo.id].sort());
    expect(matchingEntries(dictionary.effective(123456789n), ['今天塑料碗怎么不说话了'])).toHaveLength(2);
    expect(matchingEntries(dictionary.effective(123456789n), ['运维 Ops'])).toHaveLength(1);

    // Conflicts group the shared value across term and alias positions.
    const conflicts = conflictGroups(dictionary.effective(123456789n, { enabledOnly: false }));
    expect(conflicts).toEqual([
      { value: '塑料碗', entryIds: [bowl.id, bowlTwo.id].sort() },
      { value: '碗', entryIds: [bowl.id, bowlTwo.id].sort() },
    ]);

    // The effective dictionary is per chat: another chat sees only globals.
    expect(
      dictionary
        .effective(999n)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([bowl.id, bowlTwo.id].sort());
    expect(dictionary.effective(123456789n).map((entry) => entry.id)).toContain(group.id);
  } finally {
    store.close();
  }
});

test('pangu spacing at a Han/ASCII boundary is the only thing the match normalizer folds', () => {
  // The target convention, both directions and across consecutive boundaries.
  expect(dictionaryTextMatches('AB 钙', 'AB钙')).toBe(true);
  expect(dictionaryTextMatches('AB钙', 'AB 钙')).toBe(true);
  expect(dictionaryTextMatches('今天AB 钙吗', 'AB钙')).toBe(true);
  expect(dictionaryTextMatches('这个AB\t钙', 'AB钙')).toBe(true);
  expect(dictionaryTextMatches('这个AB\u3000钙', 'AB钙')).toBe(true);
  expect(dictionaryTextMatches('说钙 AB', '钙AB')).toBe(true);
  // A run of spaces is dropped only where a Han/ASCII pair sits on each side.
  expect(normalizeDictionaryMatch('AB 钙 片')).toBe('AB钙 片');
  expect(normalizeDictionaryMatch('AB 钙 CD')).toBe('AB钙CD');

  // Case stays significant.
  expect(dictionaryTextMatches('AB 钙', 'ab钙')).toBe(false);
  expect(dictionaryTextMatches('ab 钙', 'AB钙')).toBe(false);
  // Whitespace between two ASCII words is not a Han/ASCII boundary.
  expect(dictionaryTextMatches('A B 钙', 'AB钙')).toBe(false);
  expect(dictionaryTextMatches('AB钙', 'A B 钙')).toBe(false);
  // Whitespace between two Han characters is not a boundary either.
  expect(dictionaryTextMatches('钙 片', '钙片')).toBe(false);
  // A space at the edge of a needle is only pangu when a Han/ASCII pair sits on
  // both sides of it; a bare leading/trailing space is not folded away.
  expect(dictionaryTextMatches('我钙', ' 钙')).toBe(false);
  expect(dictionaryTextMatches('我 钙', '钙 ')).toBe(false);
  // A newline is a real separator, never pangu spacing.
  expect(dictionaryTextMatches('AB\n钙', 'AB钙')).toBe(false);
  // An exact literal hit is preserved without any normalization.
  expect(dictionaryTextMatches('啥是AB 钙啊', 'AB 钙')).toBe(true);

  // A needle that folds to the same key matches; the stored value is untouched.
  expect(normalizeDictionaryMatch('AB 钙')).toBe('AB钙');
  expect(dictionaryValueMatches('AB 钙', 'AB钙')).toBe(true);
  expect(dictionaryValueMatches('AB 钙', 'AB 钙')).toBe(true);
  expect(dictionaryValueMatches('AB 钙', '  AB钙  ')).toBe(true);
  expect(dictionaryValueMatches('AB 钙', 'ab钙')).toBe(false);
  expect(dictionaryValueMatches('碗', '碗')).toBe(true);
  expect(dictionaryValueMatches('碗', '')).toBe(false);
});

test('matching, lookup and conflicts fold pangu spacing without rewriting the stored values', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    // The alias is stored with its pangu space verbatim.
    const pangu = dictionary.create({
      term: 'AB钙',
      definition: '带希腊字母钙',
      aliases: ['AB 钙'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    expect(pangu.aliases).toEqual(['AB 钙']);

    // Both directions match a message and its term/alias spelling.
    expect(matchingEntries(dictionary.effective(123456789n), ['今天AB钙讲了吗']).map((e) => e.id)).toEqual([pangu.id]);
    expect(matchingEntries(dictionary.effective(123456789n), ['今天AB 钙讲了吗']).map((e) => e.id)).toEqual([pangu.id]);

    // A pangu variant is the same conflicting value as its normalized twin.
    const twin = dictionary.create({
      term: 'AB 钙',
      definition: '另一种写法',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const conflicts = conflictGroups(dictionary.effective(123456789n, { enabledOnly: false }));
    expect(conflicts).toEqual([{ value: 'AB钙', entryIds: [pangu.id, twin.id].sort() }]);

    // The lookup tool accepts either spelling.
    const tools = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: 123456789n,
      privateChat: false,
    });
    const lookup = tools[0];
    if (lookup === undefined) {
      throw new Error('Expected the lookup tool');
    }
    const spaced = await lookup.execute('lookup-pangu-1', { terms: ['AB 钙'] }, new AbortController().signal);
    expect(JSON.stringify(spaced.content)).toContain(pangu.id);
    const unspaced = await lookup.execute('lookup-pangu-2', { terms: ['AB钙'] }, new AbortController().signal);
    expect(JSON.stringify(unspaced.content)).toContain(pangu.id);

    // Case is not folded: a lowercase lookup finds nothing.
    const wrongCase = await lookup.execute('lookup-pangu-3', { terms: ['ab钙'] }, new AbortController().signal);
    expect(JSON.stringify(wrongCase.content)).toContain('No entry matches');

    // The import-preview conflict grouping shares the same equivalence.
    const previewGroups = conflictGroupsFromValues([
      { id: 'import:0', term: 'AB 钙', aliases: [] },
      { id: pangu.id, term: 'AB钙', aliases: ['AB 钙'] },
    ]);
    expect(previewGroups).toEqual([{ value: 'AB钙', entryIds: ['import:0', pangu.id].sort() }]);
  } finally {
    store.close();
  }
});

test('admin search accepts pangu spacing without folding case or ASCII-internal spaces', async () => {
  const { store } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    dictionary.create({
      term: 'AB钙',
      definition: '带希腊字母钙',
      aliases: ['AB 钙'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const plain = dictionary.create({
      term: '碗',
      definition: '昵称',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });

    // The spaced query finds the unspaced term, and vice versa.
    expect(dictionary.list({ scope: 'global', search: 'AB 钙' })).toHaveLength(1);
    expect(dictionary.list({ scope: 'global', search: 'AB钙' })).toHaveLength(1);
    // Case is still significant; a different ASCII-internal spelling is not a hit.
    expect(dictionary.list({ scope: 'global', search: 'ab钙' })).toHaveLength(0);
    expect(dictionary.list({ scope: 'global', search: 'A B钙' })).toHaveLength(0);
    // An ordinary substring hit still works.
    expect(dictionary.list({ scope: 'global', search: '碗' }).map((e) => e.id)).toEqual([plain.id]);
  } finally {
    store.close();
  }
});
