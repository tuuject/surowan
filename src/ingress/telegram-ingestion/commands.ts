/**
 * The Telegram side of bot commands: everything that reads a `Message` —
 * tokenizing `/name[@bot]`, the conversation thread a command acts on, the
 * sender a permission check sees, and the command menu registered with the
 * host. The neutral `ParsedCommand`/`CommandSender` values it produces are all
 * `BotCommandService` ever sees.
 */

import type { Message } from 'grammy/types';
import { botCommandToken } from '../../platform/telegram-markdown/cues.ts';
import type { CommandSender, ParsedCommand } from '../../orchestration/bot-commands/index.ts';

/**
 * The Conversation a Telegram message belongs to, as a thread id.
 *
 * Telegram sets `message_thread_id` on more than forum topics: a private chat
 * with thread mode enabled carries one on its messages, and so does a reply
 * inside a plain supergroup. Ingestion files all of those under thread 0, so this
 * rule is the only one that agrees with `conversations`; reading the raw field
 * instead (as `parseBotCommand` once did) makes `/cut_topic` look for a
 * Conversation that was never written, clear no Context, and still reply that it
 * did — the exact failure the cut exists to prevent.
 */
export function conversationThreadId(message: Message | undefined): bigint {
  return message?.chat.type === 'supergroup' &&
    message.chat.is_forum === true &&
    message.is_topic_message === true &&
    message.message_thread_id !== undefined
    ? BigInt(message.message_thread_id)
    : 0n;
}

/**
 * The sender a permission check sees. An anonymous chat identity (`sender_chat`)
 * is nobody: `/pause` and friends must never be grantable from a channel post
 * or an anonymous group admin.
 */
export function commandSender(message: Message): CommandSender | null {
  return message.from === undefined || message.sender_chat !== undefined
    ? null
    : {
        id: BigInt(message.from.id),
        name: [message.from.first_name, message.from.last_name].filter((part) => part !== undefined).join(' '),
        username: message.from.username ?? null,
      };
}

const COMMAND_NAMES: Record<string, true> = {
  pause: true,
  resume: true,
  status: true,
  model: true,
  effort: true,
  cut_topic: true,
  rebuild_context: true,
  whoami: true,
  allowlist: true,
  ignoreme: true,
  unignoreme: true,
} satisfies Record<ParsedCommand['name'], true>;
// Commands whose trailing text is an argument. Every other command ignores it.
const ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(['model', 'effort']);

export interface BotCommandRegistration {
  readonly command: string;
  readonly description: string;
}

// Single source of truth for the Telegram command menu: everything registered
// via setMyCommands must be recognized as a control command or model-facing /ask.
export const BOT_COMMANDS: readonly BotCommandRegistration[] = [
  { command: 'ask', description: '显式唤起 Bot 回答这条消息' },
  { command: 'pause', description: '暂停本群互动（仅管理员）' },
  { command: 'resume', description: '恢复本群互动（仅管理员）' },
  { command: 'status', description: '查看当前模型、thinking effort 与本日 token 用量' },
  { command: 'model', description: '查看或切换 agent 模型（仅管理员）' },
  { command: 'effort', description: '查看或设置本群模型的思考强度（仅管理员）' },
  { command: 'cut_topic', description: '切掉此消息及更早的历史，仅对新会话生效（仅管理员）' },
  { command: 'rebuild_context', description: '丢弃并重建此话题的连续 Context，保留聊天记录（仅管理员）' },
  { command: 'whoami', description: '查看你的 Telegram 数字 ID' },
  { command: 'allowlist', description: '将本群加入白名单，立即生效（仅管理员）' },
  { command: 'ignoreme', description: '让 Bot 忽略你在本 Chat 的消息' },
  { command: 'unignoreme', description: '恢复 Bot 接收你在本 Chat 的消息' },
];

export interface CommandRegistrationApi {
  setMyCommands(commands: readonly BotCommandRegistration[]): Promise<unknown>;
}

export async function registerBotCommands(api: CommandRegistrationApi): Promise<void> {
  for (const entry of BOT_COMMANDS) {
    if (COMMAND_NAMES[entry.command] !== true && entry.command !== 'ask') {
      throw new Error(`Command not handled by parseBotCommand: ${entry.command}`);
    }
  }
  await api.setMyCommands(BOT_COMMANDS);
}

// Telegram command tokens are case-insensitive and may carry an explicit
// bot mention (`/pause@SurowanBot`); the mention must match this bot.
export function parseBotCommand(message: Message, botUsername: string | null): ParsedCommand | null {
  if (message.text === undefined || message.from?.is_bot === true) {
    return null;
  }
  const token = botCommandToken(message, botUsername);
  if (token === null) {
    return null;
  }
  const { name } = token;
  if (COMMAND_NAMES[name] !== true) {
    return null;
  }
  const commandName = name as ParsedCommand['name'];
  const base: ParsedCommand = (() => {
    if (!ARGUMENT_COMMANDS.has(name)) {
      return { name: commandName };
    }
    const argument = message.text.slice(token.length).trim();
    return argument.length === 0 ? { name: commandName } : { name: commandName, argument };
  })();
  const threadId = conversationThreadId(message);
  const scoped: ParsedCommand = {
    ...base,
    ...(message.message_id === undefined ? {} : { messageId: BigInt(message.message_id) }),
    ...(threadId === 0n ? {} : { threadId }),
  };
  return scoped;
}
