import { eq, sql } from 'drizzle-orm';
import { dailyUsage, mediaAnalyses, messages } from '../../../store/schema/index.ts';
import { storedSleepUntil } from '../../../store/sleep.ts';
import type { Orm } from '../../../store/store.ts';

interface PausedChatRow {
  readonly telegram_chat_id: bigint;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
  readonly paused_at: string;
}

interface CountRow {
  readonly label: string;
  readonly count: bigint;
}

export function overview(orm: Orm, now = new Date()): Record<string, unknown> {
  const today = now.toISOString().slice(0, 10);
  const invocationStates = orm.all<CountRow>(
    sql`SELECT state AS label, COUNT(*) AS count FROM invocations GROUP BY state ORDER BY state`,
  );
  const stickerStates = orm.all<CountRow>(
    sql`SELECT index_state AS label, COUNT(*) AS count FROM stickers WHERE active = 1 GROUP BY index_state ORDER BY index_state`,
  );
  const toolNames = orm.all<CountRow>(
    sql`SELECT tool_name AS label, COUNT(*) AS count FROM tool_calls GROUP BY tool_name ORDER BY count DESC LIMIT 10`,
  );
  const usageRows = orm
    .select({
      resource: dailyUsage.resource,
      metric: dailyUsage.metric,
      scope: dailyUsage.scope,
      amount: dailyUsage.amount,
    })
    .from(dailyUsage)
    .where(eq(dailyUsage.utcDate, today))
    .orderBy(dailyUsage.resource, dailyUsage.metric, dailyUsage.scope)
    .all();
  const storedSleep = storedSleepUntil(orm);
  const sleepUntil = storedSleep !== null && storedSleep > now.toISOString() ? storedSleep : null;
  const pausedChats = orm.all<PausedChatRow>(sql`SELECT c.telegram_chat_id, c.type, c.title, c.username, p.paused_at
       FROM chat_pause p JOIN chats c ON c.id = p.chat_id
       WHERE c.host_kind = 'telegram'
       ORDER BY p.paused_at, c.telegram_chat_id`);
  const messageCount = orm.select({ count: sql<bigint>`count(*)` }).from(messages).get();
  const analysisCount = orm
    .select({ count: sql<bigint>`count(*)` })
    .from(mediaAnalyses)
    .where(eq(mediaAnalyses.state, 'success'))
    .get();
  return {
    generated_at: now.toISOString(),
    invocation_states: invocationStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    sticker_index_states: stickerStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    top_tools: toolNames.map((row) => ({ label: row.label, count: Number(row.count) })),
    daily_usage: usageRows.map((row) => ({
      resource: row.resource,
      metric: row.metric,
      scope: row.scope,
      amount: Number(row.amount),
    })),
    runtime_status: {
      sleeping: sleepUntil !== null,
      sleep_until: sleepUntil,
      paused_chats: pausedChats.map((row) => ({
        telegram_chat_id: row.telegram_chat_id.toString(),
        type: row.type,
        title: row.title,
        username: row.username,
        paused_at: row.paused_at,
      })),
    },
    message_count: Number(messageCount?.count ?? 0n),
    cached_analysis_count: Number(analysisCount?.count ?? 0n),
  };
}

export interface UsageSeries {
  readonly days: number;
  readonly series: readonly UsagePoint[];
}

export interface UsagePoint {
  readonly date: string;
  readonly model_tokens: number;
  readonly vision_tokens: number;
  readonly tool_calls: number;
  readonly agent_invocations: number;
}

export function usage(orm: Orm, days: number, now = new Date()): UsageSeries {
  const result: UsagePoint[] = [];
  const today = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    result.push({
      date: d.toISOString().slice(0, 10),
      model_tokens: 0,
      vision_tokens: 0,
      tool_calls: 0,
      agent_invocations: 0,
    });
  }
  const firstDate = new Date(today);
  firstDate.setUTCDate(today.getUTCDate() - (days - 1));
  const from = firstDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  // Exclusive upper bound for the ISO-8601 `created_at` strings, so the count
  // queries stay range comparisons instead of per-row substr().
  const before = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);
  const byDate = new Map<string, UsagePoint>();
  for (const point of result) {
    byDate.set(point.date, point);
  }
  const apply = (date: string, metric: keyof UsagePoint, total: bigint): void => {
    const point = byDate.get(date);
    if (point === undefined) {
      return;
    }
    byDate.set(date, { ...point, [metric]: Number(total) });
  };
  const tokenRows = orm.all<{ utc_date: string; metric: string; total: bigint }>(
    sql`SELECT utc_date, metric, SUM(amount) AS total
       FROM daily_usage
       WHERE utc_date >= ${from} AND utc_date <= ${to} AND metric IN ('model_tokens', 'vision_tokens')
       GROUP BY utc_date, metric`,
  );
  for (const row of tokenRows) {
    apply(row.utc_date, row.metric === 'vision_tokens' ? 'vision_tokens' : 'model_tokens', row.total);
  }
  // Counted from the audit tables: daily_usage only records budget metrics
  // (tokens, images), so it cannot be the source for these counts.
  const invocationRows = orm.all<{ utc_date: string; total: bigint }>(
    sql`SELECT substr(created_at, 1, 10) AS utc_date, COUNT(*) AS total
       FROM invocations
       WHERE created_at >= ${from} AND created_at < ${before}
       GROUP BY utc_date`,
  );
  for (const row of invocationRows) {
    apply(row.utc_date, 'agent_invocations', row.total);
  }
  const toolCallRows = orm.all<{ utc_date: string; total: bigint }>(
    sql`SELECT substr(created_at, 1, 10) AS utc_date, COUNT(*) AS total
       FROM tool_calls
       WHERE created_at >= ${from} AND created_at < ${before}
       GROUP BY utc_date`,
  );
  for (const row of toolCallRows) {
    apply(row.utc_date, 'tool_calls', row.total);
  }
  return { days, series: Array.from(byDate.values()) };
}
