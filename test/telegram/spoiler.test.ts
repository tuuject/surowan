import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import {
  renderSpoilers,
  spoilersFromFragment,
  SPOILER_TAG_CLOSE,
  SPOILER_TAG_OPEN,
  spoilerRanges,
} from '../../src/platform/spoilers.ts';
import { renderInvocationContext, testConfigStore, writeTestConfig, type TestInvocationContext } from '../helpers.ts';

const OPEN = SPOILER_TAG_OPEN;
const CLOSE = SPOILER_TAG_CLOSE;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

describe('spoiler ranges', () => {
  test('extracts only spoiler entities, in document order and merged', () => {
    expect(spoilerRanges(undefined, 10)).toEqual([]);
    expect(
      spoilerRanges(
        [
          { type: 'bold', offset: 0, length: 3 },
          { type: 'spoiler', offset: 6, length: 2 },
          { type: 'spoiler', offset: 1, length: 3 },
          { type: 'spoiler', offset: 3, length: 2 },
        ],
        10,
      ),
    ).toEqual([
      { start: 1, end: 5 },
      { start: 6, end: 8 },
    ]);
  });

  test('drops malformed, empty, and out-of-range entities', () => {
    expect(
      spoilerRanges(
        [
          { type: 'spoiler', offset: -1, length: 2 },
          { type: 'spoiler', offset: 2, length: 0 },
          { type: 'spoiler', offset: 40, length: 2 },
          { type: 'spoiler', offset: 8, length: 5 },
          { type: 'spoiler', offset: 1.5, length: 2 },
        ],
        10,
      ),
    ).toEqual([{ start: 8, end: 10 }]);
  });

  test('leaves text without spoilers untouched', () => {
    expect(renderSpoilers('我觉得还行', [])).toBe('我觉得还行');
    expect(renderSpoilers('我觉得还行', undefined)).toBe('我觉得还行');
  });

  test('wraps a whole-body spoiler without dropping any text', () => {
    expect(renderSpoilers('这个定价有问题', [{ start: 0, end: 7 }])).toBe(`${OPEN}这个定价有问题${CLOSE}`);
  });

  test('wraps several spoilers and mixed plain text', () => {
    const text = '我觉得这个定价有问题，而且功能也不行。';
    const first = text.indexOf('这个定价有问题');
    const second = text.indexOf('功能也不行');
    expect(
      renderSpoilers(text, [
        { start: first, end: first + '这个定价有问题'.length },
        { start: second, end: second + '功能也不行'.length },
      ]),
    ).toBe(`我觉得${OPEN}这个定价有问题${CLOSE}，而且${OPEN}功能也不行${CLOSE}。`);
  });

  test('applies Telegram UTF-16 offsets after emoji and CJK characters', () => {
    // Telegram counts UTF-16 code units: the emoji occupies two units, so the
    // spoiler starts at index 2 -- a code-point based reading would tag 觉得这.
    const text = '😀我觉得这个定价有问题🎉';
    const start = '😀'.length;
    const length = '我觉得这个'.length;
    expect(start).toBe(2);
    expect(renderSpoilers(text, [{ start, end: start + length }])).toBe(`😀${OPEN}我觉得这个${CLOSE}定价有问题🎉`);
    expect(spoilerRanges([{ type: 'spoiler', offset: start, length }], text.length)).toEqual([
      { start, end: start + length },
    ]);
  });

  test('escapes XML entities before wrapping spoiler spans so literal spoiler tags cannot forge markup', () => {
    expect(renderSpoilers('用户自己打的<tg-spoiler>假剧透</tg-spoiler>', [])).toBe(
      '用户自己打的&lt;tg-spoiler&gt;假剧透&lt;/tg-spoiler&gt;',
    );
    const text = '前置<a> & "引号" 真剧透<tag> 结尾\'单引号\'';
    const start = text.indexOf('真剧透<tag>');
    const length = '真剧透<tag>'.length;
    expect(renderSpoilers(text, [{ start, end: start + length }])).toBe(
      `前置&lt;a&gt; &amp; &quot;引号&quot; ${OPEN}真剧透&lt;tag&gt;${CLOSE} 结尾&apos;单引号&apos;`,
    );
  });
});

