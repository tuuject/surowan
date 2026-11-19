/**
 * IMH-05 cue contract: `telegramMessageCues` is the only place a live Telegram
 * message is read for participation, and `matchTriggerKind` decides the trigger
 * purely from the neutral cues — the same shape stored-fragment cues produce
 * for proactive replies and catch-up.
 */
import { describe, expect, test } from 'vitest';
import type { Message } from 'grammy/types';
import { telegramMessageCues } from '../../src/ingress/telegram-ingestion/cues.ts';
import { matchTriggerKind } from '../../src/platform/participation.ts';
import { rawFragmentReader } from '../../src/platform/raw-fragments.ts';
import type { MessageCues } from '../../src/platform/im-host/cues.ts';
import { BOT_ID, BOT_IDENTITY, BOT_USERNAME, groupMessage, mentionText, replyFields } from './fixtures.ts';

const cues = (...args: Parameters<typeof groupMessage>) =>
  telegramMessageCues(groupMessage(...args).message as Message, BOT_IDENTITY);
const trigger = (c: MessageCues, keywords: readonly string[] = ['塑料碗'], includeAsk = true) =>
  matchTriggerKind(c, keywords, includeAsk);

describe('telegramMessageCues', () => {
  test('mentions, replies and keyword text each surface as a cue', () => {
    expect(cues(1, 10, mentionText())).toMatchObject({ mentionsBot: true });
    expect(cues(1, 10, replyFields(BOT_ID, true)).repliesToBot).toBe(true);
    expect(cues(1, 10, replyFields(43, false)).repliesToBot).toBe(false);
    expect(cues(1, 10, { text: 'hey 塑料碗' }).texts).toEqual(['hey 塑料碗']);
    expect(cues(1, 10, { caption: 'wan wan', photo: [{ file_id: 'x' }] }).texts).toEqual(['wan wan']);
  });

  test('an /ask addressed to this bot asks, edits and foreign or bot senders do not', () => {
    const ask = (token = '/ask') => ({
      text: `${token} question`,
      entities: [{ type: 'bot_command', offset: 0, length: token.length }],
    });
    expect(cues(1, 10, ask()).asksBot).toBe(true);
    expect(cues(1, 10, ask(`/ask@${BOT_USERNAME}`)).asksBot).toBe(true);
    expect(cues(1, 10, ask('/ask@OtherBot')).asksBot).toBe(false);
    expect(cues(1, 10, { ...ask(), from: { id: 88, is_bot: true, first_name: 'Bot' } }).asksBot).toBe(false);
  });

  test('a live message carrying edit_date still asks; the same stored fragment does not', () => {
    // Telegram never edits under `message`, but a payload that carries
    // `edit_date` there is still the live path: the base judged it by isAsk
    // alone. The edit_date rule belongs to stored revisions only.
    const fields = {
      text: '/ask question',
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
      edit_date: 1_700_000_010,
    };
    expect(cues(1, 10, fields).asksBot).toBe(true);
    const stored = rawFragmentReader('telegram').cues(JSON.stringify(fields), BOT_IDENTITY);
    expect(stored.asksBot).toBe(false);
  });

  test('the searchable texts carry text, caption and visible rich text together', () => {
    const rich = cues(1, 10, {
      rich_message: { blocks: [{ type: 'paragraph', text: ['one ', { type: 'bold', text: 'two' }] }] },
    });
    expect(rich.texts).toEqual(['one two']);
    expect(cues(1, 10, {}).texts).toEqual([]);
  });
});

describe('matchTriggerKind on cues', () => {
  const MENTION: MessageCues = { mentionsBot: true, repliesToBot: false, asksBot: false, texts: ['hi'] };
  const REPLY: MessageCues = { mentionsBot: false, repliesToBot: true, asksBot: false, texts: ['hi'] };
  const ASK: MessageCues = { mentionsBot: false, repliesToBot: false, asksBot: true, texts: ['/ask hi'] };
  const KEYWORD: MessageCues = { mentionsBot: false, repliesToBot: false, asksBot: false, texts: ['hey 塑料碗'] };
  const NONE: MessageCues = { mentionsBot: false, repliesToBot: false, asksBot: false, texts: ['quiet'] };

  test('each trigger cue maps to its kind and ask still wins over the rest', () => {
    expect(trigger(ASK)).toBe('ask');
    expect(trigger(MENTION)).toBe('mention');
    expect(trigger(REPLY)).toBe('reply_to_bot');
    expect(trigger(KEYWORD)).toBe('keyword');
    expect(trigger(NONE)).toBeNull();
    expect(trigger({ ...ASK, mentionsBot: true, repliesToBot: true })).toBe('ask');
  });

  test('excluding ask (proactive replies) keeps every other trigger', () => {
    expect(trigger(ASK, [], false)).toBeNull();
    expect(trigger(MENTION, [], false)).toBe('mention');
  });

  test('keywords match case-insensitively across every searchable text', () => {
    expect(trigger({ ...NONE, texts: ['no', 'hey 塑料碗 here'] })).toBe('keyword');
    expect(trigger({ ...NONE, texts: ['HEY WAN'] }, ['wan'])).toBe('keyword');
    expect(trigger(NONE, [])).toBeNull();
  });
});
