import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SPOILER_TAG_CLOSE, SPOILER_TAG_OPEN } from '../../src/platform/spoilers.ts';
import { richMessageMarkdown } from '../../src/platform/telegram-markdown/index.ts';
import { renderInvocationContext, testConfigStore, writeTestConfig, type TestInvocationContext } from '../helpers.ts';
import { entity, RICH_MEDIA } from './markdown-fixtures.ts';

const OPEN = SPOILER_TAG_OPEN;
const CLOSE = SPOILER_TAG_CLOSE;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup(): Promise<{
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  build: (invocationId: bigint, supportsImages?: boolean) => TestInvocationContext;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-markdown-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (invocationId, supportsImages = false) =>
      renderInvocationContext(store, loaded.config, invocationId, { supportsImages }),
  };
}

function baseMessage(messageId: number) {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: { id: 123456789, type: 'private' as const, first_name: 'Owner' as string },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
  };
}

function header(messageId: number, extra = ''): string {
  const time = new Date((1_700_000_000 + messageId) * 1000).toISOString().slice(0, 19);
  return `[${messageId} ${time}${extra} uid:42] Alice`;
}

function newMessages(context: TestInvocationContext): string {
  return context.userPrompt.split('<untrusted_new_messages>\n')[1] ?? '';
}

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

function finishAll(store: SqliteStore): void {
  store.db.prepare("UPDATE buckets SET state = 'completed'").run();
  store.db.prepare("UPDATE invocations SET state = 'completed'").run();
}