describe('spoiler spans from the stored fragment', () => {
  test('reads text entities out of the raw fragment', () => {
    const text = '我觉得这个定价有问题。';
    const fragment = JSON.stringify({ text, entities: [{ type: 'spoiler', offset: 3, length: 7 }] });
    expect(spoilersFromFragment(fragment, { text, caption: null })).toEqual({ text: [{ start: 3, end: 10 }] });
  });

  test('reads caption entities out of the raw fragment', () => {
    const caption = '剧透警告，慎点。';
    const fragment = JSON.stringify({ caption, caption_entities: [{ type: 'spoiler', offset: 4, length: 2 }] });
    expect(spoilersFromFragment(fragment, { text: null, caption })).toEqual({ caption: [{ start: 4, end: 6 }] });
  });

  test('reads the replied-to entities for the stored reply preview', () => {
    const replied = '结局是男主其实早就死了';
    const fragment = JSON.stringify({
      text: '真的假的',
      reply_to_message: { text: replied, entities: [{ type: 'spoiler', offset: 2, length: 9 }] },
    });
    expect(
      spoilersFromFragment(fragment, { text: '真的假的', caption: null, reply_snapshot: { content: replied } }),
    ).toEqual({ reply: [{ start: 2, end: 11 }] });
    // The adapter truncates the preview, so spans are clamped to that prefix.
    expect(
      spoilersFromFragment(fragment, { text: '真的假的', caption: null, reply_snapshot: { content: '结局是男主' } }),
    ).toEqual({ reply: [{ start: 2, end: 5 }] });
    // A caption-only replied-to message contributes its caption entities.
    expect(
      spoilersFromFragment(
        JSON.stringify({
          text: '真的假的',
          reply_to_message: { caption: '配文剧透', caption_entities: [{ type: 'spoiler', offset: 2, length: 2 }] },
        }),
        { text: '真的假的', caption: null, reply_snapshot: { content: '配文剧透' } },
      ),
    ).toEqual({ reply: [{ start: 2, end: 4 }] });
    // A preview that is no longer a prefix of the replied-to body is not trusted.
    expect(
      spoilersFromFragment(fragment, { text: '真的假的', caption: null, reply_snapshot: { content: '别的内容' } }),
    ).toBeUndefined();
    // No stored preview (for example an ignored replied-to user) means no span.
    expect(spoilersFromFragment(fragment, { text: '真的假的', caption: null, reply_snapshot: null })).toBeUndefined();
  });

  test('reports nothing for plain messages, mismatched bodies, and unreadable fragments', () => {
    expect(
      spoilersFromFragment(JSON.stringify({ text: '普通消息' }), { text: '普通消息', caption: null }),
    ).toBeUndefined();
    expect(spoilersFromFragment('{}', { text: '普通消息', caption: null })).toBeUndefined();
    expect(spoilersFromFragment(null, { text: '普通消息', caption: null })).toBeUndefined();
    expect(spoilersFromFragment('nonsense', { text: '普通消息', caption: null })).toBeUndefined();
    // An entity list belongs to the body the fragment carries: a revision whose
    // text was rewritten (for example an edit) must not borrow stale offsets.
    expect(
      spoilersFromFragment(JSON.stringify({ text: '旧版本', entities: [{ type: 'spoiler', offset: 0, length: 3 }] }), {
        text: '新版本内容',
        caption: null,
      }),
    ).toBeUndefined();
    // A media message keeps its caption entities away from the text field.
    expect(
      spoilersFromFragment(
        JSON.stringify({ caption: '配文', caption_entities: [{ type: 'spoiler', offset: 0, length: 2 }] }),
        { text: '配文', caption: null },
      ),
    ).toBeUndefined();
  });
});

