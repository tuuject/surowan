import { expect, test } from 'vitest';
import { createDictionaryTools } from '../../src/plugins/dictionary/tools.ts';
import {
  decodeAliasCell,
  encodeAliasCell,
  parseDictionaryCsv,
  parseDictionaryImport,
} from '../../src/plugins/dictionary/format.ts';
import { DictionaryStore } from '../../src/plugins/dictionary/store.ts';
import { fixture } from './fixtures.ts';

test('entry writes are revision-checked and never move scope', async () => {
  const { store } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    const entry = dictionary.create({
      term: '碗',
      definition: 'v1',
      aliases: [],
      scope: 'group',
      chatId: 123456789n,
      enabled: true,
    });
    expect(entry.revision).toBe('1');

    const updated = dictionary.update(
      entry.id,
      { term: '碗', definition: 'v2', aliases: ['bowl'], scope: 'group', chatId: 123456789n, enabled: false },
      '1',
    );
    expect(updated.revision).toBe('2');
    expect(updated.definition).toBe('v2');
    expect(updated.enabled).toBe(false);

    // A stale revision is refused; nothing is overwritten.
    expect(() =>
      dictionary.update(
        entry.id,
        { term: '碗', definition: 'v3', aliases: [], scope: 'group', chatId: 123456789n, enabled: true },
        '1',
      ),
    ).toThrowError(/dictionary_conflict/);
    expect(dictionary.get(entry.id)?.definition).toBe('v2');

    dictionary.remove(entry.id, '2');
    expect(dictionary.get(entry.id)).toBeUndefined();
    expect(() => dictionary.remove(entry.id, '2')).toThrowError(/dictionary_conflict/);
  } finally {
    store.close();
  }
});

test('agent tools read the effective dictionary and only write the current group', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    const global = dictionary.create({
      term: '塑料碗',
      definition: 'Bot 的昵称',
      aliases: ['碗'],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    const tools = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: 123456789n,
      privateChat: false,
    });
    const [lookup, add, update] = tools;
    if (lookup === undefined || add === undefined || update === undefined) {
      throw new Error('Expected three dictionary tools');
    }

    const found = await lookup.execute('lookup-1', { terms: ['碗'] }, new AbortController().signal);
    expect(JSON.stringify(found.content)).toContain(global.id);
    const missing = await lookup.execute('lookup-2', { terms: ['不存在'] }, new AbortController().signal);
    expect(JSON.stringify(missing.content)).toContain('No entry matches');

    const added = await add.execute(
      'add-1',
      { term: '运维', definition: '负责服务器的人', aliases: ['ops'] },
      new AbortController().signal,
    );
    const createdId = (added.details as { id: string }).id;
    expect(dictionary.get(createdId)).toMatchObject({ scope: 'group', chatId: 123456789n });

    // A global entry cannot be modified through the tool.
    await expect(
      update.execute(
        'update-1',
        { id: global.id, term: '塑料碗', definition: 'hijacked' },
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/group_scope_required/);
    expect(dictionary.get(global.id)?.definition).toBe('Bot 的昵称');

    const changed = await update.execute(
      'update-2',
      { id: createdId, term: '运维', definition: '负责运维的人', aliases: ['ops'] },
      new AbortController().signal,
    );
    expect(JSON.stringify(changed.content)).toContain('Updated entry');
    const audited = store.db
      .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
        "SELECT tool_name, state, error_code FROM tool_calls WHERE tool_call_id IN ('add-1','update-1','update-2') ORDER BY tool_call_id",
      )
      .all();
    expect(audited).toEqual([
      { tool_name: 'add_dictionary_entry', state: 'success', error_code: null },
      { tool_name: 'update_dictionary_entry', state: 'error', error_code: 'group_scope_required' },
      { tool_name: 'update_dictionary_entry', state: 'success', error_code: null },
    ]);
  } finally {
    store.close();
  }
});

test('a private chat can only read the global dictionary and cannot write', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    dictionary.create({
      term: '私聊词条',
      definition: '属于某个群',
      aliases: [],
      scope: 'group',
      chatId: 123456789n,
      enabled: true,
    });
    const tools = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: 123456789n,
      privateChat: true,
    });
    const [lookup, add] = tools;
    if (lookup === undefined || add === undefined) {
      throw new Error('Expected dictionary tools');
    }
    const result = await lookup.execute('lookup-p', { terms: ['私聊词条'] }, new AbortController().signal);
    expect(JSON.stringify(result.content)).toContain('No entry matches');
    await expect(
      add.execute('add-p', { term: 'x', definition: 'y' }, new AbortController().signal),
    ).rejects.toThrowError(/global_readonly/);
  } finally {
    store.close();
  }
});

test('CSV aliases escape literal pipes and backslashes, and import never dictates its own scope', () => {
  expect(encodeAliasCell(['a|b', 'c\\d', 'plain'])).toBe('a\\|b|c\\\\d|plain');
  expect(decodeAliasCell('a\\|b|c\\\\d|plain')).toEqual(['a|b', 'c\\d', 'plain']);

  const rows = parseDictionaryCsv('term,definition,aliases,enabled\n"a,b","line1\nline2","x|y",false\n');
  expect(rows).toEqual([{ term: 'a,b', definition: 'line1\nline2', aliases: ['x', 'y'], enabled: false }]);

  const drafts = parseDictionaryImport('csv', 'term,definition,aliases\n塑料碗,Bot 昵称,碗|塑料\n', {
    scope: 'group',
    chatId: 42n,
  });
  expect(drafts).toEqual([
    { term: '塑料碗', definition: 'Bot 昵称', aliases: ['碗', '塑料'], scope: 'group', chatId: 42n, enabled: true },
  ]);

  expect(() => parseDictionaryImport('jsonl', 'not json at all', { scope: 'global', chatId: null })).toThrowError(
    /invalid_jsonl/,
  );
  // A well-formed line with a missing definition is an entry error, not a syntax one.
  expect(() => parseDictionaryImport('jsonl', '{"term":"a"}', { scope: 'global', chatId: null })).toThrowError(
    /invalid_entry/,
  );
  expect(() => parseDictionaryImport('csv', 'definition\nonly\n', { scope: 'global', chatId: null })).toThrowError(
    /invalid_csv_header/,
  );
});
