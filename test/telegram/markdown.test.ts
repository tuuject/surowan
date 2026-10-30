import { describe, expect, test } from 'vitest';
import { formatSnapshot } from '../../src/context/builder/format.ts';
import type { PreparedSnapshot } from '../../src/context/builder/schema.ts';
import { renderSpoilers, SPOILER_TAG_CLOSE, SPOILER_TAG_OPEN } from '../../src/platform/spoilers.ts';
import { bodyFromFragment, entitiesMarkdown, richMessageMarkdown } from '../../src/platform/telegram-markdown/index.ts';
import { entity, RICH_MEDIA } from './markdown-fixtures.ts';

const OPEN = SPOILER_TAG_OPEN;
const CLOSE = SPOILER_TAG_CLOSE;

describe('text entities as Markdown', () => {
  test('leaves text without formatting entities unchanged', () => {
    const text = '@alice 看看 https://t.me #tag /start';
    const entities = [
      entity(text, '@alice', 'mention'),
      entity(text, 'https://t.me', 'url'),
      entity(text, '#tag', 'hashtag'),
      entity(text, '/start', 'bot_command'),
    ];
    expect(entitiesMarkdown(text, entities)).toEqual({ text, spoilers: [] });
    expect(entitiesMarkdown(text, undefined)).toEqual({ text, spoilers: [] });
  });

  test('writes inline formatting, links and mentions as Markdown', () => {
    const text = '粗体 斜体 删除 代码 官网 小明 下划线';
    expect(
      entitiesMarkdown(text, [
        entity(text, '粗体', 'bold'),
        entity(text, '斜体', 'italic'),
        entity(text, '删除', 'strikethrough'),
        entity(text, '代码', 'code'),
        entity(text, '官网', 'text_link', { url: 'https://example.com/a b' }),
        entity(text, '小明', 'text_mention', { user: { id: 42, is_bot: false, first_name: '小明' } }),
        entity(text, '下划线', 'underline'),
      ]).text,
    ).toBe('**粗体** _斜体_ ~~删除~~ `代码` [官网](https://example.com/a%20b) [小明](tg://user?id=42) 下划线');
  });

  test('nests formatting and keeps a spoiler range on the Markdown body after emoji', () => {
    const text = '😀 bold italic link spoiler';
    const body = entitiesMarkdown(text, [
      entity(text, 'bold italic link', 'bold'),
      entity(text, 'italic link', 'italic'),
      entity(text, 'link', 'text_link', { url: 'https://t.me/' }),
      entity(text, 'spoiler', 'spoiler'),
    ]);
    expect(body.text).toBe('😀 **bold _italic [link](https://t.me/)_** spoiler');
    expect(body.spoilers).toEqual([{ start: body.text.indexOf('spoiler'), end: body.text.length }]);
  });

  test('puts code blocks and quotes on lines of their own', () => {
    const text = "看这段 print('```') 然后\n引用第一行\n引用第二行\n结束";
    const body = entitiesMarkdown(text, [
      entity(text, "print('```')", 'pre', { language: 'python' }),
      entity(text, '引用第一行\n引用第二行', 'blockquote'),
      entity(text, '第二', 'bold'),
    ]);
    expect(body.text).toBe(
      ['看这段 ', '````python', "print('```')", '````', ' 然后', '> 引用第一行', '> 引用**第二**行', '结束'].join('\n'),
    );
  });

  test('clips crossing entities, ignores nesting inside code and drops malformed entries', () => {
    const text = 'abcdef';
    expect(
      entitiesMarkdown(text, [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'italic', offset: 2, length: 4 },
        { type: 'code', offset: 4, length: 2 },
        { type: 'bold', offset: 5, length: 1 },
        { type: 'text_link', offset: 0, length: 1 },
        { type: 'italic', offset: -1, length: 2 },
        { type: 'italic', offset: 1.5, length: 2 },
        'garbage',
      ]).text,
    ).toBe('**ab_cd_**`ef`');
  });
});

