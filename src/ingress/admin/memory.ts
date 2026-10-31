import { and, desc, eq, gt, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { MemoPadStore } from '../../context/memo-pad/store.ts';
import {
  type MemoEntry,
  MEMO_DETAIL_MAX_LENGTH,
  MEMO_ID_PATTERN,
  MEMO_SUMMARY_MAX_LENGTH,
  MEMO_TTL_MAX_SECONDS,
  MEMO_TTL_MIN_SECONDS,
} from '../../context/memo-pad/index.ts';
import type { Orm } from '../../store/store.ts';
import { chats, memoPadEntries } from '../../store/schema/index.ts';
import { telegramHostScope, telegramIdentity } from '../../store/host-scope.ts';
import { AdminQueryError, type ListQuery, type Page, page, parseId, parseLimit } from './audit/shared.ts';

export interface MemoryAdminItem {
  readonly id: string;
  readonly chat: {
    readonly telegram_chat_id: string;
    readonly type: string;
    readonly title: string | null;
  };
  readonly summary: string;
  readonly detail: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly updated_at: string;
  readonly ttl_seconds: number | null;
  readonly remaining_seconds: number | null;
  readonly expired: boolean;
  readonly short_term: boolean;
}

export interface MemoryChatOption {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
}

const TtlSchema = Type.Union([
  Type.Integer({ minimum: MEMO_TTL_MIN_SECONDS, maximum: MEMO_TTL_MAX_SECONDS }),
  Type.Null(),
]);

const CreateMemoryBodySchema = Type.Object(
  {
    chat_id: Type.String({ pattern: '^-?[1-9][0-9]{0,15}$' }),
    summary: Type.String({ minLength: 1, maxLength: MEMO_SUMMARY_MAX_LENGTH }),
    detail: Type.String({ minLength: 1, maxLength: MEMO_DETAIL_MAX_LENGTH }),
    ttl_seconds: Type.Optional(TtlSchema),
  },
  { additionalProperties: false },
);
const UpdateMemoryBodySchema = Type.Object(
  {
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: MEMO_SUMMARY_MAX_LENGTH })),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: MEMO_DETAIL_MAX_LENGTH })),
    ttl_seconds: Type.Optional(TtlSchema),
  },
  { additionalProperties: false },
);
const createValidator = Compile(CreateMemoryBodySchema);
const updateValidator = Compile(UpdateMemoryBodySchema);

export type CreateMemoryBody = Static<typeof CreateMemoryBodySchema>;
export type UpdateMemoryBody = Static<typeof UpdateMemoryBodySchema>;

interface MemoryListRow {
  readonly id: string;
  readonly summary: string;
  readonly detail: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly updated_at: string;
  readonly chat_id: bigint;
  readonly telegram_chat_id: bigint | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
}

const MEMORY_LIST_FIELDS = {
  id: memoPadEntries.id,
  summary: memoPadEntries.summary,
  detail: memoPadEntries.detail,
  created_at: memoPadEntries.createdAt,
  expires_at: memoPadEntries.expiresAt,
  updated_at: memoPadEntries.updatedAt,
  chat_id: chats.id,
  telegram_chat_id: chats.telegramChatId,
  chat_type: chats.type,
  chat_title: chats.title,
};

export function listMemories(orm: Orm, query: ListQuery, now = new Date()): Page<MemoryAdminItem> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [telegramHostScope()];
  const nowIso = now.toISOString();
  if (query.cursor !== undefined && query.cursor !== null && query.cursor.length > 0) {
    if (!new RegExp(MEMO_ID_PATTERN).test(query.cursor)) {
      throw new AdminQueryError('invalid_cursor', 'cursor must be a memory id');
    }
    conditions.push(lt(memoPadEntries.id, query.cursor));
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(eq(chats.telegramChatId, parseId(query.chat, 'chat')));
  }
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    if (query.state === 'active') {
      conditions.push(or(isNull(memoPadEntries.expiresAt), gt(memoPadEntries.expiresAt, nowIso)) as SQL);
    } else if (query.state === 'expired') {
      conditions.push(lte(memoPadEntries.expiresAt, nowIso));
    } else if (query.state === 'short') {
      conditions.push(gt(memoPadEntries.expiresAt, nowIso));
    } else if (query.state === 'long') {
      conditions.push(isNull(memoPadEntries.expiresAt));
    } else {
      throw new AdminQueryError('invalid_state', 'state must be active, expired, short, or long');
    }
  }
  const rows = orm
    .select(MEMORY_LIST_FIELDS)
    .from(memoPadEntries)
    .innerJoin(chats, eq(chats.id, memoPadEntries.chatId))
    .where(and(...conditions))
    .orderBy(desc(memoPadEntries.id))
    .limit(limit + 1)
    .all();
  return page(rows, limit, (row) => toItem(row, nowIso));
}

