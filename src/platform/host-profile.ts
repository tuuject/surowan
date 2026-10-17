import type { HostKind } from './im-host.ts';

/**
 * The fixed execution profile of a host.
 *
 * A host is not a chat "mode": it is an identity, and it decides once which
 * real capabilities an invocation may reach. Telegram keeps the full palette;
 * the Playground is deliberately narrow, and anything not named here is denied
 * instead of inherited from the Telegram configuration.
 */
export interface HostExecutionProfile {
  readonly kind: HostKind;
  /** Media rows of this host may be read as image input. */
  readonly mediaRead: boolean;
  /** Sticker index and sticker search capabilities. */
  readonly stickers: boolean;
  /** Host-level MCP servers (web search included). */
  readonly mcp: boolean;
  /** `zzz` and the global sleep window. */
  readonly sleep: boolean;
  /** `daily_usage.scope` this host accumulates into. */
  readonly budgetScope: 'chat' | 'playground';
  /** Task completions may carry `bypassDailyBudget`. */
  readonly budgetBypass: boolean;
  /** Skills that never appear for this host. */
  readonly hiddenSkills: readonly string[];
}

export const TELEGRAM_PROFILE: HostExecutionProfile = {
  kind: 'telegram',
  mediaRead: true,
  stickers: true,
  mcp: true,
  sleep: true,
  budgetScope: 'chat',
  budgetBypass: true,
  hiddenSkills: [],
};

export const PLAYGROUND_PROFILE: HostExecutionProfile = {
  kind: 'playground',
  mediaRead: true,
  stickers: false,
  mcp: false,
  sleep: false,
  budgetScope: 'playground',
  budgetBypass: false,
  hiddenSkills: ['alarms', 'dictionary', 'image-generation', 'sticker-search'],
};

export function hostExecutionProfile(kind: HostKind): HostExecutionProfile {
  return kind === 'playground' ? PLAYGROUND_PROFILE : TELEGRAM_PROFILE;
}
