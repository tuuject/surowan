import { expect, test } from 'vitest';
import { unifiedPromptDiff } from '../../src/ingress/admin/prompt-diff.ts';
import { recordPromptVersion } from '../../src/store/prompt-versions.ts';
import { fixture } from './admin-fixtures.ts';

test('unifiedPromptDiff groups changed lines into hunks with both line numbers', () => {
  const from = ['one', 'two', 'three', 'four', 'five'].join('\n');
  const to = ['one', 'two', 'THREE', 'four', 'five', 'six'].join('\n');
  expect(unifiedPromptDiff(from, to)).toEqual([
    {
      fromStart: 1,
      fromCount: 5,
      toStart: 1,
      toCount: 6,
      lines: [
        { type: 'context', text: 'one', fromLine: 1, toLine: 1 },
        { type: 'context', text: 'two', fromLine: 2, toLine: 2 },
        { type: 'removed', text: 'three', fromLine: 3, toLine: null },
        { type: 'added', text: 'THREE', fromLine: null, toLine: 3 },
        { type: 'context', text: 'four', fromLine: 4, toLine: 4 },
        { type: 'context', text: 'five', fromLine: 5, toLine: 5 },
        { type: 'added', text: 'six', fromLine: null, toLine: 6 },
      ],
    },
  ]);
  expect(unifiedPromptDiff('same', 'same')).toEqual([]);
  expect(unifiedPromptDiff('', 'added')).toEqual([
    {
      fromStart: 0,
      fromCount: 0,
      toStart: 1,
      toCount: 1,
      lines: [{ type: 'added', text: 'added', fromLine: null, toLine: 1 }],
    },
  ]);
  expect(unifiedPromptDiff('gone', '')).toEqual([
    {
      fromStart: 1,
      fromCount: 1,
      toStart: 0,
      toCount: 0,
      lines: [{ type: 'removed', text: 'gone', fromLine: 1, toLine: null }],
    },
  ]);
});

test('prompt versions deduplicate identical content and prune to the retained count', async () => {
  const { store } = await fixture();
  try {
    const orm = store.orm;
    // The startup load recorded the starting global prompt as version 1.
    const first = recordPromptVersion(orm, 'global', 0n, 'base', 'panel', 'first', 'owner');
    expect(first?.seq).toBe(2n);
    expect(recordPromptVersion(orm, 'global', 0n, 'base', 'panel', 'again', 'owner')).toBeNull();
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM prompt_versions WHERE scope = 'global'")
        .get()?.count,
    ).toBe(2n);
    for (let index = 0; index < 105; index += 1) {
      recordPromptVersion(orm, 'global', 0n, `content ${index}`, 'panel', undefined, 'owner');
    }
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM prompt_versions WHERE scope = 'global'")
        .get()?.count,
    ).toBe(100n);
    expect(
      store.db.prepare<[], { min: bigint }>("SELECT MIN(seq) AS min FROM prompt_versions WHERE scope = 'global'").get()
        ?.min,
    ).toBe(8n);
  } finally {
    store.close();
  }
});
