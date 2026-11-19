/**
 * IMH-05 raw-fragment reader dispatch: every `raw_fragment_json` reader in core
 * resolves the row's host through `rawFragmentReader(host)`, so this file pins
 * each host entry's `cues` and `body` on representative fragments — including
 * that a Telegram fragment and a room row never cross-interpret each other.
 */
import { describe, expect, test } from 'vitest';
import { HOST_KINDS } from '../../src/platform/im-host/identity.ts';
import { rawFragmentReader, RAW_FRAGMENT_READERS } from '../../src/platform/raw-fragments.ts';
import type { BotIdentity } from '../../src/platform/im-host/cues.ts';
import { bodyFromFragment } from '../../src/platform/telegram-markdown/index.ts';
import { BOT_ID, BOT_IDENTITY, BOT_USERNAME } from '../participation/fixtures.ts';

const FRAGMENT = (fields: Record<string, unknown>) => JSON.stringify({ message_id: 10, ...fields });

const EMPTY_CUES = { mentionsBot: false, repliesToBot: false, asksBot: false, texts: [] };

describe('raw fragment reader table', () => {
  test('has one entry per host kind', () => {
    expect(Object.keys(RAW_FRAGMENT_READERS).sort()).toEqual([...HOST_KINDS].sort());
    for (const host of HOST_KINDS) {
      expect(rawFragmentReader(host)).toBe(RAW_FRAGMENT_READERS[host]);
    }
  });

  describe('telegram cues', () => {
    const cues = (raw: string | null, bot: BotIdentity = BOT_IDENTITY) => rawFragmentReader('telegram').cues(raw, bot);

    test('extracts no cue from a plain text message', () => {
      expect(cues(FRAGMENT({ text: 'just talking' }))).toEqual({ ...EMPTY_CUES, texts: ['just talking'] });
    });

    test('detects a plain mention and a text_mention of the bot', () => {
      expect(
        cues(
          FRAGMENT({
            text: `@${BOT_USERNAME} ping`,
            entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
          }),
        ).mentionsBot,
      ).toBe(true);
      expect(
        cues(
          FRAGMENT({
            text: 'ping you',
            entities: [
              { type: 'text_mention', offset: 5, length: 3, user: { id: BOT_ID, is_bot: true, first_name: 'Wan' } },
            ],
          }),
        ).mentionsBot,
      ).toBe(true);
      expect(
        cues(FRAGMENT({ text: '@SomeoneElse hi', entities: [{ type: 'mention', offset: 0, length: 12 }] })).mentionsBot,
      ).toBe(false);
    });

    test('detects a reply to the bot but not to a human', () => {
      const replyTo = (id: number) =>
        FRAGMENT({ text: 'answering', reply_to_message: { from: { id, is_bot: id === BOT_ID } } });
      expect(cues(replyTo(BOT_ID)).repliesToBot).toBe(true);
      expect(cues(replyTo(42)).repliesToBot).toBe(false);
      expect(cues(FRAGMENT({ text: 'answering' })).repliesToBot).toBe(false);
    });

    test('detects an original /ask only on a fresh message to this bot', () => {
      const ask = (token = '/ask') => ({
        text: `${token} question`,
        entities: [{ type: 'bot_command', offset: 0, length: token.length }],
      });
      expect(cues(FRAGMENT(ask())).asksBot).toBe(true);
      expect(cues(FRAGMENT(ask('/ASK'))).asksBot).toBe(true);
      expect(cues(FRAGMENT(ask(`/ask@${BOT_USERNAME}`))).asksBot).toBe(true);
      expect(cues(FRAGMENT(ask('/ask@OtherBot'))).asksBot).toBe(false);
      // A command from another bot is not an ask; a sender_chat identity is.
      expect(cues(FRAGMENT({ ...ask(), from: { id: 88, is_bot: true } })).asksBot).toBe(false);
      expect(cues(FRAGMENT({ ...ask(), sender_chat: { id: -5 }, from: { id: 88, is_bot: true } })).asksBot).toBe(true);
      // Revision one can itself be an edit: an edited-in ask is not an original ask.
      expect(cues(FRAGMENT({ ...ask(), edit_date: 1_700_000_030 })).asksBot).toBe(false);
    });

    test('collects searchable text, caption and the visible rich text', () => {
      expect(
        cues(
          FRAGMENT({
            caption: 'look here',
            photo: [{ file_id: 'f' }],
            caption_entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
          }),
          { id: 0n, username: null },
        ).texts,
      ).toEqual(['look here']);
      const rich = cues(
        FRAGMENT({
          rich_message: { blocks: [{ type: 'paragraph', text: ['see ', { type: 'bold', text: 'this' }] }] },
        }),
      );
      expect(rich.texts).toEqual(['see this']);
    });

    test('reads mentions inside a rich message', () => {
      expect(
        cues(
          FRAGMENT({
            rich_message: {
              blocks: [{ type: 'paragraph', text: { type: 'mention', text: `@${BOT_USERNAME}` } }],
            },
          }),
        ).mentionsBot,
      ).toBe(true);
    });

    test('a bot send fragment and malformed or absent fragments carry no cues', () => {
      expect(cues(FRAGMENT({ message_id: 7, kind: 'text' }))).toEqual(EMPTY_CUES);
      expect(cues('not json')).toEqual(EMPTY_CUES);
      expect(cues(null)).toEqual(EMPTY_CUES);
      expect(cues('{}')).toEqual(EMPTY_CUES);
    });

    test('malformed numeric ids degrade to no cue instead of throwing', () => {
      // NaN/Infinity serialize as null; malformed ids that survive JSON are
      // fractional or too-large numbers, and BigInt throws on both.
      const bad = FRAGMENT({
        text: 'ping',
        entities: [
          { type: 'text_mention', offset: 0, length: 4, user: { id: 999.5, is_bot: true, first_name: 'Wan' } },
        ],
        reply_to_message: { from: { id: 1e300, is_bot: true } },
        rich_message: {
          blocks: [{ type: 'paragraph', text: { type: 'text_mention', user: { id: 42.5 } } }],
        },
      });
      expect(() => cues(bad)).not.toThrow();
      expect(cues(bad)).toEqual({ ...EMPTY_CUES, texts: ['ping', ''] });
    });

    test('the ask-only read inspects command fields only, revision one may not be an edit', () => {
      const asks = (raw: string | null) => rawFragmentReader('telegram').asks(raw, BOT_IDENTITY);
      const ask = {
        text: '/ask question',
        entities: [{ type: 'bot_command', offset: 0, length: 4 }],
      };
      expect(asks(FRAGMENT(ask))).toBe(true);
      expect(asks(FRAGMENT({ ...ask, edit_date: 1_700_000_030 }))).toBe(false);
      expect(asks(FRAGMENT({ ...ask, entities: [{ type: 'bot_command', offset: 0, length: 14 }] }))).toBe(false);
      // Fields the full cue read walks must not affect the ask-only read — a
      // malformed mention id would throw if it were inspected.
      expect(
        asks(
          FRAGMENT({
            ...ask,
            entities: [
              { type: 'bot_command', offset: 0, length: 4 },
              { type: 'text_mention', offset: 5, length: 3, user: { id: 999.5 } },
            ],
          }),
        ),
      ).toBe(true);
      expect(asks('not json')).toBe(false);
      expect(asks(null)).toBe(false);
    });
  });

  describe('playground cues', () => {
    test('a room row never yields cues', () => {
      expect(rawFragmentReader('playground').cues('{}', BOT_IDENTITY)).toEqual(EMPTY_CUES);
      expect(rawFragmentReader('playground').cues(FRAGMENT({ text: 'ping' }), BOT_IDENTITY)).toEqual(EMPTY_CUES);
    });
  });

  describe('body readers', () => {
    const stored = { text: 'stored body', caption: null, reply_snapshot: undefined, mediaCount: 0 };

    test('the telegram entry is the fragment renderer, byte for byte', () => {
      const fragment = FRAGMENT({
        text: 'wake up',
        entities: [{ type: 'bold', offset: 5, length: 2 }],
      });
      const viaTable = rawFragmentReader('telegram').body(fragment, { ...stored, text: 'wake up' });
      expect(viaTable).toEqual(bodyFromFragment(fragment, { ...stored, text: 'wake up' }));
      expect(viaTable.text).toBe('wake **up**');
    });

    test('a playground row yields exactly its stored body', () => {
      expect(rawFragmentReader('playground').body('{}', stored)).toEqual({
        text: 'stored body',
        caption: null,
      });
      expect(rawFragmentReader('playground').body(null, { ...stored, text: null, caption: 'cap' })).toEqual({
        text: null,
        caption: 'cap',
      });
    });
  });
});
