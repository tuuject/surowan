import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentSettings, RawConfig } from '../../platform/config/index.ts';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config/resolve.ts';
import type { BotCommandConfigWriter } from '../../platform/config/write.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../../platform/models/switch.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { isThinkingLevel } from '../../platform/thinking-levels.ts';
import { type BusinessStore, resolveChatConfig } from '../../store/store.ts';
import type { CommandSender } from './index.ts';

export interface BotCommandConfigDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly modelSwitcher: AgentModelSwitcher | undefined;
  readonly configReloader: BotCommandConfigWriter | undefined;
}

const MODEL_PAGE_SIZE = 20;

/** What chat-scoped `/model` itself writes; any other applied path came from the file. */
function switchPaths(configuredChatId: number): ReadonlySet<string> {
  return new Set([
    `telegram.chats[${configuredChatId}].provider`,
    `telegram.chats[${configuredChatId}].model`,
    `telegram.chats[${configuredChatId}].thinking_level`,
  ]);
}

// The one command that may run in a chat the allowlist does not yet name:
// ingestion passes it through for admins precisely so it can extend the
// allowlist itself. The entry is appended to `telegram.chats` as `{ id }` and
// hot-applied, so the chat joins the normal ingestion path without a restart.
export async function allowlistChat(deps: BotCommandConfigDeps, telegramChatId: bigint): Promise<string> {
  if (resolveChatConfig(deps.configStore.current().config, deps.store.orm, telegramChatId) !== undefined) {
    return '本群已在白名单中。';
  }
  const reloader = deps.configReloader;
  if (reloader === undefined) {
    return '运行时配置应用不可用。';
  }
  const chatId = Number(telegramChatId);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    return `无效的 Chat ID: ${telegramChatId.toString()}`;
  }
  const result = await reloader.addChat(chatId);
  if (!result.ok) {
    return result.fileWritten
      ? `已写入 config.jsonc，但应用失败: ${result.message}`
      : `加入白名单失败: ${result.message}`;
  }
  const lines = ['已将本群加入白名单，配置已立即生效。'];
  if (result.restartRequired.length > 0) {
    lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
  }
  return lines.join('\n');
}

export async function setSelfIgnored(
  deps: BotCommandConfigDeps,
  telegramChatId: bigint,
  sender: CommandSender | null,
  ignored: boolean,
): Promise<string> {
  if (sender === null) {
    return '无法识别发送者，请使用个人账号发送命令。';
  }
  const reloader = deps.configReloader;
  if (reloader === undefined) {
    return '运行时配置应用不可用。';
  }
  const chat = resolveChatConfig(deps.configStore.current().config, deps.store.orm, telegramChatId);
  if (chat === undefined) {
    return '本 Chat 未在配置中找到。';
  }
  const result = await reloader.setChatUserIgnored(chat.id, sender.id, ignored);
  if (!result.ok) {
    return result.fileWritten
      ? `已写入 config.jsonc，但应用失败: ${result.message}`
      : `更新忽略名单失败: ${result.message}`;
  }
  const lines = [
    ignored
      ? '已忽略你在本 Chat 的消息，配置已立即生效。发送 /unignoreme 可恢复。'
      : '已恢复接收你在本 Chat 的消息，配置已立即生效。',
  ];
  const other = result.applied.filter((path) => path !== `telegram.chats[${chat.id}].ignored_user_ids`);
  if (other.length > 0) {
    lines.push(`同时应用了配置文件中的其它修改: ${other.join(', ')}`);
  }
  if (result.restartRequired.length > 0) {
    lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
  }
  return lines.join('\n');
}

