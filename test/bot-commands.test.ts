import { describe, expect, test } from 'vitest';
import type { Message, Update } from 'grammy/types';
import {
  BOT_COMMANDS,
  type BotCommandRegistration,
  parseBotCommand,
  registerBotCommands,
} from '../src/orchestration/bot-commands.ts';
import { BOT_USERNAME, commandUpdate, message } from './bot-commands-fixtures.ts';

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

  test('recognizes whoami and ignores trailing text', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/whoami').message), BOT_USERNAME)).toEqual({
      name: 'whoami',
      messageId: 1n,
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/WHOAMI please').message), BOT_USERNAME)).toEqual({
      name: 'whoami',
      messageId: 1n,
    });
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
});

describe('registerBotCommands', () => {
  test('registers every command also handled by parseBotCommand', async () => {
    let captured: readonly BotCommandRegistration[] | undefined;
    const api = {
      setMyCommands: async (commands: readonly BotCommandRegistration[]) => {
        captured = commands;
      },
    };
    await registerBotCommands(api);
    expect(captured?.map((entry) => entry.command)).toEqual(BOT_COMMANDS.map((entry) => entry.command));
    for (const entry of BOT_COMMANDS) {
      expect(entry.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
    const message = (text: string): Message => ({
      message_id: 1,
      date: 1_700_000_001,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    });
    for (const entry of BOT_COMMANDS) {
      const parsed = parseBotCommand(message(`/${entry.command}`), BOT_USERNAME);
      expect(parsed).not.toBeNull();
      expect(parsed?.name as string).toBe(entry.command);
    }
  });
});
