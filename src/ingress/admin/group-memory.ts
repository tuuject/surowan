import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import {
  GROUP_MEMORY_ID_PATTERN,
  GROUP_MEMORY_READ_MAX_CHARACTERS,
  GROUP_MEMORY_SUMMARY_MAX_LENGTH,
} from '../../context/group-memory/index.ts';
import { parseDay } from '../../context/group-memory/day.ts';
import {
  countPendingMessages,
  loadMessagesInRange,
  messageDate,
  renderGroupTranscript,
} from '../../context/group-memory/messages.ts';
import type { Orm } from '../../store/store.ts';
import { chats, groupMemories, groupMemoryLanes, groupMemoryRuns, messages } from '../../store/schema/index.ts';
import { telegramHostScope, telegramIdentity } from '../../store/host-scope.ts';
import {
  AdminQueryError,
  escapeLike,
  idSnapshot,
  type Page,
  parseId,
  parseWindow,
  snapshotCounts,
  snapshotPage,
  timeSnapshot,
} from './audit/shared.ts';

/**
 * Admin audit surface for group memory. It is deliberately separate from the
 * Memo Pad route: group memories are generated event indexes with a Telegram
 * message-id range, not free-form notes, and the only editable field is the
 * summary. Deleting a row does not rewind a sleeping lane, so a deleted event is
 * not regenerated from the same messages. Consolidation progress (lanes and the
 * per-batch run audit) is read-only here.
 */

export interface GroupMemoryAdminItem {
  readonly id: string;
  readonly chat: {
    readonly telegram_chat_id: string;
    readonly type: string;
    readonly title: string | null;
  };
  readonly day: string;
  readonly summary: string;
  readonly first_message_id: string;
  readonly last_message_id: string;
  readonly created_at: string;
}

const UpdateGroupMemoryBodySchema = Type.Object(
  { summary: Type.String({ minLength: 1, maxLength: GROUP_MEMORY_SUMMARY_MAX_LENGTH }) },
  { additionalProperties: false },
);
const updateValidator = Compile(UpdateGroupMemoryBodySchema);

export type UpdateGroupMemoryBody = Static<typeof UpdateGroupMemoryBodySchema>;

interface GroupMemoryRow {
  readonly id: string;
  readonly summary: string;
  readonly day: string;
  readonly first_message_id: bigint;
  readonly last_message_id: bigint;
  readonly created_at: string;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
}

const ITEM_FIELDS = {
  id: groupMemories.id,
  summary: groupMemories.summary,
  day: groupMemories.day,
  first_message_id: groupMemories.firstMessageId,
  last_message_id: groupMemories.lastMessageId,
  created_at: groupMemories.createdAt,
  chat_id: chats.id,
  telegram_chat_id: chats.telegramChatId,
  chat_type: chats.type,
  chat_title: chats.title,
};

/**
 * Newest day and range first; the row id breaks ties because Telegram message
 * ids are per Chat, so two Chats can share a day and a first id. Sleeping can
 * write an event for an older day, so the snapshot is taken on `created_at`
 * rather than on the sort key.
 */
export function listGroupMemories(
  orm: Orm,
  query: {
    readonly chat?: string | null;
    readonly day?: string | null;
    readonly search?: string | null;
    readonly limit?: string | null;
    readonly offset?: string | null;
    readonly as_of?: string | null;
  },
): Page<GroupMemoryAdminItem> {
  const window = parseWindow(query);
  const snapshot = timeSnapshot(orm, groupMemories.createdAt, groupMemories.createdAt, query.as_of);
  const conditions: SQL[] = [telegramHostScope()];
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(eq(chats.telegramChatId, parseId(query.chat, 'chat')));
  }
  if (query.day !== undefined && query.day !== null && query.day.length > 0) {
    try {
      conditions.push(eq(groupMemories.day, parseDay(query.day)));
    } catch {
      throw new AdminQueryError('invalid_day', 'day must be YYYY-MM-DD');
    }
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    conditions.push(sql`lower(${groupMemories.summary}) LIKE ${escapeLike(query.search.toLowerCase())} ESCAPE '\\'`);
  }
  const count = orm
    .select(snapshotCounts(snapshot))
    .from(groupMemories)
    .innerJoin(chats, eq(chats.id, groupMemories.chatId))
    .where(and(...conditions))
    .get();
  const rows = orm
    .select(ITEM_FIELDS)
    .from(groupMemories)
    .innerJoin(chats, eq(chats.id, groupMemories.chatId))
    .where(and(...conditions, snapshot.within))
    .orderBy(desc(groupMemories.day), desc(groupMemories.firstMessageId), desc(groupMemories.id))
    .limit(window.limit)
    .offset(window.offset)
    .all();
  return snapshotPage(rows.map(toItem), count, window, snapshot);
}

