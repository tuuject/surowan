import { expect, test } from 'vitest';
import { capability, createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { createDictionaryTools } from '../../src/plugins/dictionary/tools.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { DictionaryStore } from '../../src/plugins/dictionary/store.ts';
import { fixture } from './fixtures.ts';

test('lookup paginates a large match set into complete JSON pages with a next_offset', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    // Enough large entries to exceed one page, all matching the same alias.
    const created: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const entry = dictionary.create({
        term: `词条-${index}`,
        definition: `${'很长的解释'.repeat(200)} #${index}`,
        aliases: ['共享别名'],
        scope: 'global',
        chatId: null,
        enabled: true,
      });
      created.push(entry.id);
    }
    const tools = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: 123456789n,
      privateChat: false,
    });
    const [lookup] = tools;
    if (lookup === undefined) {
      throw new Error('Expected the lookup tool');
    }
    const seen = new Set<string>();
    let offset: number | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > 100) {
        throw new Error('Lookup pagination did not terminate');
      }
      const result = await lookup.execute(
        `lookup-page-${pages}`,
        offset === undefined ? { terms: ['共享别名'] } : { terms: ['共享别名'], offset },
        new AbortController().signal,
      );
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      // Every page is complete, valid JSON — never a half-cut object.
      const parsed = JSON.parse(text) as {
        entries: { id: string }[];
        total: number;
        offset: number;
        next_offset: number | null;
        more: boolean;
      };
      expect(parsed.total).toBe(40);
      expect(parsed.offset).toBe(offset ?? 0);
      expect(parsed.entries.length).toBeGreaterThan(0);
      for (const entry of parsed.entries) {
        seen.add(entry.id);
      }
      if (!parsed.more) {
        expect(parsed.next_offset).toBeNull();
        break;
      }
      expect(parsed.next_offset).toBe((offset ?? 0) + parsed.entries.length);
      offset = parsed.next_offset ?? undefined;
    }
    // Every matching entry was retrievable across the pages — none silently lost.
    expect(seen.size).toBe(40);
    for (const id of created) {
      expect(seen.has(id)).toBe(true);
    }
    expect(pages).toBeGreaterThan(1);
  } finally {
    store.close();
  }
});

test('a lookup page survives the real execute envelope without truncation', async () => {
  const { store, invocationId } = await fixture();
  try {
    const dictionary = new DictionaryStore(store.orm);
    // Definitions full of the characters the envelope escapes a second time:
    // quotes, backslashes and newlines. If the page budget ignored the envelope,
    // this content would overflow and the result would be cut.
    const nasty = `${'"quote" \\backslash\\\nnewline '.repeat(120)}`;
    for (let index = 0; index < 20; index += 1) {
      dictionary.create({
        term: `条目-${index}`,
        definition: `${nasty}#${index}`,
        aliases: ['信封别名'],
        scope: 'global',
        chatId: null,
        enabled: true,
      });
    }
    const [lookup] = createDictionaryTools({
      store: dictionary,
      orm: store.orm,
      invocationId,
      chatId: 123456789n,
      privateChat: false,
    });
    if (lookup === undefined) {
      throw new Error('Expected the lookup tool');
    }
    const execute = createExecuteTool({
      audit: createToolAudit(store, invocationId),
      capabilities: [capability(lookup, false)],
    });
    const seen = new Set<string>();
    let offset: number | undefined;
    for (let page = 0; page < 200; page += 1) {
      const result = await execute.execute(
        `exec-${page}`,
        {
          action: 'call',
          tool: 'lookup_dictionary',
          input: offset === undefined ? { terms: ['信封别名'] } : { terms: ['信封别名'], offset },
        },
        new AbortController().signal,
      );
      const envelope = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      // The envelope is never truncated: it is valid JSON with a real `text`.
      expect(envelope).not.toContain('[content truncated]');
      const outer = JSON.parse(envelope) as { text: string };
      const parsed = JSON.parse(outer.text) as {
        entries: { id: string }[];
        total: number;
        next_offset: number | null;
        more: boolean;
      };
      expect(parsed.total).toBe(20);
      for (const entry of parsed.entries) {
        seen.add(entry.id);
      }
      if (!parsed.more) {
        break;
      }
      offset = parsed.next_offset ?? undefined;
    }
    expect(seen.size).toBe(20);
  } finally {
    store.close();
  }
});
