import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import {
  GROUP_MEMORY_ID_PATTERN,
  GROUP_MEMORY_READ_MAX_CHARACTERS,
  GROUP_MEMORY_SUMMARY_MAX_LENGTH,
} from '../../context/group-memory/index.ts';
import { parseDay } from '../../context/group-memory/day.ts';
import { loadMessagesInRange, renderGroupTranscript } from '../../context/group-memory/messages.ts';
import type { Orm } from '../../store/store.ts';
import { chats, groupMemories } from '../../store/schema/index.ts';
import { telegramHostScope, telegramIdentity } from '../../store/host-scope.ts';
import {
  AdminQueryError,
  escapeLike,
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
 * summary. Deleting a row does not rewind the sleeping watermark, so a deleted
 * event is not regenerated from the same messages.
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