export function updateGroupMemory(orm: Orm, id: string, body: UpdateGroupMemoryBody): GroupMemoryAdminItem {
  const existing = telegramRow(orm, id);
  if (existing === undefined) {
    throw new AdminQueryError('not_found', 'Group memory does not exist', 404);
  }
  const summary = body.summary.trim();
  if (summary.length === 0) {
    throw new AdminQueryError('invalid_body', 'summary must not be blank');
  }
  orm.update(groupMemories).set({ summary }).where(eq(groupMemories.id, id)).run();
  return toItem({ ...existing, summary });
}

export function deleteGroupMemory(orm: Orm, id: string): void {
  const existing = telegramRow(orm, id);
  if (existing === undefined) {
    throw new AdminQueryError('not_found', 'Group memory does not exist', 404);
  }
  orm.delete(groupMemories).where(eq(groupMemories.id, id)).run();
}

export function parseGroupMemoryId(value: string): string {
  if (!new RegExp(GROUP_MEMORY_ID_PATTERN).test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a group memory id');
  }
  return value;
}

export function parseUpdateGroupMemory(value: unknown): UpdateGroupMemoryBody {
  if (!updateValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', `summary (1-${GROUP_MEMORY_SUMMARY_MAX_LENGTH}) is required`);
  }
  return value;
}

/** The stored source range rendered for the panel; capped so one event cannot bloat the response. */
export function groupMemorySource(
  orm: Orm,
  id: string,
): {
  readonly text: string;
  readonly count: number;
  readonly first_message_id: string;
  readonly last_message_id: string;
} {
  const row = telegramRow(orm, id);
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'Group memory does not exist', 404);
  }
  const messages = loadMessagesInRange(orm, row.chat_id, row.first_message_id, row.last_message_id);
  const full = renderGroupTranscript(messages);
  const text =
    full.length <= GROUP_MEMORY_READ_MAX_CHARACTERS
      ? full
      : `${full.slice(0, GROUP_MEMORY_READ_MAX_CHARACTERS)}\n[... source truncated; open the range in Messages]`;
  return {
    text,
    count: messages.length,
    first_message_id: row.first_message_id.toString(),
    last_message_id: row.last_message_id.toString(),
  };
}

function telegramRow(orm: Orm, id: string): GroupMemoryRow | undefined {
  return orm
    .select(ITEM_FIELDS)
    .from(groupMemories)
    .innerJoin(chats, eq(chats.id, groupMemories.chatId))
    .where(and(telegramHostScope(), eq(groupMemories.id, parseGroupMemoryId(id))))
    .get();
}

function toItem(row: GroupMemoryRow): GroupMemoryAdminItem {
  return {
    id: row.id,
    chat: {
      telegram_chat_id: telegramIdentity(row.telegram_chat_id, 'chats.telegram_chat_id').toString(),
      type: row.chat_type,
      title: row.chat_title,
    },
    day: row.day,
    summary: row.summary,
    first_message_id: row.first_message_id.toString(),
    last_message_id: row.last_message_id.toString(),
    created_at: row.created_at,
  };
}

export interface GroupMemoryLaneProgress {
  readonly lane: 'live' | 'backfill';
  readonly through_message_id: string;
  /** When the message at the cursor was sent; null before the first one. */
  readonly through_at: string | null;
  readonly until_message_id: string | null;
  readonly until_at: string | null;
  /** Visible messages the lane still has to read. */
  readonly pending: number;
  readonly state: 'idle' | 'running';
  readonly last_attempt_at: string | null;
  readonly last_success_at: string | null;
  readonly next_attempt_at: string | null;
  readonly error_code: string | null;
  readonly consecutive_failures: number;
}

