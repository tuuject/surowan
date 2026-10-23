import { eq } from 'drizzle-orm';
import type { Message } from 'grammy/types';
import { ConversationContextStore } from '../context/context-store.ts';
import type { RawConfig } from '../platform/config.ts';
import type { BotCommandConfigWriter } from '../platform/config-write.ts';
import type { AgentModelSwitcher } from '../platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { ParticipationRegistry } from '../store/participation.ts';
import { chats } from '../store/schema.ts';
import { type BusinessStore, resolveChatConfig } from '../store/store.ts';
import { allowlistChat, type BotCommandConfigDeps, setSelfIgnored, switchChatModel } from './bot-commands-config.ts';
import { type BotCommandSessionDeps, cutTopic, pauseChat, resumeChat } from './bot-commands-session.ts';
import { type BotCommandStatusDeps, chatStatus } from './bot-commands-status.ts';
import type { ConversationRuntime } from './conversation-runtime.ts';
import type { BucketScheduler } from './scheduler.ts';

export interface ParsedCommand {
  readonly name:
    | 'pause'
    | 'resume'
    | 'status'
    | 'model'
    | 'cut_topic'
    | 'whoami'
    | 'allowlist'
    | 'ignoreme'
    | 'unignoreme';
  readonly argument?: string;
  /** Telegram message ID of the command message itself; used by cut_topic. */
  readonly messageId?: bigint;
  /**
   * Forum topic the command was sent in; the Conversation Context to cut. Absent
   * for every chat that has one Conversation, which is the `message_thread_id = 0`
   * case — see `conversationThreadId`.
   */
  readonly threadId?: bigint;
}

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

export interface CommandSender {
  readonly id: bigint;
  readonly name: string;
  readonly username: string | null;
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
  cut_topic: true,
  whoami: true,
  allowlist: true,
  ignoreme: true,
  unignoreme: true,
} satisfies Record<ParsedCommand['name'], true>;
const DENIED_REPLY = '该命令仅对本 Bot 的管理员可用。';

export interface BotCommandRegistration {
  readonly command: string;
  readonly description: string;
}

// Single source of truth for the Telegram command menu: everything registered
// via setMyCommands must also parse in parseBotCommand.
export const BOT_COMMANDS: readonly BotCommandRegistration[] = [
  { command: 'pause', description: '暂停本群互动（仅管理员）' },
  { command: 'resume', description: '恢复本群互动（仅管理员）' },
  { command: 'status', description: '查看当前模型、thinking effort 与本日 token 用量' },
  { command: 'model', description: '查看或切换 agent 模型（仅管理员）' },
  { command: 'cut_topic', description: '切掉此消息及更早的历史，仅对新会话生效（仅管理员）' },
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
    if (COMMAND_NAMES[entry.command] !== true) {
      throw new Error(`Command not handled by parseBotCommand: ${entry.command}`);
    }
  }
  await api.setMyCommands(BOT_COMMANDS);
}

// Telegram command tokens are case-insensitive and may carry an explicit
// bot mention (`/pause@PlasticWanBot`); the mention must match this bot.
export function parseBotCommand(message: Message, botUsername: string | null): ParsedCommand | null {
  if (message.text === undefined || message.from?.is_bot === true) {
    return null;
  }
  const entity = message.entities?.find((entry) => entry.type === 'bot_command' && entry.offset === 0);
  if (entity === undefined) {
    return null;
  }
  const token = message.text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) {
    return null;
  }
  if (COMMAND_NAMES[name] !== true) {
    return null;
  }
  const base: ParsedCommand =
    name !== 'model'
      ? { name: name as ParsedCommand['name'] }
      : (() => {
          const argument = message.text.slice(entity.offset + entity.length).trim();
          return argument.length === 0 ? { name: 'model' } : { name: 'model', argument };
        })();
  const threadId = conversationThreadId(message);
  const scoped: ParsedCommand = {
    ...base,
    ...(message.message_id === undefined ? {} : { messageId: BigInt(message.message_id) }),
    ...(threadId === 0n ? {} : { threadId }),
  };
  return scoped;
}

// Chat-scoped control commands. State changes and replies are deterministic
// bot responses, not model output, so they bypass the agent send tool.
export class BotCommandService {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #scheduler: BucketScheduler;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;
  readonly #configReloader: BotCommandConfigWriter | undefined;
  readonly #participation: ParticipationRegistry;
  readonly #contexts: ConversationContextStore;
  readonly #conversationRuntime: ConversationRuntime | undefined;

