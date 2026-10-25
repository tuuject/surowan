import { and, eq, sql } from 'drizzle-orm';
import { type ConversationContextStore, listConversationContexts } from '../../context/store.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import { resolveAgentSettings } from '../../platform/config/resolve.ts';
import { isWithinActiveWindows } from '../../platform/participation.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { chatAttentionUntil, type ParticipationRegistry } from '../../store/participation.ts';
import { chats, dailyUsage } from '../../store/schema/index.ts';
import { readDailyTokenBudget } from '../../store/sleep.ts';
import { type BusinessStore, isChatPaused } from '../../store/store.ts';

export interface BotCommandStatusDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly contexts: ConversationContextStore;
  readonly participation: ParticipationRegistry;
  internalChatId(telegramChatId: bigint): bigint | null;
  chatConfig(telegramChatId: bigint): RawConfig['telegram']['chats'][number] | undefined;
}

export function chatStatus(deps: BotCommandStatusDeps, telegramChatId: bigint, now: Date): string {
  const chat = deps.chatConfig(telegramChatId);
  if (chat === undefined) {
    throw new Error(`Chat ${telegramChatId} is not configured`);
  }
  const date = now.toISOString().slice(0, 10);
  const chatId = deps.internalChatId(telegramChatId);
  const tokens =
    deps.store.orm
      .select({ amount: dailyUsage.amount })
      .from(dailyUsage)
      .where(
        and(
          eq(dailyUsage.utcDate, date),
          eq(dailyUsage.scope, 'chat'),
          eq(dailyUsage.resource, telegramChatId.toString()),
          eq(dailyUsage.metric, 'model_tokens'),
        ),
      )
      .get()?.amount ?? 0n;
  const dailyBudget = readDailyTokenBudget(
    deps.store.orm,
    deps.configStore.current().config.agent.daily_budget.max_tokens,
    { now },
  );
  const dailyBudgetBasisPoints =
    (dailyBudget.usedTokens * 10_000n + dailyBudget.maxTokens / 2n) / dailyBudget.maxTokens;
  const dailyBudgetPercentage = `${dailyBudgetBasisPoints / 100n}.${(dailyBudgetBasisPoints % 100n).toString().padStart(2, '0')}%`;
  const tokenBreakdown =
    chatId === null
      ? null
      : deps.store.orm
          .all<{
            readTokens: bigint;
            writeTokens: bigint;
            cacheReadTokens: bigint;
            cacheWriteTokens: bigint;
          }>(
            sql`SELECT COALESCE(SUM(model_calls.input_tokens), 0) AS readTokens,
                      COALESCE(SUM(model_calls.output_tokens), 0) AS writeTokens,
                      COALESCE(SUM(model_calls.cache_read_tokens), 0) AS cacheReadTokens,
                      COALESCE(SUM(model_calls.cache_write_tokens), 0) AS cacheWriteTokens
               FROM model_calls
               JOIN invocations ON invocations.id = model_calls.invocation_id
               WHERE invocations.conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})
                 AND substr(model_calls.finished_at, 1, 10) = ${date}`,
          )
          .at(0);
  const config = deps.configStore.current().config;
  const effective = resolveAgentSettings(config, chat);
  const paused = chatId !== null && isChatPaused(deps.store.orm, chatId);
  const hasProviderOverride = chat.provider !== undefined;
  const hasModelOverride = chat.model !== undefined;
  const hasThinkingOverride = chat.thinking_level !== undefined;
  const modelLabel =
    effective.provider === undefined || effective.model === undefined
      ? '未配置'
      : `${effective.provider} / ${effective.model}${hasProviderOverride || hasModelOverride ? '' : '（继承全局）'}`;
  const lines = [
    `本群模型: ${modelLabel}`,
    `思考强度: ${effective.thinking_level ?? '未配置'}${hasThinkingOverride ? '' : '（继承全局）'}`,
    `本群今日 token 用量: ${tokens.toLocaleString('en-US')}`,
    `全局今日 token 用量: ${dailyBudget.usedTokens.toLocaleString('en-US')} / ${dailyBudget.maxTokens.toLocaleString('en-US')} (${dailyBudgetPercentage})`,
    `读取: ${(tokenBreakdown?.readTokens ?? 0n).toLocaleString('en-US')}`,
    `写入: ${(tokenBreakdown?.writeTokens ?? 0n).toLocaleString('en-US')}`,
    `缓存读取: ${(tokenBreakdown?.cacheReadTokens ?? 0n).toLocaleString('en-US')}`,
    `缓存写入: ${(tokenBreakdown?.cacheWriteTokens ?? 0n).toLocaleString('en-US')}`,
  ];
  if (paused) {
    lines.push('互动: 已暂停');
    lines.push(...contextLines(deps, telegramChatId));
    return lines.join('\n');
  }
  const participation = participationLine(deps, telegramChatId, chatId, now);
  if (participation !== null) {
    lines.push(participation);
  }
  lines.push(...contextLines(deps, telegramChatId));
  return lines.join('\n');
}

/**
 * Conversation Context visibility: how much retained history the agent sees,
 * how many sends are inside the GC window, and when the last collection ran.
 */
function contextLines(deps: BotCommandStatusDeps, telegramChatId: bigint): string[] {
  const rows = listConversationContexts(deps.store, { telegramChatId });
  if (rows.length === 0) {
    return ['Context: 尚未建立'];
  }
  return rows.map((row) => {
    const topic = row.messageThreadId === 0n ? '' : `#${row.messageThreadId.toString()} `;
    const header = deps.contexts.header(row.conversationId);
    const stats = header === undefined ? null : deps.contexts.stats(header);
    const gc = stats?.lastGcAt == null ? '未 GC' : `上次 GC ${stats.lastGcAt}`;
    return `Context ${topic}消息 ${stats?.messageCount ?? Number(row.messageCount)}，保留 send ${stats?.retainedSends ?? 0}，head_seq ${row.headSeq}，${gc}`;
  });
}

// Only chats with a configured schedule report a participation line, so chats
// that always participate keep the previous `/status` layout.
function participationLine(
  deps: BotCommandStatusDeps,
  telegramChatId: bigint,
  chatId: bigint | null,
  now: Date,
): string | null {
  const chat = deps.store.orm
    .select({ type: chats.type })
    .from(chats)
    .where(eq(chats.telegramChatId, telegramChatId))
    .get();
  if (chat === undefined) {
    return null;
  }
  const rule = deps.participation.ruleFor(deps.store.orm, telegramChatId, chat.type);
  if (rule === undefined) {
    return null;
  }
  if (isWithinActiveWindows(rule, now)) {
    return '互动: 活跃时段内';
  }
  const until = chatId === null ? null : chatAttentionUntil(deps.store.orm, chatId, now);
  return until === null ? '互动: 静默（仅 @、Reply 或关键词触发）' : `互动: 注意力窗口至 ${until}`;
}