const RICH_DOCUMENT = {
  blocks: [
    { type: 'heading', size: 2, text: 'Weekly digest' },
    {
      type: 'paragraph',
      text: [
        'Intro with ',
        { type: 'bold', text: 'bold' },
        ', ',
        { type: 'italic', text: ['italic ', { type: 'code', text: 'x`y' }] },
        ' and ',
        { type: 'url', text: 'a link', url: 'https://t.me/' },
        ', ',
        { type: 'url', text: 't.me', url: 'https://t.me/' },
        ', ',
        { type: 'custom_emoji', custom_emoji_id: '5368324170671202286', alternative_text: '👍' },
        ', ',
        { type: 'mathematical_expression', expression: 'x^2' },
        '.',
      ],
    },
    { type: 'anchor', name: 'chapter-1' },
    {
      type: 'list',
      items: [
        { label: '•', blocks: [{ type: 'paragraph', text: 'first' }] },
        {
          label: '•',
          blocks: [
            { type: 'paragraph', text: 'second' },
            {
              type: 'list',
              items: [{ label: '1.', value: 1, type: '1', blocks: [{ type: 'paragraph', text: 'nested' }] }],
            },
          ],
        },
        { label: '•', has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'done' }] },
      ],
    },
    { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'Quoted\nsecond line' }], credit: 'Someone' },
    { type: 'pre', language: 'python', text: "print('hi')" },
    {
      type: 'table',
      caption: 'Numbers',
      cells: [
        [
          { text: 'Metric', is_header: true, align: 'left', valign: 'top' },
          { text: 'Value', is_header: true, align: 'right', valign: 'top' },
        ],
        [
          { text: 'Speed | max', align: 'left', valign: 'top' },
          { text: { type: 'bold', text: '42' }, align: 'right', valign: 'top' },
        ],
        [{ text: 'Merged', colspan: 2, align: 'left', valign: 'top' }],
      ],
    },
    { type: 'divider' },
    { type: 'mathematical_expression', expression: 'E = mc^2' },
    {
      type: 'details',
      summary: 'More',
      blocks: [{ type: 'paragraph', text: 'Hidden detail' }],
    },
    {
      type: 'buttons',
      buttons: [
        { text: 'Open', url: 'https://example.com/' },
        { text: 'Vote', callback_data: 'vote' },
      ],
    },
  ],
};

