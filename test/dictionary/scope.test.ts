import { expect, test } from 'vitest';
import { createDictionaryTools } from '../../src/plugins/dictionary/tools.ts';
import { conflictGroups } from '../../src/plugins/dictionary/conflicts.ts';
import { DictionaryStore } from '../../src/plugins/dictionary/store.ts';
import { fixture } from './fixtures.ts';

test('conflicts computed for a group scope include global entries but not other groups', async () => {
  const { store } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    dictionary.create({
      term: '共享词',
      definition: 'global',
      aliases: [],
      scope: 'global',
      chatId: null,
      enabled: true,
    });
    dictionary.create({
      term: '共享词',
      definition: 'group A',
      aliases: [],
      scope: 'group',
      chatId: 123456789n,
      enabled: true,
    });
    dictionary.create({
      term: '共享词',
      definition: 'group B',
      aliases: [],
      scope: 'group',
      chatId: 999n,
      enabled: true,
    });
    const conflictsA = conflictGroups([
      ...dictionary.list({ scope: 'global' }),
      ...dictionary.list({ scope: 'group', chatId: 123456789n }),
    ]);
    expect(conflictsA).toHaveLength(1);
    expect(conflictsA[0]?.entryIds).toHaveLength(2);
    const conflictsB = conflictGroups([
      ...dictionary.list({ scope: 'global' }),
      ...dictionary.list({ scope: 'group', chatId: 999n }),
    ]);
    expect(conflictsB).toHaveLength(1);
    expect(conflictsB[0]?.entryIds).not.toEqual(conflictsA[0]?.entryIds);
  } finally {
    store.close();
  }
});

test('a migrated group dictionary stays in scope after the chat becomes a supergroup, and only for its own group', async () => {
  const { store } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    const OLD = 111n;
    const NEW = 222n;
    const OTHER = 333n;
    const oldEntry = dictionary.create({
      term: '旧群词条',
      definition: '迁移前写入',
      aliases: [],
      scope: 'group',
      chatId: OLD,
      enabled: true,
    });
    const newEntry = dictionary.create({
      term: '新群词条',
      definition: '迁移后写入',
      aliases: [],
      scope: 'group',
      chatId: NEW,
      enabled: true,
    });
    const otherEntry = dictionary.create({
      term: '别的群',
      definition: '不跨群',
      aliases: [],
      scope: 'group',
      chatId: OTHER,
      enabled: true,
    });
    store.db
      .prepare(
        "INSERT INTO chat_migrations(old_chat_id, new_chat_id, received_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      )
      .run(OLD, NEW);

    // Reads under the new ID see both the pre- and post-migration entries, and
    // never another group's.
    const effective = dictionary.effective(NEW).map((entry) => entry.id);
    expect(effective).toContain(oldEntry.id);
    expect(effective).toContain(newEntry.id);
    expect(effective).not.toContain(otherEntry.id);
    const listed = dictionary.list({ scope: 'group', chatId: NEW }).map((entry) => entry.id);
    expect(listed.sort()).toEqual([oldEntry.id, newEntry.id].sort());
    // The old ID still resolves to the entries authored under it; the new ID is
    // the one that additionally inherits them. The other group's view stays
    // separate either way.
    expect(dictionary.effective(OLD).map((entry) => entry.id)).toEqual([oldEntry.id]);
    expect(dictionary.effective(OTHER).map((entry) => entry.id)).toEqual([otherEntry.id]);
  } finally {
    store.close();
  }
});

test('the agent can update a pre-migration entry of its migrated chat but not another group’s', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    const OLD = 111n;
    const NEW = 222n;
    const OTHER = 333n;
    const oldEntry = dictionary.create({
      term: '旧群词条',
      definition: 'v1',
      aliases: [],
      scope: 'group',
      chatId: OLD,
      enabled: true,
    });
    const otherEntry = dictionary.create({
      term: '别的群',
      definition: '不可改',
      aliases: [],
      scope: 'group',
      chatId: OTHER,
      enabled: true,
    });
    store.db
      .prepare(
        "INSERT INTO chat_migrations(old_chat_id, new_chat_id, received_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      )
      .run(OLD, NEW);
    const tools = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: NEW,
      privateChat: false,
    });
    const [, , update] = tools;
    if (update === undefined) {
      throw new Error('Expected the update tool');
    }
    const changed = await update.execute(
      'update-migrated',
      { id: oldEntry.id, term: '旧群词条', definition: 'v2', aliases: [] },
      new AbortController().signal,
    );
    expect(JSON.stringify(changed.content)).toContain('Updated entry');
    // The write re-homes the entry to the current chat ID, so a later read under
    // the new ID still finds it.
    expect(dictionary.get(oldEntry.id)).toMatchObject({ definition: 'v2', chatId: NEW });
    await expect(
      update.execute(
        'update-other',
        { id: otherEntry.id, term: '别的群', definition: 'hijacked', aliases: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/group_scope_required/);
    expect(dictionary.get(otherEntry.id)?.definition).toBe('不可改');
  } finally {
    store.close();
  }
});
