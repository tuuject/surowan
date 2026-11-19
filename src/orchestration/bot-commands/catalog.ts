/**
 * The one list of bot commands. The Telegram menu, `/help` and
 * `BotCommandService`'s permission gate all read this catalog, so a command
 * cannot be advertised without also being allowed, or allowed without being
 * advertised.
 */

export type BotCommandName =
  | 'ask'
  | 'help'
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

/** Commands `BotCommandService` runs; `/ask` is model-facing and handled by intake. */
export type ControlCommandName = Exclude<BotCommandName, 'ask'>;

/**
 * `anyone` needs a reachable chat, `member` also needs an identifiable personal
 * account, and `admin` needs the host's `admins` list.
 */
export type BotCommandTier = 'anyone' | 'member' | 'admin';

export interface BotCommandCatalogEntry {
  readonly name: BotCommandName;
  /** The menu/help text without the admin marker; see `ADMIN_DESCRIPTION_SUFFIX`. */
  readonly description: string;
  readonly tier: BotCommandTier;
  /**
   * Whether a member listed in the chat's `ignored_user_ids` can still use it.
   * Ingestion drops every other command before the bot sees it, so `/help`
   * must not advertise them to that member.
   */
  readonly ignoredPassthrough: boolean;
}

export const ADMIN_DESCRIPTION_SUFFIX = '（仅管理员）';

// Menu order doubles as `/help` order. Keep entries stable: the Telegram menu
// and `/help` both render this list in order.
export const BOT_COMMAND_CATALOG: readonly BotCommandCatalogEntry[] = [
  { name: 'ask', description: '显式唤起 Bot 回答这条消息', tier: 'anyone', ignoredPassthrough: true },
  { name: 'help', description: '查看你可以使用的命令', tier: 'anyone', ignoredPassthrough: true },
  { name: 'pause', description: '暂停本群互动', tier: 'admin', ignoredPassthrough: false },
  { name: 'resume', description: '恢复本群互动', tier: 'admin', ignoredPassthrough: false },
  {
    name: 'status',
    description: '查看当前模型、thinking effort 与本日 token 用量',
    tier: 'anyone',
    ignoredPassthrough: false,
  },
  { name: 'model', description: '查看或切换 agent 模型', tier: 'admin', ignoredPassthrough: false },
  { name: 'effort', description: '查看或设置本群模型的思考强度', tier: 'admin', ignoredPassthrough: false },
  {
    name: 'cut_topic',
    description: '切掉此消息及更早的历史，仅对新会话生效',
    tier: 'admin',
    ignoredPassthrough: false,
  },
  {
    name: 'rebuild_context',
    description: '丢弃并重建此话题的连续 Context，保留聊天记录',
    tier: 'admin',
    ignoredPassthrough: false,
  },
  { name: 'whoami', description: '查看你的 Telegram 数字 ID', tier: 'member', ignoredPassthrough: false },
  { name: 'allowlist', description: '将本群加入白名单，立即生效', tier: 'admin', ignoredPassthrough: false },
  { name: 'ignoreme', description: '让 Bot 忽略你在本 Chat 的消息', tier: 'member', ignoredPassthrough: true },
  { name: 'unignoreme', description: '恢复 Bot 接收你在本 Chat 的消息', tier: 'member', ignoredPassthrough: true },
];

const CONTROL_NAMES: ReadonlySet<string> = new Set(
  BOT_COMMAND_CATALOG.filter((entry) => entry.name !== 'ask').map((entry) => entry.name),
);

export function isControlCommandName(name: string): name is ControlCommandName {
  return CONTROL_NAMES.has(name);
}

export function botCommandEntry(name: BotCommandName): BotCommandCatalogEntry {
  const entry = BOT_COMMAND_CATALOG.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Unknown bot command: ${name}`);
  }
  return entry;
}
