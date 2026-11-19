import type { Message, Update } from 'grammy/types';
import { describe, expect, test } from 'vitest';
import { conversationThreadId, parseBotCommand } from '../../src/ingress/telegram-ingestion/commands.ts';
import { BOT_USERNAME, commandUpdate, message } from './fixtures.ts';

describe('parseBotCommand', () => {
  test('recognizes pause, resume and status case-insensitively', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause').message), BOT_USERNAME)).toEqual({
      name: 'pause',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/Resume').message), BOT_USERNAME)).toEqual({
      name: 'resume',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/STATUS').message), BOT_USERNAME)).toEqual({
      name: 'status',
      messageId: 1n,
    });
  });

  test('accepts an explicit matching bot mention and rejects others', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause@surowan_test_bot').message), BOT_USERNAME)).toEqual({
      name: 'pause',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause@other_bot').message), BOT_USERNAME)).toBeNull();
  });

  test('recognizes self-ignore commands, matching mentions and ignores supplied user IDs', () => {
    expect(
      parseBotCommand(message(commandUpdate(1, 1, '/IgnoreMe@surowan_test_bot 99').message), BOT_USERNAME),
    ).toEqual({
      name: 'ignoreme',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/UNIGNOREME').message), BOT_USERNAME)).toEqual({
      name: 'unignoreme',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/unignoreme@other_bot').message), BOT_USERNAME)).toBeNull();
  });

  test('captures the optional /model argument', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model').message), BOT_USERNAME)).toEqual({
      name: 'model',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model 2').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: '2',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model page 2').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: 'page 2',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/Model reset').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: 'reset',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model@surowan_test_bot 2').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: '2',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause whatever').message), BOT_USERNAME)).toEqual({
      name: 'pause',
      messageId: 1n,
    });
  });

  test('captures the optional /effort argument', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/effort').message), BOT_USERNAME)).toEqual({
      name: 'effort',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/effort high').message), BOT_USERNAME)).toEqual({
      name: 'effort',
      argument: 'high',
      messageId: 1n,
    });
    expect(
      parseBotCommand(message(commandUpdate(1, 1, '/EFFORT@surowan_test_bot default').message), BOT_USERNAME),
    ).toEqual({
      name: 'effort',
      argument: 'default',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/effort@other_bot max').message), BOT_USERNAME)).toBeNull();
  });

  test('ignores non-commands, unknown commands and trailing text', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pausefoo').message), BOT_USERNAME)).toBeNull();
    expect(parseBotCommand(message(commandUpdate(1, 1, '/unknown').message), BOT_USERNAME)).toBeNull();
    const inline: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello /pause',
        entities: [{ offset: 6, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(inline.message), BOT_USERNAME)).toBeNull();
    const trailing: Update = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1_700_000_002,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: '/pause please',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(trailing.message), BOT_USERNAME)).toEqual({ name: 'pause', messageId: 2n });
  });

  test('ignores commands from bots and messages without text', async () => {
    const fromBot: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 77, is_bot: true, first_name: 'OtherBot' },
        text: '/pause',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(fromBot.message), BOT_USERNAME)).toBeNull();
    const noText: Message = {
      message_id: 1,
      date: 1_700_000_001,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
    };
    expect(parseBotCommand(noText, BOT_USERNAME)).toBeNull();
  });

  test('a forum-topic command lands on the same thread ingestion files the topic under', () => {
    const forumMessage = (text: string): Message => ({
      message_id: 5,
      message_thread_id: 100,
      is_topic_message: true,
      date: 1_700_000_001,
      chat: { id: -1001, type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    });
    const message = forumMessage('/cut_topic');
    expect(parseBotCommand(message, BOT_USERNAME)).toEqual({
      name: 'cut_topic',
      messageId: 5n,
      threadId: 100n,
    });
    expect(conversationThreadId(message)).toBe(100n);
    // Private-message threads and ordinary supergroup reply threads stay on 0.
    const privateThread: Message = {
      message_id: 1,
      message_thread_id: 42,
      date: 1_700_000_001,
      chat: { id: 7, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/pause',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    };
    expect(conversationThreadId(privateThread)).toBe(0n);
    expect(parseBotCommand(privateThread, BOT_USERNAME)).toEqual({ name: 'pause', messageId: 1n });
    const plain = forumMessage('plain');
    const { is_forum: _forum, ...plainChat } = plain.chat;
    expect(conversationThreadId({ ...plain, chat: plainChat })).toBe(0n);
  });
});
