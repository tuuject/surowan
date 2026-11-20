import { BOT_COMMAND_CATALOG, type BotCommandCatalogEntry, type BotCommandTier } from './catalog.ts';

export const IGNORED_HELP_HINT = '你已让 Bot 忽略你在本 Chat 的消息，发送 /unignoreme 可恢复。';

export interface HelpAccess {
  /** Whether the sender is in the host's live `admins` list. */
  readonly isAdmin: boolean;
  /** Whether the sender's ID is in this chat's live `ignored_user_ids`. */
  readonly isIgnored: boolean;
  /** Whether ingestion can identify the command's sender as a personal account. */
  readonly identified: boolean;
}

/**
 * `/help` text: only commands this sender can actually use in this chat, in
 * menu order. An ignored member's other commands are dropped at ingestion, so
 * listing them would send them into a void; only the passthrough commands stay.
 */
export function renderHelp(access: HelpAccess): string {
  const available = visibleCommands(BOT_COMMAND_CATALOG, access);
  const memberCommands = available.filter((entry) => entry.tier !== 'admin');
  const adminCommands = available.filter((entry) => entry.tier === 'admin');
  const lines = memberCommands.map(commandLine);
  if (adminCommands.length > 0) {
    lines.push('', '管理员命令：', ...adminCommands.map(commandLine));
  }
  if (access.isIgnored) {
    lines.push('', IGNORED_HELP_HINT);
  }
  return lines.join('\n');
}

/**
 * The catalog entries `/help` may show. Exported with an injected catalog so the
 * tier gate is testable independently of the current entries.
 */
export function visibleCommands(
  catalog: readonly BotCommandCatalogEntry[],
  access: HelpAccess,
): readonly BotCommandCatalogEntry[] {
  return catalog.filter(
    (entry) =>
      tierAllows(entry.tier, access.isAdmin, access.identified) && (!access.isIgnored || entry.ignoredPassthrough),
  );
}

function commandLine(entry: BotCommandCatalogEntry): string {
  return `/${entry.name} — ${entry.description}`;
}

function tierAllows(tier: BotCommandTier, isAdmin: boolean, identified: boolean): boolean {
  switch (tier) {
    case 'anyone':
      return true;
    case 'member':
      return identified;
    case 'admin':
      return isAdmin;
  }
}