export function listMemoryChats(orm: Orm): readonly MemoryChatOption[] {
  return orm
    .select({
      telegram_chat_id: chats.telegramChatId,
      type: chats.type,
      title: chats.title,
      username: chats.username,
    })
    .from(chats)
    .where(telegramHostScope())
    .orderBy(chats.telegramChatId)
    .all()
    .map((row) => ({
      telegram_chat_id: telegramIdentity(row.telegram_chat_id, 'chats.telegram_chat_id').toString(),
      type: row.type,
      title: row.title,
      username: row.username,
    }));
}

export function createMemory(orm: Orm, body: CreateMemoryBody, now = new Date()): MemoryAdminItem {
  const chatId = parseId(body.chat_id, 'chat_id');
  const chat = orm
    .select({ id: chats.id })
    .from(chats)
    .where(and(telegramHostScope(), eq(chats.telegramChatId, chatId)))
    .get();
  if (chat === undefined) {
    throw new AdminQueryError('chat_not_found', 'This chat has not been seen by the bot', 404);
  }
  const entry = new MemoPadStore(orm).create(
    chat.id,
    {
      summary: body.summary,
      detail: body.detail,
      ttlSeconds: body.ttl_seconds === null ? undefined : body.ttl_seconds,
    },
    now,
  );
  return getItem(orm, entry.id, now);
}

/** Returns the previous detail so the caller can clean up its blobs. */
export function updateMemory(
  orm: Orm,
  id: string,
  body: UpdateMemoryBody,
  now = new Date(),
): { readonly item: MemoryAdminItem; readonly previousDetail: string; readonly chatId: bigint } {
  const existing = telegramEntry(orm, id);
  if (existing === undefined) {
    throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  }
  const updated = new MemoPadStore(orm).update(
    id,
    existing.chatId,
    {
      ...(body.summary === undefined ? {} : { summary: body.summary }),
      ...(body.detail === undefined ? {} : { detail: body.detail }),
      ...(body.ttl_seconds === undefined ? {} : { ttlSeconds: body.ttl_seconds === null ? null : body.ttl_seconds }),
    },
    now,
  );
  if (updated === undefined) {
    throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  }
  return { item: getItem(orm, id, now), previousDetail: existing.detail, chatId: existing.chatId };
}

/** Returns the removed entry so the caller can clean up its blobs. */
export function deleteMemory(orm: Orm, id: string): MemoEntry {
  const existing = telegramEntry(orm, id);
  if (existing === undefined) {
    throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  }
  new MemoPadStore(orm).remove(id, existing.chatId);
  return existing;
}

export function parseMemoryId(value: string): string {
  if (!new RegExp(MEMO_ID_PATTERN).test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a memory id');
  }
  return value;
}

export function parseCreateMemoryBody(value: unknown): CreateMemoryBody {
  if (!createValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      `chat_id, summary (1-${MEMO_SUMMARY_MAX_LENGTH}), and detail (1-${MEMO_DETAIL_MAX_LENGTH}) are required`,
    );
  }
  return value;
}

export function parseUpdateMemoryBody(value: unknown): UpdateMemoryBody {
  if (!updateValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'summary, detail, or ttl_seconds is invalid');
  }
  if (value.summary === undefined && value.detail === undefined && value.ttl_seconds === undefined) {
    throw new AdminQueryError('invalid_body', 'At least one of summary, detail, or ttl_seconds is required');
  }
  return value;
}

function telegramEntry(orm: Orm, id: string): MemoEntry | undefined {
  const row = orm
    .select(MEMORY_LIST_FIELDS)
    .from(memoPadEntries)
    .innerJoin(chats, eq(chats.id, memoPadEntries.chatId))
    .where(and(telegramHostScope(), eq(memoPadEntries.id, id)))
    .get();
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    summary: row.summary,
    detail: row.detail,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function getItem(orm: Orm, id: string, now: Date): MemoryAdminItem {
  const row = orm
    .select(MEMORY_LIST_FIELDS)
    .from(memoPadEntries)
    .innerJoin(chats, eq(chats.id, memoPadEntries.chatId))
    .where(and(telegramHostScope(), eq(memoPadEntries.id, id)))
    .get();
  if (row === undefined) {
    throw new Error('Memory row vanished after write');
  }
  return toItem(row, now.toISOString());
}

function toItem(row: MemoryListRow, nowIso: string): MemoryAdminItem {
  const expiresAt = row.expires_at;
  const remainingSeconds = expiresAt === null ? null : Math.round((Date.parse(expiresAt) - Date.parse(nowIso)) / 1_000);
  return {
    id: row.id,
    chat: {
      telegram_chat_id: telegramIdentity(row.telegram_chat_id, 'chats.telegram_chat_id').toString(),
      type: row.chat_type,
      title: row.chat_title,
    },
    summary: row.summary,
    detail: row.detail,
    created_at: row.created_at,
    expires_at: expiresAt,
    updated_at: row.updated_at,
    ttl_seconds:
      expiresAt === null ? null : Math.max(0, Math.round((Date.parse(expiresAt) - Date.parse(row.created_at)) / 1_000)),
    remaining_seconds: remainingSeconds,
    expired: remainingSeconds !== null && remainingSeconds <= 0,
    short_term: expiresAt !== null,
  };
}