describe('rich messages as Markdown', () => {
  test('flattens the block structure into ordinary Markdown', () => {
    const flattened = richMessageMarkdown(RICH_DOCUMENT);
    expect(flattened.text).toBe(
      [
        '## Weekly digest',
        '',
        'Intro with **bold**, _italic ``x`y``_ and [a link](https://t.me/), t.me, 👍, $x^2$.',
        '',
        '- first',
        '- second',
        '  1. nested',
        '- [x] done',
        '',
        '> Quoted',
        '> second line',
        '> — Someone',
        '',
        '```python',
        "print('hi')",
        '```',
        '',
        'Numbers',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Speed \\| max | **42** |',
        '| Merged |  |',
        '',
        '---',
        '',
        '$$',
        'E = mc^2',
        '$$',
        '',
        '**More**',
        '',
        'Hidden detail',
        '',
        '[Open](https://example.com/) [Vote]',
      ].join('\n'),
    );
    expect(flattened.media).toEqual([]);
    expect(flattened.slots).toEqual([]);
    expect(flattened.spoilers).toEqual([]);
  });

  test('turns photos and image documents into media slots in document order', () => {
    const flattened = richMessageMarkdown(RICH_MEDIA);
    expect(flattened.text).toBe(
      [
        'Look:',
        '',
        '[photo]',
        '[photo]',
        'Two shots — Alice',
        '',
        '[video]',
        'A clip',
        '',
        '[document: chart.png]',
        '',
        '[document: report.pdf]',
        '',
        '[audio: Band – Song]',
        '',
        'Secret: it was the butler',
      ].join('\n'),
    );
    expect(flattened.media.map((item) => (item.kind === 'photo' ? item.photo.file_id : item.document.file_id))).toEqual(
      ['photo-1-large', 'photo-2', 'chart'],
    );
    expect(flattened.slots.map((slot) => flattened.text.slice(slot.start, slot.end))).toEqual([
      '[photo]',
      '[photo]',
      '[document: chart.png]',
    ]);
    expect(flattened.spoilers.map((range) => flattened.text.slice(range.start, range.end))).toEqual([
      'it was the butler',
    ]);
  });

  test.each(['pre', 'code'])('keeps %s style runs and link labels literal', (type) => {
    const text = [
      'console.',
      { type: 'bold', text: 'log' },
      { type: 'url', text: '(1)', url: 'https://example.com/not-code' },
    ];
    const block = type === 'pre' ? { type, text } : { type: 'paragraph', text: { type, text } };
    expect(richMessageMarkdown({ blocks: [block] })).toEqual({
      text: type === 'pre' ? '```\nconsole.log(1)\n```' : '`console.log(1)`',
      spoilers: [],
      slots: [],
      media: [],
    });
  });

  test.each(['pre', 'code'])('keeps partial %s spoilers after emoji, backticks and blank lines', (type) => {
    const before = '\n😀 `open`\n';
    const hidden = '密`码\n\n😀secret';
    const after = '\nend\n';
    const text = [before, { type: 'bold', text: { type: 'spoiler', text: hidden } }, after];
    const block = type === 'pre' ? { type, language: 'js', text } : { type: 'paragraph', text: { type, text } };
    const body = richMessageMarkdown({ blocks: [block] });
    const opening = type === 'pre' ? '```js\n' : '``';
    const closing = type === 'pre' ? '\n```' : '``';
    expect(body.text).toBe(opening + before + hidden + after + closing);
    expect(body.spoilers).toEqual([
      { start: opening.length + before.length, end: opening.length + before.length + hidden.length },
    ]);
    expect(body.text.slice(body.spoilers[0]?.start, body.spoilers[0]?.end)).toBe(hidden);
  });

  test.each(['pre', 'code'])('keeps full nested %s spoilers without hiding its fences', (type) => {
    const hidden = '`😀\n\nsecret`';
    const text = { type: 'spoiler', text: { type: 'url', text: hidden, url: 'https://example.com/' } };
    const block = type === 'pre' ? { type, text } : { type: 'paragraph', text: { type, text } };
    const body = richMessageMarkdown({ blocks: [block] });
    const opening = type === 'pre' ? '```\n' : '`` ';
    const closing = type === 'pre' ? '\n```' : ' ``';
    expect(body.text).toBe(opening + hidden + closing);
    expect(body.spoilers).toEqual([{ start: opening.length, end: opening.length + hidden.length }]);
  });

  test('inherits spoilers around inline code including padding and fences', () => {
    const body = richMessageMarkdown({
      blocks: [
        {
          type: 'paragraph',
          text: ['😀 ', { type: 'spoiler', text: { type: 'code', text: '`😀\n\nsecret`' } }],
        },
      ],
    });
    expect(body.text).toBe('😀 `` `😀\n\nsecret` ``');
    expect(body.spoilers).toEqual([{ start: 3, end: body.text.length }]);
  });

  test('survives malformed and unknown content', () => {
    expect(richMessageMarkdown(null).text).toBe('');
    expect(
      richMessageMarkdown({
        blocks: [
          { type: 'future_block', text: 'still readable' },
          { type: 'photo', photo: [{ file_id: 'no-size' }] },
          { type: 'table', cells: 'nope' },
          { type: 'paragraph', text: { type: 'future_run', text: ['nested ', { type: 'bold', text: 'run' }] } },
          42,
        ],
      }),
    ).toEqual({ text: 'still readable\n\n[photo]\n\nnested **run**', spoilers: [], slots: [], media: [] });
  });
});