export interface GroupMemoryProgressItem {
  readonly chat: GroupMemoryAdminItem['chat'];
  readonly lanes: readonly GroupMemoryLaneProgress[];
  readonly memories: { readonly count: number; readonly latest_day: string | null };
  readonly newest_message_at: string | null;
  /** Batches of the last 24 hours, by outcome. */
  readonly runs_24h: { readonly success: number; readonly error: number; readonly model_calls: number };
  readonly last_error: {
    readonly code: string;
    readonly detail: string | null;
    readonly lane: 'live' | 'backfill';
    readonly day: string;
    readonly at: string;
  } | null;
}

/**
 * One row per Chat that group memory is consolidating (it has a lane). A Chat
 * switched off has no lanes and drops out; its summaries stay in the list.
 */
export function groupMemoryProgress(orm: Orm, now = new Date()): { readonly items: GroupMemoryProgressItem[] } {
  const laneRows = orm
    .select({
      lane: groupMemoryLanes,
      telegram_chat_id: chats.telegramChatId,
      chat_type: chats.type,
      chat_title: chats.title,
    })
    .from(groupMemoryLanes)
    .innerJoin(chats, eq(chats.id, groupMemoryLanes.chatId))
    .where(telegramHostScope())
    .orderBy(groupMemoryLanes.chatId, groupMemoryLanes.lane)
    .all();
  const byChat = new Map<bigint, typeof laneRows>();
  for (const row of laneRows) {
    byChat.set(row.lane.chatId, [...(byChat.get(row.lane.chatId) ?? []), row]);
  }
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const items = [...byChat.entries()].map(([chatId, rows]): GroupMemoryProgressItem => {
    const head = rows[0];
    if (head === undefined) {
      throw new Error('progress group without lanes');
    }
    const lanes = rows
      .map((row) => row.lane)
      .sort((left, right) => (left.lane === right.lane ? 0 : left.lane === 'live' ? -1 : 1))
      .map(
        (lane): GroupMemoryLaneProgress => ({
          lane: lane.lane,
          through_message_id: lane.throughMessageId.toString(),
          through_at: lane.throughMessageId === 0n ? null : messageDate(orm, chatId, lane.throughMessageId),
          until_message_id: lane.untilMessageId?.toString() ?? null,
          until_at: lane.untilMessageId === null ? null : messageDate(orm, chatId, lane.untilMessageId),
          pending: countPendingMessages(orm, chatId, { after: lane.throughMessageId, until: lane.untilMessageId }),
          state: lane.state,
          last_attempt_at: lane.lastAttemptAt,
          last_success_at: lane.lastSuccessAt,
          next_attempt_at: lane.nextAttemptAt,
          error_code: lane.errorCode,
          consecutive_failures: Number(lane.consecutiveFailures),
        }),
      );
    const memories = orm
      .select({ count: sql<bigint>`count(*)`, latest: sql<string | null>`max(${groupMemories.day})` })
      .from(groupMemories)
      .where(eq(groupMemories.chatId, chatId))
      .get();
    const newest = orm
      .select({ at: sql<string | null>`max(${messages.telegramDate})` })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .get();
    const runs = orm
      .select({
        success: sql<bigint>`count(*) FILTER (WHERE ${groupMemoryRuns.state} = 'success')`,
        error: sql<bigint>`count(*) FILTER (WHERE ${groupMemoryRuns.state} = 'error')`,
        calls: sql<bigint>`coalesce(sum(${groupMemoryRuns.modelCalls}), 0)`,
      })
      .from(groupMemoryRuns)
      .where(and(eq(groupMemoryRuns.chatId, chatId), gte(groupMemoryRuns.startedAt, since)))
      .get();
    const lastError = orm
      .select({
        code: groupMemoryRuns.errorCode,
        detail: groupMemoryRuns.errorDetail,
        lane: groupMemoryRuns.lane,
        day: groupMemoryRuns.day,
        at: sql<string>`coalesce(${groupMemoryRuns.finishedAt}, ${groupMemoryRuns.startedAt})`,
      })
      .from(groupMemoryRuns)
      .where(and(eq(groupMemoryRuns.chatId, chatId), eq(groupMemoryRuns.state, 'error')))
      .orderBy(desc(groupMemoryRuns.id))
      .limit(1)
      .get();
    return {
      chat: {
        telegram_chat_id: telegramIdentity(head.telegram_chat_id, 'chats.telegram_chat_id').toString(),
        type: head.chat_type,
        title: head.chat_title,
      },
      lanes,
      memories: { count: Number(memories?.count ?? 0n), latest_day: memories?.latest ?? null },
      newest_message_at: newest?.at ?? null,
      runs_24h: {
        success: Number(runs?.success ?? 0n),
        error: Number(runs?.error ?? 0n),
        model_calls: Number(runs?.calls ?? 0n),
      },
      last_error:
        lastError === undefined
          ? null
          : {
              code: lastError.code ?? 'group_memory_error',
              detail: lastError.detail,
              lane: lastError.lane,
              day: lastError.day,
              at: lastError.at,
            },
    };
  });
  return { items };
}

