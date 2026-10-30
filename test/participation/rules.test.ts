import { describe, expect, test } from 'vitest';
import type { Message } from 'grammy/types';
import {
  type ParticipationRule,
  compileParticipation,
  isWithinActiveWindows,
  matchTriggerKind,
  mentionsBot,
} from '../../src/platform/participation.ts';
import {
  BOT_ID,
  BOT_IDENTITY,
  BOT_USERNAME,
  DAY_WINDOW,
  INSIDE_PERIOD,
  type LooseFields,
  groupMessage,
  mentionText,
  replyFields,
} from './fixtures.ts';

function ruleOf(options: {
  readonly windows?: readonly { start: string; end: string; days?: number[] }[];
  readonly keywords?: readonly string[];
  readonly seconds?: number;
  readonly timezone?: string;
}): ParticipationRule {
  const rule = compileParticipation({
    global: {
      ...(options.windows === undefined ? {} : { active_windows: [...options.windows] }),
      ...(options.keywords === undefined ? {} : { trigger_keywords: [...options.keywords] }),
      ...(options.seconds === undefined ? {} : { attention_window_seconds: options.seconds }),
    },
    chat: undefined,
    timezone: options.timezone ?? 'UTC',
  });
  if (rule === undefined) {
    throw new Error('Expected the participation rule to compile');
  }
  return rule;
}