describe('message bodies from the stored fragment', () => {
  test('covers complete caption mention targets regardless of entity order', () => {
    const caption = '😀 Alice';
    const entities = [
      { type: 'text_mention', offset: 3, length: 5, user: { id: 42, is_bot: false, first_name: 'Alice' } },
      { type: 'spoiler', offset: 3, length: 5 },
    ];
    for (const ordered of [entities, entities.toReversed()]) {
      const body = bodyFromFragment(JSON.stringify({ caption, caption_entities: ordered }), {
        text: null,
        caption,
        mediaCount: 0,
      });
      expect(renderSpoilers(body.caption ?? '', body.spoilers?.caption)).toBe(
        `😀 ${OPEN}[Alice](tg://user?id=42)${CLOSE}`,
      );
    }
  });

  test('keeps the stored body when the fragment no longer matches it', () => {
    const rich = richMessageMarkdown(RICH_MEDIA);
    const fragment = JSON.stringify({ rich_message: RICH_MEDIA });
    expect(bodyFromFragment(fragment, { text: rich.text, caption: null, mediaCount: 3 })).toEqual({
      text: rich.text,
      caption: null,
      spoilers: { text: rich.spoilers },
      media_slots: rich.slots,
      match_text: ['Look:\nTwo shots\nAlice\nA clip\nSecret: it was the butler'],
    });
    // A different flattening (an older revision, or newer code) keeps the
    // stored Markdown but trusts none of its ranges.
    expect(bodyFromFragment(fragment, { text: 'edited elsewhere', caption: null, mediaCount: 3 })).toEqual({
      text: 'edited elsewhere',
      caption: null,
    });
    // Slots only ride along when they match the stored media one to one.
    expect(bodyFromFragment(fragment, { text: rich.text, caption: null, mediaCount: 2 }).media_slots).toBeUndefined();
    const text = 'plain bold';
    expect(
      bodyFromFragment(JSON.stringify({ text: 'older', entities: [entity(text, 'bold', 'bold')] }), {
        text,
        caption: null,
        mediaCount: 0,
      }),
    ).toEqual({ text, caption: null });
  });

  test('renders caption entities but never borrows them for the text', () => {
    const caption = '配文 粗体';
    const fragment = JSON.stringify({ caption, caption_entities: [entity(caption, '粗体', 'bold')] });
    expect(bodyFromFragment(fragment, { text: null, caption, mediaCount: 1 })).toEqual({
      text: null,
      caption: '配文 **粗体**',
      match_text: [caption],
    });
    expect(bodyFromFragment(fragment, { text: caption, caption: null, mediaCount: 1 })).toEqual({
      text: caption,
      caption: null,
    });
  });

  test('reads spoilers of a replied-to rich message for its stored preview', () => {
    const rich = richMessageMarkdown(RICH_MEDIA);
    const fragment = JSON.stringify({ text: '真的假的', reply_to_message: { rich_message: RICH_MEDIA } });
    const start = rich.text.indexOf('it was the butler');
    expect(
      bodyFromFragment(fragment, {
        text: '真的假的',
        caption: null,
        reply_snapshot: { content: rich.text },
        mediaCount: 0,
      }).spoilers,
    ).toEqual({ reply: [{ start, end: start + 'it was the butler'.length }] });
  });
});

describe('media slots in the rendered body', () => {
  const snapshot = (overrides: Partial<PreparedSnapshot>): PreparedSnapshot => ({
    message_id: '7',
    telegram_date: '2026-08-15T00:00:00.000Z',
    sent_by_bot: false,
    sender: { id: '42', name: 'Alice', username: null },
    kind: 'rich_message',
    text: 'Look:\n[photo]\nafter <b>',
    caption: null,
    reply_to_message_id: null,
    reply_snapshot: null,
    forward_origin: null,
    media_group_id: null,
    media: [{ image_ref: 'img_a', kind: 'photo', mime_type: 'image/jpeg', width: '10', height: '20' }],
    ...overrides,
  });
  const options = { timezone: 'UTC', now: new Date('2026-08-15T00:00:00.000Z'), inlineReplies: new Set<string>() };

  test('puts each media line where its placeholder was', () => {
    expect(
      formatSnapshot(
        snapshot({
          media_slots: [{ start: 6, end: 13 }],
          spoilers: {
            text: [
              { start: 0, end: 4 },
              { start: 14, end: 19 },
            ],
          },
        }),
        options,
      ),
    ).toBe(
      [
        '[7 00:00:00 uid:42] Alice',
        `  ${OPEN}Look${CLOSE}:`,
        '  [photo img_a 10x20]',
        `  ${OPEN}after${CLOSE} &lt;b&gt;`,
      ].join('\n'),
    );
  });

  test('falls back to trailing media lines when slots do not line up', () => {
    for (const media_slots of [
      [{ start: 6, end: 40 }],
      [
        { start: 6, end: 13 },
        { start: 14, end: 19 },
      ],
      [{ start: 13, end: 6 }],
    ]) {
      expect(formatSnapshot(snapshot({ media_slots }), options)).toBe(
        ['[7 00:00:00 uid:42] Alice', '  Look:', '  [photo]', '  after &lt;b&gt;', '  [photo img_a 10x20]'].join('\n'),
      );
    }
  });
});
