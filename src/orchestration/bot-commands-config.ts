import type { AgentSettings, RawConfig } from '../platform/config.ts';
import { completeAgentSettings, resolveAgentSettings } from '../platform/config-resolve.ts';
import type { BotCommandConfigWriter } from '../platform/config-write.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { type BusinessStore, resolveChatConfig } from '../store/store.ts';
import type { CommandSender } from './bot-commands.ts';

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
  const other = result.applied.filter((path) => !paths.has(path));
  if (other.length > 0) {
    lines.push(`同时应用了配置文件中的其它修改: ${other.join(', ')}`);
  }
  if (result.restartRequired.length > 0) {
    lines.push(`另有 ${result.restartRequired.length} 项配置需要重启后生效。`);
  }
  return lines.join('\n');
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