  constructor(
    store: BusinessStore,
    configStore: RuntimeConfigurationStore,
    scheduler: BucketScheduler,
    modelSwitcher?: AgentModelSwitcher,
    conversationRuntime?: ConversationRuntime,
    configReloader?: BotCommandConfigWriter,
  ) {
    this.#store = store;
    this.#configStore = configStore;
    this.#scheduler = scheduler;
    this.#modelSwitcher = modelSwitcher;
    this.#configReloader = configReloader;
    this.#participation = new ParticipationRegistry(configStore);
    this.#contexts = new ConversationContextStore(store);
    this.#conversationRuntime = conversationRuntime;
  }

  async run(
    command: ParsedCommand,
    telegramChatId: bigint,
    sender: CommandSender | null,
    now = new Date(),
  ): Promise<string> {
    switch (command.name) {
      case 'pause':
        return this.#adminGate(sender) ? this.#pause(telegramChatId, now) : DENIED_REPLY;
      case 'resume':
        return this.#adminGate(sender) ? this.#resume(telegramChatId) : DENIED_REPLY;
      case 'status':
        return this.#status(telegramChatId, now);
      case 'model':
        return this.#adminGate(sender) ? await this.#modelSwitch(command.argument, telegramChatId) : DENIED_REPLY;
      case 'cut_topic':
        return this.#adminGate(sender)
          ? this.#cutTopic(telegramChatId, command.messageId, command.threadId, now)
          : DENIED_REPLY;
      case 'whoami':
        return sender === null ? '无法识别发送者。' : sender.id.toString();
      case 'allowlist':
        return this.#adminGate(sender) ? await this.#allowlist(telegramChatId) : DENIED_REPLY;
      case 'ignoreme':
      case 'unignoreme':
        return await this.#setSelfIgnored(telegramChatId, sender, command.name === 'ignoreme');
    }
  }

  #adminGate(sender: CommandSender | null): boolean {
    if (sender === null) {
      return false;
    }
    // The whitelist is `telegram.admins`, read from the live configuration so a
    // hot-applied list change takes effect on the next command.
    const admins = this.#configStore.current().config.telegram.admins ?? [];
    return admins.some((id) => BigInt(id) === sender.id);
  }

  #pause(telegramChatId: bigint, now: Date): string {
    return pauseChat(this.#sessionDeps(), telegramChatId, now);
  }

  #resume(telegramChatId: bigint): string {
    return resumeChat(this.#sessionDeps(), telegramChatId);
  }

  #cutTopic(telegramChatId: bigint, messageId: bigint | undefined, threadId: bigint | undefined, now: Date): string {
    return cutTopic(this.#sessionDeps(), telegramChatId, messageId, threadId, now);
  }

  async #allowlist(telegramChatId: bigint): Promise<string> {
    return await allowlistChat(this.#configDeps(), telegramChatId);
  }

  async #setSelfIgnored(telegramChatId: bigint, sender: CommandSender | null, ignored: boolean): Promise<string> {
    return await setSelfIgnored(this.#configDeps(), telegramChatId, sender, ignored);
  }

  async #modelSwitch(argument: string | undefined, telegramChatId: bigint): Promise<string> {
    return await switchChatModel(this.#configDeps(), argument, telegramChatId);
  }

  #status(telegramChatId: bigint, now: Date): string {
    return chatStatus(this.#statusDeps(), telegramChatId, now);
  }

  #internalChatId(telegramChatId: bigint): bigint | null {
    return (
      this.#store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, telegramChatId)).get()?.id ??
      null
    );
  }

  #chatConfig(telegramChatId: bigint): RawConfig['telegram']['chats'][number] | undefined {
    return resolveChatConfig(this.#configStore.current().config, this.#store.orm, telegramChatId);
  }

  #sessionDeps(): BotCommandSessionDeps {
    return {
      store: this.#store,
      scheduler: this.#scheduler,
      contexts: this.#contexts,
      conversationRuntime: this.#conversationRuntime,
      internalChatId: (telegramChatId) => this.#internalChatId(telegramChatId),
    };
  }

  #configDeps(): BotCommandConfigDeps {
    return {
      store: this.#store,
      configStore: this.#configStore,
      modelSwitcher: this.#modelSwitcher,
      configReloader: this.#configReloader,
    };
  }

  #statusDeps(): BotCommandStatusDeps {
    return {
      store: this.#store,
      configStore: this.#configStore,
      contexts: this.#contexts,
      participation: this.#participation,
      internalChatId: (telegramChatId) => this.#internalChatId(telegramChatId),
      chatConfig: (telegramChatId) => this.#chatConfig(telegramChatId),
    };
  }
}