export async function switchChatModel(
  deps: BotCommandConfigDeps,
  argument: string | undefined,
  telegramChatId: bigint,
): Promise<string> {
  const switcher = deps.modelSwitcher;
  const reloader = deps.configReloader;
  if (switcher === undefined || reloader === undefined) {
    return '运行时模型切换不可用。';
  }
  const config = deps.configStore.current().config;
  const chatConfig = resolveChatConfig(config, deps.store.orm, telegramChatId);
  if (chatConfig === undefined) {
    return '本 Chat 未在配置中找到。';
  }
  const configuredChatId = chatConfig.id;
  const effective = resolveAgentSettings(config, chatConfig);
  const options = switcher.list();

  if (argument === undefined) {
    return modelMenu(1, options, effective, chatConfig);
  }

  const pageMatch = /^page\s+(\d+)$/.exec(argument);
  if (pageMatch !== null) {
    const page = Number.parseInt(pageMatch[1] ?? '', 10);
    const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      return `无效页码。${modelMenu(1, options, effective, chatConfig)}`;
    }
    return modelMenu(page, options, effective, chatConfig);
  }
  const reset = argument === 'default';
  const index = /^\d+$/.test(argument) ? Number.parseInt(argument, 10) : NaN;
  const option = options[index - 1];
  if (!reset && option === undefined) {
    return `无效序号。${modelMenu(1, options, effective, chatConfig)}`;
  }
  const result =
    option === undefined
      ? await reloader.resetChatModel(configuredChatId)
      : await reloader.setChatModel(configuredChatId, option.provider, option.model);
  if (!result.ok) {
    return result.fileWritten
      ? `已写入 config.jsonc，但应用失败: ${result.message}`
      : `${reset ? '恢复' : '切换'}失败: ${result.message}`;
  }
  const current = deps.configStore.current().config;
  const settings = resolveAgentSettings(current, resolveChatConfig(current, deps.store.orm, telegramChatId));
  const active = completeAgentSettings(settings);
  const target = active === undefined ? '未配置' : `${active.provider} / ${active.model}`;
  const paths = switchPaths(configuredChatId);
  const lines = reset
    ? [`已清除本群模型覆盖，跟随全局 ${target}，将在下一次 agent session 生效。`]
    : [
        `已为本群切换: ${target}，已写入 config.jsonc，将在下一次 agent session 生效。`,
        `思考强度已重置为该模型最弱的一档: ${settings.thinking_level ?? '未配置'}`,
      ];
  lines.push(...applyReport(result.applied, paths, result.restartRequired));
  return lines.join('\n');
}

/**
 * `/effort`: the thinking level of this Chat's effective model. Without an
 * argument it lists the levels that model accepts; with one it writes the Chat's
 * `telegram.chats[<id>].thinking_level` override, and `default` removes that
 * override so the Chat follows `agent.thinking_level` again.
 */
export async function switchChatEffort(
  deps: BotCommandConfigDeps,
  argument: string | undefined,
  telegramChatId: bigint,
): Promise<string> {
  const reloader = deps.configReloader;
  if (reloader === undefined) {
    return '运行时配置应用不可用。';
  }
  const config = deps.configStore.current().config;
  const chatConfig = resolveChatConfig(config, deps.store.orm, telegramChatId);
  if (chatConfig === undefined) {
    return '本 Chat 未在配置中找到。';
  }
  const configuredChatId = chatConfig.id;
  const requested = argument?.trim().toLowerCase();
  // Removing the override needs no model: it must still work when the Chat's
  // model is incomplete or unregistered, which is when the override is stuck.
  if (requested === 'default') {
    return await resetChatEffort(deps, configuredChatId, telegramChatId);
  }
  const effective = resolveAgentSettings(config, chatConfig);
  const { provider, model: modelId, thinking_level: level } = effective;
  if (provider === undefined || modelId === undefined) {
    return '本群尚未配置模型，无法查看或设置思考强度。';
  }
  // The registered model, not the file entry: Pi derives the accepted levels
  // from the `thinkingLevelMap` the registry builds, which is what an invocation
  // actually runs with.
  const model = deps.configStore.current().models.getModel(provider, modelId);
  if (model === undefined) {
    return `模型 ${provider} / ${modelId} 未注册，无法查看或设置思考强度。`;
  }
  const supported = getSupportedThinkingLevels(model);

  if (requested === undefined) {
    return effortMenu(provider, modelId, level, chatConfig, supported);
  }

  if (!isThinkingLevel(requested)) {
    return `无效的思考强度: ${argument}。\n${effortMenu(provider, modelId, level, chatConfig, supported)}`;
  }
  if (!supported.includes(requested)) {
    return `${provider} / ${modelId} 不支持思考强度 ${requested}。可选: ${supported.join(', ')}`;
  }
  const result = await reloader.setChatThinkingLevel(configuredChatId, requested);
  if (!result.ok) {
    return result.fileWritten ? `已写入 config.jsonc，但应用失败: ${result.message}` : `设置失败: ${result.message}`;
  }
  const lines = [`已为本群设置思考强度: ${requested}，已写入 config.jsonc，将在下一次 agent session 生效。`];
  lines.push(
    ...applyReport(
      result.applied,
      new Set([`telegram.chats[${configuredChatId}].thinking_level`]),
      result.restartRequired,
    ),
  );
  return lines.join('\n');
}