describe('participation rules', () => {
  test('treats active windows as a half-open local-time interval', () => {
    const rule = ruleOf({ windows: [DAY_WINDOW] });
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T08:59:59.000Z'))).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T09:00:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T11:59:59.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T12:00:00.000Z'))).toBe(false);
  });

  test('assigns a window crossing midnight to its start day', () => {
    const rule = ruleOf({ windows: [{ start: '23:00', end: '01:00', days: [5] }] });
    // Friday 2026-08-14 23:30 and the following Saturday 00:30 both match.
    expect(isWithinActiveWindows(rule, new Date('2026-08-14T23:30:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T00:30:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(rule, new Date('2026-08-15T23:30:00.000Z'))).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-14T00:30:00.000Z'))).toBe(false);
  });

  test('restricts windows to the listed weekdays', () => {
    const rule = ruleOf({ windows: [{ start: '09:00', end: '12:00', days: [1, 2, 3, 4, 5] }] });
    expect(isWithinActiveWindows(rule, INSIDE_PERIOD)).toBe(false);
    expect(isWithinActiveWindows(rule, new Date('2026-08-17T10:00:00.000Z'))).toBe(true);
  });

  test('covers the whole day with 00:00-24:00 and never matches an empty list', () => {
    const allDay = ruleOf({ windows: [{ start: '00:00', end: '24:00' }] });
    expect(isWithinActiveWindows(allDay, new Date('2026-08-15T00:00:00.000Z'))).toBe(true);
    expect(isWithinActiveWindows(allDay, new Date('2026-08-15T23:59:59.000Z'))).toBe(true);
    const none = ruleOf({ windows: [] });
    expect(isWithinActiveWindows(none, INSIDE_PERIOD)).toBe(false);
  });

  test('resolves windows in the configured timezone', () => {
    const shanghai = ruleOf({ windows: [DAY_WINDOW], timezone: 'Asia/Shanghai' });
    // 01:30 UTC is 09:30 in Shanghai, so the same instant differs per timezone.
    const instant = new Date('2026-08-15T01:30:00.000Z');
    expect(isWithinActiveWindows(shanghai, instant)).toBe(true);
    expect(isWithinActiveWindows(ruleOf({ windows: [DAY_WINDOW] }), instant)).toBe(false);
  });

  test('mentionsBot compares the @username to this bot only, in text and in captions', () => {
    const message = (fields: LooseFields) => groupMessage(1, 10, fields).message as Message;
    const length = BOT_USERNAME.length + 1;
    expect(mentionsBot(message(mentionText()), BOT_IDENTITY)).toBe(true);
    expect(
      mentionsBot(
        message({ text: `@${BOT_USERNAME.toUpperCase()} hi`, entities: [{ type: 'mention', offset: 0, length }] }),
        BOT_IDENTITY,
      ),
    ).toBe(true);
    expect(
      mentionsBot(
        message({ text: '@Another hi', entities: [{ type: 'mention', offset: 0, length: 8 }] }),
        BOT_IDENTITY,
      ),
    ).toBe(false);
    // Offsets of caption entities index the caption, never the text.
    expect(
      mentionsBot(
        message({
          text: 'x'.repeat(40),
          caption: `@${BOT_USERNAME}`,
          caption_entities: [{ type: 'mention', offset: 0, length }],
        }),
        BOT_IDENTITY,
      ),
    ).toBe(true);
    // Without a username only a text mention of the bot id can match.
    expect(mentionsBot(message(mentionText()), { id: BigInt(BOT_ID), username: null })).toBe(false);
  });

  test('matches mentions, bot replies, and keywords in priority order', () => {
    const keywords = ['塑料碗'];
    const bot = BOT_IDENTITY;
    expect(matchTriggerKind(groupMessage(1, 10, mentionText()).message as Message, bot, keywords)).toBe('mention');
    expect(
      matchTriggerKind(
        groupMessage(2, 11, {
          text: 'hi',
          entities: [
            { type: 'text_mention', offset: 0, length: 2, user: { id: BOT_ID, is_bot: true, first_name: 'Wan' } },
          ],
        }).message as Message,
        bot,
        keywords,
      ),
    ).toBe('mention');
    expect(matchTriggerKind(groupMessage(3, 12, replyFields(BOT_ID, true)).message as Message, bot, keywords)).toBe(
      'reply_to_bot',
    );
    expect(matchTriggerKind(groupMessage(4, 13, { text: 'hey 塑料碗' }).message as Message, bot, keywords)).toBe(
      'keyword',
    );
    // A reply to a human is not a trigger, and neither is a keyword-free message.
    expect(matchTriggerKind(groupMessage(5, 14, replyFields(43, false)).message as Message, bot, keywords)).toBeNull();
    expect(
      matchTriggerKind(groupMessage(6, 15, { text: 'just chatting' }).message as Message, bot, keywords),
    ).toBeNull();
  });

  test('matches keywords against captions and ignores case', () => {
    const caption = groupMessage(1, 10, {
      caption: 'look at this WAN',
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10, file_size: 100 }],
    });
    expect(matchTriggerKind(caption.message as Message, BOT_IDENTITY, ['wan'])).toBe('keyword');
    expect(
      matchTriggerKind(groupMessage(2, 11, { text: 'hi @surowanbot' }).message as Message, BOT_IDENTITY, []),
    ).toBeNull();
  });

  test('reads mentions anywhere in a rich message', () => {
    const rich = (blocks: unknown[]) => groupMessage(1, 10, { rich_message: { blocks } }).message as Message;
    const inList = (text: unknown) => [
      { type: 'heading', size: 1, text: 'Notes' },
      { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: ['ask ', text] }] }] },
    ];
    expect(
      mentionsBot(
        rich(inList({ type: 'mention', text: `@${BOT_USERNAME.toUpperCase()}`, username: BOT_USERNAME })),
        BOT_IDENTITY,
      ),
    ).toBe(true);
    // Without a username field the visible "@name" is compared instead.
    expect(mentionsBot(rich(inList({ type: 'mention', text: `@${BOT_USERNAME}` })), BOT_IDENTITY)).toBe(true);
    const textMention = {
      type: 'table',
      cells: [
        [
          {
            text: { type: 'text_mention', text: 'Wan', user: { id: BOT_ID, is_bot: true, first_name: 'Wan' } },
            align: 'left',
            valign: 'top',
          },
        ],
      ],
    };
    expect(mentionsBot(rich([textMention]), BOT_IDENTITY)).toBe(true);
    expect(matchTriggerKind(rich([textMention]), BOT_IDENTITY, [])).toBe('mention');
    expect(mentionsBot(rich(inList({ type: 'mention', text: '@Another', username: 'Another' })), BOT_IDENTITY)).toBe(
      false,
    );
    expect(mentionsBot(rich(inList(`@${BOT_USERNAME}`)), BOT_IDENTITY)).toBe(false);
  });

  test('matches keywords against the visible text of a rich message only', () => {
    const rich = (blocks: unknown[]) => groupMessage(1, 10, { rich_message: { blocks } }).message as Message;
    const keyword = (blocks: unknown[], keywords: readonly string[]) =>
      matchTriggerKind(rich(blocks), BOT_IDENTITY, keywords);
    // Formatting runs join in place, so a keyword split across them still matches.
    expect(keyword([{ type: 'paragraph', text: ['问问', { type: 'bold', text: '塑料' }, '碗'] }], ['塑料碗'])).toBe(
      'keyword',
    );
    expect(
      keyword(
        [
          {
            type: 'photo',
            photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10 }],
            caption: { text: 'Lunch', credit: 'WAN' },
          },
        ],
        ['wan'],
      ),
    ).toBe('keyword');
    // Link targets, media placeholders, file names and separate blocks are not text a reader sees.
    expect(
      keyword(
        [
          { type: 'paragraph', text: { type: 'url', text: 'docs', url: 'https://example.com/wan' } },
          { type: 'photo', photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10 }] },
          { type: 'document', document: { file_id: 'd', file_unique_id: 'du', file_name: 'report.pdf' } },
          { type: 'paragraph', text: 'end' },
          { type: 'paragraph', text: 'start' },
        ],
        ['wan', 'photo', 'report', 'endstart'],
      ),
    ).toBeNull();
  });

  test('lower-cases and de-duplicates merged keywords', () => {
    const rule = compileParticipation({
      global: { trigger_keywords: ['Wan', 'wan'] },
      chat: { trigger_keywords: ['塑料碗'] },
      timezone: 'UTC',
    });
    expect(rule?.keywords).toEqual(['wan', '塑料碗']);
    expect(rule?.windowSeconds).toBe(300);
  });

  test('replaces windows per chat while appending keywords', () => {
    const merged = compileParticipation({
      global: { active_windows: [DAY_WINDOW], trigger_keywords: ['global'], attention_window_seconds: 120 },
      chat: { active_windows: [], trigger_keywords: ['local'] },
      timezone: 'UTC',
    });
    expect(merged?.windows).toEqual([]);
    expect(merged?.keywords).toEqual(['global', 'local']);
    expect(merged?.windowSeconds).toBe(120);
    expect(
      compileParticipation({ global: { attention_window_seconds: 60 }, chat: undefined, timezone: 'UTC' })
        ?.windowSeconds,
    ).toBe(60);
    expect(compileParticipation({ global: undefined, chat: undefined, timezone: 'UTC' })).toBeUndefined();
  });
});