describe('formatted Telegram messages in the agent context', () => {
  test('freezes full linked spoilers including URLs while preserving partial label spoilers', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date();
    const text = '😀 secret';
    const url = 'https://example.com/private-information';
    try {
      for (const [index, length] of [6, 3].entries()) {
        ingestion.ingest(
          {
            update_id: index + 1,
            message: {
              ...baseMessage(index + 1),
              text,
              entities: [
                { type: 'text_link', offset: 3, length: 6, url },
                { type: 'spoiler', offset: 3, length },
              ],
            },
          } as unknown as Update,
          received,
        );
      }
      const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
      expect(context.userPrompt).toContain(`😀 ${OPEN}[secret](${url})${CLOSE}`);
      expect(context.userPrompt).toContain(`😀 [${OPEN}sec${CLOSE}ret](${url})`);
      const snapshots = store.db
        .prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages ORDER BY sequence_no')
        .all()
        .map(
          (row) =>
            JSON.parse(row.snapshot_json) as { text: string; spoilers: { text: { start: number; end: number }[] } },
        );
      expect(
        snapshots.map((snapshot) => snapshot.spoilers.text.map((range) => snapshot.text.slice(range.start, range.end))),
      ).toEqual([[`[secret](${url})`], ['sec']]);
    } finally {
      store.close();
    }
  });

  test('shows text and caption formatting as Markdown while the revision keeps Telegram text', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const text = '看文档 并且注意\n这一行是引用';
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          text,
          entities: [
            entity(text, '文档', 'text_link', { url: 'https://example.com/docs?a=1&b=2' }),
            entity(text, '注意', 'bold'),
            entity(text, '这一行是引用', 'blockquote'),
          ],
        },
      } as unknown as Update,
      received,
    );
    const caption = '截图 里的报错';
    ingestion.ingest(
      {
        update_id: 2,
        message: {
          ...baseMessage(2),
          caption,
          caption_entities: [entity(caption, '报错', 'code')],
          photo: [{ file_id: 'file-1', file_unique_id: 'unique-1', width: 90, height: 60 }],
        },
      } as unknown as Update,
      received,
    );
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId);
    const ref = /\[photo (img_[^\s\]]+) 90x60\]/.exec(context.userPrompt)?.[1];
    expect(newMessages(context)).toBe(
      [
        header(1),
        '  看[文档](https://example.com/docs?a=1&amp;b=2) 并且**注意**',
        '  &gt; 这一行是引用',
        header(2),
        '  截图 里的`报错`',
        `  [photo ${ref} 90x60]`,
        '</untrusted_new_messages>',
      ].join('\n'),
    );
    expect(
      store.db
        .prepare<[], { text: string | null; caption: string | null }>(
          'SELECT text, caption FROM message_revisions ORDER BY id',
        )
        .all(),
    ).toEqual([
      { text, caption: null },
      { text: null, caption },
    ]);
    const snapshots = store.db
      .prepare<[bigint], { snapshot_json: string }>(
        'SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? ORDER BY sequence_no',
      )
      .all(invocationId)
      .map((row) => JSON.parse(row.snapshot_json));
    expect(snapshots).toMatchObject([{ match_text: [text] }, { match_text: [caption] }]);
    store.close();
  });

  test('stores a rich message as Markdown with its pictures and shows each picture in place', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      { update_id: 1, message: { ...baseMessage(1), rich_message: RICH_MEDIA } } as unknown as Update,
      received,
    );
    const revision = store.db
      .prepare<[], { id: bigint; kind: string; text: string | null }>('SELECT id, kind, text FROM message_revisions')
      .get();
    expect(revision).toMatchObject({ kind: 'rich_message', text: richMessageMarkdown(RICH_MEDIA).text });
    expect(
      store.db
        .prepare<[], { kind: string; file_id: string; width: bigint | null; height: bigint | null }>(
          'SELECT kind, file_id, width, height FROM media ORDER BY id',
        )
        .all(),
    ).toEqual([
      { kind: 'photo', file_id: 'photo-1-large', width: 1280n, height: 853n },
      { kind: 'photo', file_id: 'photo-2', width: 800n, height: 600n },
      { kind: 'document', file_id: 'chart', width: null, height: null },
    ]);

    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)), true);
    const refs = [...context.userPrompt.matchAll(/\[(?:photo|document) figure_\d+ (img_[^\s\]]+)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(refs).toHaveLength(3);
    expect(newMessages(context)).toBe(
      [
        header(1),
        '  Look:',
        '  ',
        `  [photo figure_1 ${refs[0]} 1280x853]`,
        `  [photo figure_2 ${refs[1]} 800x600]`,
        '  Two shots — Alice',
        '  ',
        '  [video]',
        '  A clip',
        '  ',
        `  [document figure_3 ${refs[2]}]`,
        '  ',
        '  [document: report.pdf]',
        '  ',
        '  [audio: Band – Song]',
        '  ',
        `  Secret: ${OPEN}it was the butler${CLOSE}`,
        '</untrusted_new_messages>',
      ].join('\n'),
    );
    // Attachments follow the figure order, and each ref resolves to its own
    // media row through the Conversation's capability table.
    const mediaIds = store.db
      .prepare<[], { id: bigint }>('SELECT id FROM media ORDER BY id')
      .all()
      .map((row) => row.id);
    expect(context.directImages.map((image) => [image.imageRef, image.mediaId])).toEqual([
      ['figure_1', mediaIds[0]],
      ['figure_2', mediaIds[1]],
      ['figure_3', mediaIds[2]],
    ]);
    for (const [index, ref] of refs.entries()) {
      expect(
        store.db
          .prepare<[string], { media_id: bigint }>("SELECT media_id FROM context_refs WHERE ref = ? AND kind = 'media'")
          .get(ref)?.media_id,
      ).toBe(mediaIds[index]);
    }
    const snapshot = JSON.parse(
      store.db.prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages').get()
        ?.snapshot_json ?? '{}',
    );
    expect(snapshot.media_slots).toEqual(richMessageMarkdown(RICH_MEDIA).slots);
    expect(snapshot.match_text).toEqual(['Look:\nTwo shots\nAlice\nA clip\nSecret: it was the butler']);
    store.close();
  });

  test('keeps rich pictures in place in retained history and quotes a replied-to rich message', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      { update_id: 1, message: { ...baseMessage(1), rich_message: RICH_MEDIA } } as unknown as Update,
      received,
    );
    processOne(scheduler, new Date(received.getTime() + 15_000));
    finishAll(store);

    const later = new Date(received.getTime() + 60_000);
    ingestion.ingest(
      { update_id: 2, message: { ...baseMessage(2), text: '第二张是哪里' } } as unknown as Update,
      later,
    );
    const second = build(processOne(scheduler, new Date(later.getTime() + 15_000)));
    const history = second.userPrompt
      .split('<untrusted_telegram_history>\n')[1]
      ?.split('</untrusted_telegram_history>')[0];
    expect(history).toMatch(/^ {2}\[photo img_\S+ 1280x853\]\n {2}\[photo img_\S+ 800x600\]\n {2}Two shots — Alice$/m);
    finishAll(store);

    // A reply to a rich message that is not in the batch quotes its Markdown.
    const quoteAt = new Date(later.getTime() + 60_000);
    ingestion.ingest(
      {
        update_id: 3,
        message: {
          ...baseMessage(4),
          text: '真的假的',
          reply_to_message: {
            ...baseMessage(3),
            rich_message: { blocks: [{ type: 'heading', size: 1, text: 'Plan' }] },
          },
        },
      } as unknown as Update,
      quoteAt,
    );
    const third = build(processOne(scheduler, new Date(quoteAt.getTime() + 15_000)));
    expect(newMessages(third)).toBe(
      [header(4, ' re:3'), '  > Alice: # Plan', '  真的假的', '</untrusted_new_messages>'].join('\n'),
    );
    store.close();
  });

  test('omits matching overrides for unchanged bodies and distrusts mismatched rich fragments', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    try {
      const received = new Date('2026-08-15T00:00:00.000Z');
      const rich = { blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'Frozen' }] }] };
      const messages = [
        { ...baseMessage(1), text: 'Plain text' },
        { ...baseMessage(2), rich_message: { blocks: [{ type: 'paragraph', text: 'Plain rich text' }] } },
        { ...baseMessage(3), rich_message: rich },
      ];
      for (const [index, message] of messages.entries()) {
        ingestion.ingest({ update_id: index + 1, message } as unknown as Update, received);
      }
      // A fragment that no longer describes the stored body cannot supply matching text.
      store.db
        .prepare<[string]>(
          'UPDATE message_revisions SET raw_fragment_json = ? WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 3)',
        )
        .run(JSON.stringify({ rich_message: { blocks: [{ type: 'paragraph', text: 'Untrusted replacement' }] } }));
      const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
      const snapshots = store.db
        .prepare<[bigint], { snapshot_json: string }>(
          'SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? ORDER BY sequence_no',
        )
        .all(invocationId)
        .map((row) => JSON.parse(row.snapshot_json));
      expect(snapshots.map((snapshot) => snapshot.text)).toEqual(['Plain text', 'Plain rich text', '**Frozen**']);
      for (const snapshot of snapshots) {
        expect(snapshot).not.toHaveProperty('match_text');
      }
      const context = build(invocationId);
      expect(context.userPrompt).toContain('**Frozen**');
      expect(context.userPrompt).not.toContain('Untrusted replacement');
    } finally {
      store.close();
    }
  });
});
