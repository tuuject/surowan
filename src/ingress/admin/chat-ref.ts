import { type ChatConfigEntry, type RawConfig, resolveChatConfig } from '../../platform/config/index.ts';
import type { Orm } from '../../store/store.ts';

/**
 * The Admin API's chat ids are Telegram chat ids: resolve one to its
 * configured chat entry, following group migrations.
 */
export function configuredTelegramChat(config: RawConfig, orm: Orm, hostChatId: bigint): ChatConfigEntry | undefined {
  return resolveChatConfig(config, orm, { hostKind: 'telegram', hostChatId });
}