export interface GroupMemoryRunItem {
  readonly id: string;
  readonly chat: GroupMemoryAdminItem['chat'];
  readonly lane: 'live' | 'backfill';
  readonly day: string;
  readonly first_message_id: string;
  readonly through_message_id: string;
  readonly messages: number;
  readonly state: 'running' | 'success' | 'error';
  readonly events: number | null;
  readonly model_calls: number;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

const RUN_STATES = new Set(['running', 'success', 'error']);

/** Consolidation batches, newest first; `state` narrows to one outcome. */
export function listGroupMemoryRuns(
  orm: Orm,
  query: {
    readonly chat?: string | null;
    readonly state?: string | null;
    readonly limit?: string | null;
    readonly offset?: string | null;
    readonly as_of?: string | null;
  },
): Page<GroupMemoryRunItem> {
  const window = parseWindow(query);
  const snapshot = idSnapshot(orm, groupMemoryRuns.id, groupMemoryRuns.id, query.as_of);
  const conditions: SQL[] = [telegramHostScope()];
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(eq(chats.telegramChatId, parseId(query.chat, 'chat')));
  }
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    if (!RUN_STATES.has(query.state)) {
      throw new AdminQueryError('invalid_state', 'state must be running, success or error');
    }
    conditions.push(eq(groupMemoryRuns.state, query.state as GroupMemoryRunItem['state']));
  }
  const count = orm
    .select(snapshotCounts(snapshot))
    .from(groupMemoryRuns)
    .innerJoin(chats, eq(chats.id, groupMemoryRuns.chatId))
    .where(and(...conditions))
    .get();
  const rows = orm
    .select({
      run: groupMemoryRuns,
      telegram_chat_id: chats.telegramChatId,
      chat_type: chats.type,
      chat_title: chats.title,
    })
    .from(groupMemoryRuns)
    .innerJoin(chats, eq(chats.id, groupMemoryRuns.chatId))
    .where(and(...conditions, snapshot.within))
    .orderBy(desc(groupMemoryRuns.id))
    .limit(window.limit)
    .offset(window.offset)
    .all();
  return snapshotPage(
    rows.map(
      ({ run, telegram_chat_id, chat_type, chat_title }): GroupMemoryRunItem => ({
        id: run.id.toString(),
        chat: {
          telegram_chat_id: telegramIdentity(telegram_chat_id, 'chats.telegram_chat_id').toString(),
          type: chat_type,
          title: chat_title,
        },
        lane: run.lane,
        day: run.day,
        first_message_id: run.firstMessageId.toString(),
        through_message_id: run.throughMessageId.toString(),
        messages: Number(run.messages),
        state: run.state,
        events: run.events === null ? null : Number(run.events),
        model_calls: Number(run.modelCalls),
        error_code: run.errorCode,
        error_detail: run.errorDetail,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
      }),
    ),
    count,
    window,
    snapshot,
  );
}