/** `/effort default`: removes the Chat's thinking-level override. */
async function resetChatEffort(
  deps: BotCommandConfigDeps,
  configuredChatId: number,
  telegramChatId: bigint,
): Promise<string> {
  const reloader = deps.configReloader;
  if (reloader === undefined) {
    return '运行时配置应用不可用。';
  }
  const result = await reloader.resetChatThinkingLevel(configuredChatId);
  if (!result.ok) {
    return result.fileWritten ? `已写入 config.jsonc，但应用失败: ${result.message}` : `恢复失败: ${result.message}`;
  }
  const current = deps.configStore.current().config;
  const inherited = resolveAgentSettings(current, resolveChatConfig(current, deps.store.orm, telegramChatId));
  const lines = [
    `已清除本群思考强度覆盖，跟随全局 ${inherited.thinking_level ?? '未配置'}，将在下一次 agent session 生效。`,
  ];
  lines.push(
    ...applyReport(
      result.applied,
      new Set([`telegram.chats[${configuredChatId}].thinking_level`]),
      result.restartRequired,
    ),
  );
  return lines.join('\n');
}

/** The current level, what the model accepts, and how to change either. */
function effortMenu(
  provider: string,
  modelId: string,
  level: ModelThinkingLevel | undefined,
  chatConfig: RawConfig['telegram']['chats'][number],
  supported: readonly ModelThinkingLevel[],
): string {
  // A reasoning model may declare a single level such as `high`; only an
  // `off`-only list means the model cannot think.
  const thinks = supported.some((entry) => entry !== 'off');
  return [
    `本群模型: ${provider} / ${modelId}`,
    `思考强度: ${level ?? '未配置'}${chatConfig.thinking_level === undefined ? '（继承全局）' : ''}`,
    `可选: ${supported.join(', ')}${thinks ? '' : '（该模型不支持思考）'}`,
    thinks ? '使用 /effort 级别 设置本群强度，/effort default 恢复继承全局' : '使用 /effort default 恢复继承全局',
  ].join('\n');
}

/** Changes the same apply carried in from the configuration file, and pending restarts. */
function applyReport(
  applied: readonly string[],
  written: ReadonlySet<string>,
  restartRequired: readonly string[],
): string[] {
  const lines: string[] = [];
  const other = applied.filter((path) => !written.has(path));
  if (other.length > 0) {
    lines.push(`同时应用了配置文件中的其它修改: ${other.join(', ')}`);
  }
  if (restartRequired.length > 0) {
    lines.push(`另有 ${restartRequired.length} 项配置需要重启后生效。`);
  }
  return lines;
}

function modelMenu(
  page: number,
  options: readonly AgentModelOption[],
  effective: AgentSettings,
  chatConfig: RawConfig['telegram']['chats'][number],
): string {
  const hasProviderOverride = chatConfig.provider !== undefined;
  const hasModelOverride = chatConfig.model !== undefined;
  const hasThinkingOverride = chatConfig.thinking_level !== undefined;
  const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
  const start = (page - 1) * MODEL_PAGE_SIZE;
  const end = Math.min(start + MODEL_PAGE_SIZE, options.length);
  const modelLabel =
    effective.provider === undefined || effective.model === undefined
      ? '未配置'
      : `${effective.provider} / ${effective.model}${hasProviderOverride || hasModelOverride ? '' : '（继承全局）'}`;
  const lines = [
    `本群模型: ${modelLabel}`,
    `思考强度: ${effective.thinking_level ?? '未配置'}${hasThinkingOverride ? '' : '（继承全局）'}`,
    `可用模型（第 ${page}/${pageCount} 页，共 ${options.length} 条）:`,
  ];
  for (let index = start; index < end; index += 1) {
    const option = options[index];
    if (option === undefined) {
      break;
    }
    lines.push(`${index + 1}. ${option.provider} / ${option.model}（${option.name}）`);
  }
  lines.push('使用 /model 序号 切换，/model page 页码 翻页，/model default 清除本群覆盖');
  return lines.join('\n');
}
