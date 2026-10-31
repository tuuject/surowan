import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentSettings, FileChat } from '../../../platform/config/index.ts';
import type { ConfigApplyResult, ConfigEdit, ConfigErrorCode } from '../../../platform/config/write.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import { readConfigRevision } from './file.ts';
import { type LoadedConfig, loadConfig } from './index.ts';
import { messageOf } from './reload-apply.ts';

/**
 * Chat-scoped edits to the configuration file.
 *
 * Every writer reads the file under the reloader's lock, locates the Chat by
 * ID (array order may differ from the active configuration), pins the revision
 * and applies the result through the same pipeline as any other write.
 */
export interface ChatWriteContext {
  readonly configPath: string;
  readonly store: RuntimeConfigurationStore;
  /** Options every read of the file shares; the provider set is part of validation. */
  loadOptions(): { readonly searchProviders?: readonly SearchProviderRule[] };
  writeAndApply(
    edits: readonly ConfigEdit[],
    expectedRevision: string | undefined,
    rejectedEvent?: string,
  ): Promise<ConfigApplyResult>;
  applyFile(): Promise<ConfigApplyResult>;
  /** A request refused before the file was written, logged under `event`. */
  reject(code: ConfigErrorCode, message: string, event?: string): ConfigApplyResult;
}

interface LocatedChat {
  readonly revision: string;
  readonly index: number;
  readonly chat: FileChat;
}

/** The file's Chat entry located by configured ID, or the refusal to report. */
async function readChat(ctx: ChatWriteContext, configuredChatId: number): Promise<LocatedChat | ConfigApplyResult> {
  let revision: string;
  let loaded: LoadedConfig;
  try {
    revision = await readConfigRevision(ctx.configPath);
    loaded = await loadConfig(ctx.configPath, ctx.loadOptions());
  } catch (error) {
    return ctx.reject('config_invalid', messageOf(error));
  }
  const chats = loaded.fileConfig.telegram?.chats ?? [];
  const index = chats.findIndex((chat) => chat.id === configuredChatId);
  const chat = chats[index];
  if (chat === undefined) {
    return ctx.reject('config_invalid', `Chat ${configuredChatId} is no longer present in the configuration file`);
  }
  return { revision, index, chat };
}

export async function addChatToFile(ctx: ChatWriteContext, configuredChatId: number): Promise<ConfigApplyResult> {
  if (!Number.isSafeInteger(configuredChatId) || configuredChatId === 0) {
    return ctx.reject('config_invalid', `Invalid Telegram chat ID: ${configuredChatId}`);
  }
  let revision: string;
  let loaded: LoadedConfig;
  try {
    revision = await readConfigRevision(ctx.configPath);
    loaded = await loadConfig(ctx.configPath, ctx.loadOptions());
  } catch (error) {
    return ctx.reject('config_invalid', messageOf(error));
  }
  const chats = loaded.fileConfig.telegram?.chats ?? [];
  if (chats.some((chat) => chat.id === configuredChatId)) {
    return await ctx.applyFile();
  }
  const edits: ConfigEdit[] = [{ path: ['telegram', 'chats', chats.length], value: { id: configuredChatId } }];
  return await ctx.writeAndApply(edits, revision);
}

/** Adds or removes the sender from one Chat's `ignored_user_ids`. */
export async function writeChatUserIgnored(
  ctx: ChatWriteContext,
  configuredChatId: number,
  userId: bigint,
  ignored: boolean,
): Promise<ConfigApplyResult> {
  if (userId <= 0n || userId > BigInt(Number.MAX_SAFE_INTEGER)) {
    return ctx.reject('config_invalid', `Invalid Telegram user ID: ${userId}`, 'config_write_failed');
  }
  if (!ctx.store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
    return ctx.reject(
      'config_invalid',
      `Chat ${configuredChatId} is not configured in the running process`,
      'config_write_failed',
    );
  }
  const located = await readChat(ctx, configuredChatId);
  if (!('chat' in located)) {
    return located;
  }
  const id = Number(userId);
  const ids = located.chat.ignored_user_ids ?? [];
  if (ids.includes(id) === ignored) {
    return await ctx.applyFile();
  }
  return await ctx.writeAndApply(
    [
      {
        path: ['telegram', 'chats', located.index, 'ignored_user_ids'],
        value: ignored ? [...ids, id] : ids.filter((entry) => entry !== id),
      },
    ],
    located.revision,
  );
}

/** Rewrites `provider`, `model` and `thinking_level` of one Chat; `null` removes all three. */
export async function writeChatSettings(
  ctx: ChatWriteContext,
  configuredChatId: number,
  settings: AgentSettings | null,
): Promise<ConfigApplyResult> {
  if (!ctx.store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
    return ctx.reject('config_invalid', `Chat ${configuredChatId} is not configured in the running process`);
  }
  const located = await readChat(ctx, configuredChatId);
  if (!('chat' in located)) {
    return located;
  }
  const edits: ConfigEdit[] = [];
  for (const key of ['provider', 'model', 'thinking_level'] as const) {
    const value = settings?.[key];
    if (located.chat[key] !== value) {
      edits.push({ path: ['telegram', 'chats', located.index, key], value });
    }
  }
  return edits.length === 0
    ? await ctx.applyFile()
    : await ctx.writeAndApply(edits, located.revision, 'model_switch_failed');
}

/**
 * Rewrites one Chat's `thinking_level`. `level` undefined removes the override,
 * which needs an explicit absent value: the edit must delete the key, not store
 * `null`, because `thinking_level` has no null form in the configuration schema.
 */
export async function writeChatThinkingLevel(
  ctx: ChatWriteContext,
  configuredChatId: number,
  level: ModelThinkingLevel | undefined,
): Promise<ConfigApplyResult> {
  if (!ctx.store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
    return ctx.reject('config_invalid', `Chat ${configuredChatId} is not configured in the running process`);
  }
  const located = await readChat(ctx, configuredChatId);
  if (!('chat' in located)) {
    return located;
  }
  // An equal value still applies the file, which publishes other pending hot
  // changes; an absent value has no key to delete and writes nothing.
  if (located.chat.thinking_level === level) {
    return await ctx.applyFile();
  }
  return await ctx.writeAndApply(
    [{ path: ['telegram', 'chats', located.index, 'thinking_level'], value: level }],
    located.revision,
  );
}
