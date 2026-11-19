import { and, eq } from 'drizzle-orm';
import { ConversationContextStore } from '../../context/store/index.ts';
import { hostIntakeSettings, resolveChatConfig } from '../../platform/config/index.ts';
import type { ChatConfigEntry, ChatConfigRef } from '../../platform/config/index.ts';
import type { BotCommandConfigWriter } from '../../platform/config/write.ts';
import type { AgentModelSwitcher } from '../../platform/models/switch.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { ParticipationRegistry } from '../../store/participation.ts';
import { chats } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { ConversationRuntime } from '../conversation-runtime.ts';
import type { BucketScheduler } from '../scheduler/index.ts';
import {
  allowlistChat,
  type BotCommandConfigDeps,
  setSelfIgnored,
  switchChatEffort,
  switchChatModel,
} from './config.ts';
import { type BotCommandSessionDeps, cutTopic, pauseChat, rebuildContext, resumeChat } from './session.ts';
import { type BotCommandStatusDeps, chatStatus } from './status.ts';

export interface ParsedCommand {
  readonly name:
    | 'pause'
    | 'resume'
    | 'status'
    | 'model'
    | 'effort'
    | 'cut_topic'
    | 'rebuild_context'
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
 * The sender a permission check sees, as a host-neutral identity. The
 * ingestion edge extracts it from a transport message (anonymous chat
 * identities become `null` there, so they can never gain permission).
 */
export interface CommandSender {
  readonly id: bigint;
  readonly name: string;
  readonly username: string | null;
}

const DENIED_REPLY = '该命令仅对本 Bot 的管理员可用。';

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
    chat: ChatConfigRef,
    sender: CommandSender | null,
    now = new Date(),
  ): Promise<string> {
    switch (command.name) {
      case 'pause':
        return this.#adminGate(sender, chat.hostKind) ? this.#pause(chat, now) : DENIED_REPLY;
      case 'resume':
        return this.#adminGate(sender, chat.hostKind) ? this.#resume(chat) : DENIED_REPLY;
      case 'status':
        return this.#status(chat, now);
      case 'model':
        return this.#adminGate(sender, chat.hostKind) ? await this.#modelSwitch(command.argument, chat) : DENIED_REPLY;
      case 'effort':
        return this.#adminGate(sender, chat.hostKind) ? await this.#effortSwitch(command.argument, chat) : DENIED_REPLY;
      case 'cut_topic':
        return this.#adminGate(sender, chat.hostKind)
          ? this.#cutTopic(chat, command.messageId, command.threadId, now)
          : DENIED_REPLY;
      case 'rebuild_context':
        return this.#adminGate(sender, chat.hostKind)
          ? rebuildContext(this.#sessionDeps(), chat, command.threadId, now)
          : DENIED_REPLY;
      case 'whoami':
        return sender === null ? '无法识别发送者。' : sender.id.toString();
      case 'allowlist':
        return this.#adminGate(sender, chat.hostKind) ? await this.#allowlist(chat) : DENIED_REPLY;
      case 'ignoreme':
      case 'unignoreme':
        return await this.#setSelfIgnored(chat, sender, command.name === 'ignoreme');
    }
  }

  #adminGate(sender: CommandSender | null, hostKind: ChatConfigRef['hostKind']): boolean {
    if (sender === null) {
      return false;
    }
    // The whitelist is the host's `admins` intake setting, read from the live
    // configuration so a hot-applied list change takes effect on the next command.
    const admins = hostIntakeSettings(this.#configStore.current().config, hostKind).admins;
    return admins.some((id) => BigInt(id) === sender.id);
  }

  #pause(chat: ChatConfigRef, now: Date): string {
    return pauseChat(this.#sessionDeps(), chat, now);
  }

  #resume(chat: ChatConfigRef): string {
    return resumeChat(this.#sessionDeps(), chat);
  }

  #cutTopic(chat: ChatConfigRef, messageId: bigint | undefined, threadId: bigint | undefined, now: Date): string {
    return cutTopic(this.#sessionDeps(), chat, messageId, threadId, now);
  }

  async #allowlist(chat: ChatConfigRef): Promise<string> {
    return await allowlistChat(this.#configDeps(), chat);
  }

  async #setSelfIgnored(chat: ChatConfigRef, sender: CommandSender | null, ignored: boolean): Promise<string> {
    return await setSelfIgnored(this.#configDeps(), chat, sender, ignored);
  }

  async #modelSwitch(argument: string | undefined, chat: ChatConfigRef): Promise<string> {
    return await switchChatModel(this.#configDeps(), argument, chat);
  }

  async #effortSwitch(argument: string | undefined, chat: ChatConfigRef): Promise<string> {
    return await switchChatEffort(this.#configDeps(), argument, chat);
  }

  #status(chat: ChatConfigRef, now: Date): string {
    return chatStatus(this.#statusDeps(), chat, now);
  }

  #internalChatId(chat: ChatConfigRef): bigint | null {
    return (
      this.#store.orm
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.hostKind, chat.hostKind), eq(chats.hostChatId, chat.hostChatId ?? 0n)))
        .get()?.id ?? null
    );
  }

  #chatConfig(chat: ChatConfigRef): ChatConfigEntry | undefined {
    return resolveChatConfig(this.#configStore.current().config, this.#store.orm, chat);
  }

  #sessionDeps(): BotCommandSessionDeps {
    return {
      store: this.#store,
      scheduler: this.#scheduler,
      contexts: this.#contexts,
      conversationRuntime: this.#conversationRuntime,
      internalChatId: (chat) => this.#internalChatId(chat),
    };
  }

  #configDeps(): BotCommandConfigDeps {
    return {
      store: this.#store,
      configStore: this.#configStore,
      modelSwitcher: this.#modelSwitcher,
      configReloader: this.#configReloader,
      scheduler: this.#scheduler,
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