async function setup(): Promise<{
  store: SqliteStore;
  config: RawConfig;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  build: (invocationId: bigint) => TestInvocationContext;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-spoiler-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    build: (invocationId: bigint) => renderInvocationContext(store, loaded.config, invocationId),
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

describe('telegram spoiler context', () => {
  test('keeps the body text verbatim and the entity detail in the raw fragment', async () => {
    const { store, ingestion } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const text = '我觉得这个产品的定价有问题，不过只是个人看法。';
    const start = text.indexOf('这个产品的定价有问题');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          text,
          entities: [{ type: 'spoiler', offset: start, length: '这个产品的定价有问题'.length }],
        },
      } as unknown as Update,
      received,
    );
    ingestion.ingest({ update_id: 2, message: { ...baseMessage(2), text: '没有剧透' } } as unknown as Update, received);
    const rows = store.db
      .prepare<[], { telegram_message_id: bigint; text: string | null; raw_fragment_json: string }>(
        'SELECT telegram_message_id, text, raw_fragment_json FROM message_revisions r JOIN messages m ON m.id = r.message_id ORDER BY telegram_message_id, revision_no',
      )
      .all();
    expect(rows.map((row) => row.text)).toEqual([text, '没有剧透']);
    expect(rows[0]?.raw_fragment_json).toContain('"type":"spoiler"');
    expect(rows[0]?.raw_fragment_json).toContain(`"offset":${start}`);
    expect(rows[1]?.raw_fragment_json).not.toContain('spoiler');
    store.close();
  });

  test('renders plain text exactly as before', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      { update_id: 1, message: { ...baseMessage(1), text: '我觉得还行' } } as unknown as Update,
      received,
    );
    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(context)).toBe([header(1), '  我觉得还行', '</untrusted_new_messages>'].join('\n'));
    const snapshot = store.db
      .prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages LIMIT 1')
      .get();
    expect(snapshot?.snapshot_json).not.toContain('spoilers');
    store.close();
  });

  test('marks a partial spoiler while keeping the original text', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const text = '我觉得这个产品的定价有问题，不过只是个人看法。';
    const start = text.indexOf('这个产品的定价有问题');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          text,
          entities: [{ type: 'spoiler', offset: start, length: '这个产品的定价有问题'.length }],
        },
      } as unknown as Update,
      received,
    );
    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(context)).toBe(
      [header(1), `  我觉得${OPEN}这个产品的定价有问题${CLOSE}，不过只是个人看法。`, '</untrusted_new_messages>'].join(
        '\n',
      ),
    );
    store.close();
  });

  test('marks a whole-message spoiler and several spoilers in one message', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 1,
        message: { ...baseMessage(1), text: '剧透警告', entities: [{ type: 'spoiler', offset: 0, length: 4 }] },
      } as unknown as Update,
      received,
    );
    const first = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(first)).toBe([header(1), `  ${OPEN}剧透警告${CLOSE}`, '</untrusted_new_messages>'].join('\n'));
    store.db.prepare("UPDATE buckets SET state = 'completed'").run();
    store.db.prepare("UPDATE invocations SET state = 'completed'").run();

    const secondReceived = new Date(received.getTime() + 60_000);
    const text = '先说结论，然后再补充两句。';
    ingestion.ingest(
      {
        update_id: 2,
        message: {
          ...baseMessage(2),
          text,
          entities: [
            { type: 'spoiler', offset: 0, length: 2 },
            { type: 'spoiler', offset: text.indexOf('再补充两句'), length: '再补充两句'.length },
          ],
        },
      } as unknown as Update,
      secondReceived,
    );
    const second = build(processOne(scheduler, new Date(secondReceived.getTime() + 15_000)));
    expect(newMessages(second)).toBe(
      [header(2), `  ${OPEN}先说${CLOSE}结论，然后${OPEN}再补充两句${CLOSE}。`, '</untrusted_new_messages>'].join('\n'),
    );
    store.close();
  });

  test('keeps spoiler markup correct around emoji and other entities', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    // '🎉' is two UTF-16 units, so the spoiler offsets sit after it, and the
    // bold entity is unrelated formatting that must not become markup.
    const text = '🎉我觉得这个定价有问题';
    const start = 2;
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          text,
          entities: [
            { type: 'bold', offset: 0, length: start },
            { type: 'spoiler', offset: start, length: '我觉得这个定价有问题'.length },
          ],
        },
      } as unknown as Update,
      received,
    );
    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(context)).toBe(
      [header(1), `  🎉${OPEN}我觉得这个定价有问题${CLOSE}`, '</untrusted_new_messages>'].join('\n'),
    );
    store.close();
  });

  test('marks a spoiler inside a media caption', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const caption = '这家店的甜品还行，不过价格有点离谱。';
    const start = caption.indexOf('价格有点离谱');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          caption,
          caption_entities: [{ type: 'spoiler', offset: start, length: '价格有点离谱'.length }],
          photo: [{ file_id: 'file-1', file_unique_id: 'unique-1', width: 90, height: 90 }],
        },
      } as unknown as Update,
      received,
    );
    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(context.userPrompt).toContain(`  这家店的甜品还行，不过${OPEN}价格有点离谱${CLOSE}。`);
    store.close();
  });

  test('marks a spoiler inside the quoted preview of an outside reply target', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const replied = '结局是男主其实早就死了';
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(2),
          text: '真的假的',
          reply_to_message: {
            ...baseMessage(1),
            text: replied,
            entities: [{ type: 'spoiler', offset: 2, length: replied.length - 2 }],
          },
        },
      } as unknown as Update,
      received,
    );
    const context = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(context)).toBe(
      [
        header(2, ' re:1'),
        `  > Alice: 结局${OPEN}是男主其实早就死了${CLOSE}`,
        '  真的假的',
        '</untrusted_new_messages>',
      ].join('\n'),
    );
    const snapshot = store.db
      .prepare<[], { snapshot_json: string }>('SELECT snapshot_json FROM invocation_messages LIMIT 1')
      .get();
    // The stored preview itself stays verbatim; only the spans ride along.
    expect(JSON.parse(snapshot?.snapshot_json ?? '{}')).toMatchObject({
      reply_snapshot: { content: replied },
      spoilers: { reply: [{ start: 2, end: replied.length }] },
    });
    store.close();
  });

  test('keeps spoiler markup in retained history', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    const text = '我觉得这个产品的定价有问题。';
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          ...baseMessage(1),
          text,
          entities: [{ type: 'spoiler', offset: 3, length: '这个产品的定价有问题'.length }],
        },
      } as unknown as Update,
      received,
    );
    const first = build(processOne(scheduler, new Date(received.getTime() + 15_000)));
    expect(newMessages(first)).toContain(`${OPEN}这个产品的定价有问题${CLOSE}`);
    store.db.prepare("UPDATE buckets SET state = 'completed'").run();
    store.db.prepare("UPDATE invocations SET state = 'completed'").run();

    const secondReceived = new Date(received.getTime() + 60_000);
    ingestion.ingest(
      { update_id: 2, message: { ...baseMessage(2), text: '那你怎么看' } } as unknown as Update,
      secondReceived,
    );
    const second = build(processOne(scheduler, new Date(secondReceived.getTime() + 15_000)));
    const history = second.userPrompt.split('<untrusted_telegram_history>\n')[1] ?? '';
    expect(history).toContain(`  我觉得${OPEN}这个产品的定价有问题${CLOSE}。`);
    store.close();
  });
});
