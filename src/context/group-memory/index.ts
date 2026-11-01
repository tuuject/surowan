import { randomUUID } from 'node:crypto';
import Type from 'typebox';

/**
 * Group-memory contracts shared by the sleeping worker and the recall tools.
 *
 * One entry is a short event summary of one Chat-local day plus the inclusive
 * Telegram message-id range it summarizes. The summary is the first disclosure
 * layer; `read_group_messages` replays the range for the second. Entries are
 * Chat-scoped, never Topic-scoped, so every Forum Topic of a Chat sees the same
 * history.
 */

export const GROUP_MEMORY_ID_PATTERN = '^gmem_[a-f0-9]{32}$';
export const GROUP_MEMORY_SUMMARY_MAX_LENGTH = 150;
export const GROUP_MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const GROUP_MEMORY_SEARCH_MAX_LIMIT = 50;
export const GROUP_MEMORY_SEARCH_MAX_KEYWORDS = 10;
export const GROUP_MEMORY_DEFAULT_IDLE_MINUTES = 30;
/** A batch bounds the consolidation prompt; later batches continue the same day. */
export const GROUP_MEMORY_BATCH_MAX_MESSAGES = 120;
export const GROUP_MEMORY_BATCH_MAX_CHARACTERS = 40_000;
export const GROUP_MEMORY_EVENTS_MAX = 50;
export const GROUP_MEMORY_READ_MAX_MESSAGES = 200;
/** The raw replay is a tool result inside Context; keep it well below the window. */
export const GROUP_MEMORY_READ_MAX_CHARACTERS = 20_000;
export const GROUP_MEMORY_READ_MAX_SPAN = 2_000;
export const GROUP_MEMORY_CONSOLIDATION_TIMEOUT_MS = 120_000;
export const GROUP_MEMORY_CONSOLIDATION_MAX_OUTPUT_TOKENS = 4_096;
/** A claimed batch older than this is recovered as idle after a crash. */
export const GROUP_MEMORY_CLAIM_STALE_MS = 30 * 60 * 1_000;
export const GROUP_MEMORY_RETRY_DELAY_MS = 30 * 60 * 1_000;
export const GROUP_MEMORY_TICK_MS = 60 * 1_000;

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export function newGroupMemoryId(): string {
  return `gmem_${randomUUID().replaceAll('-', '')}`;
}

export interface GroupMemoryEntry {
  readonly id: string;
  readonly chatId: bigint;
  readonly day: string;
  readonly summary: string;
  readonly firstMessageId: bigint;
  readonly lastMessageId: bigint;
  readonly createdAt: string;
}

export interface GroupMemoryStateRow {
  readonly chatId: bigint;
  readonly consolidatedThroughMessageId: bigint;
  readonly state: 'idle' | 'running';
  readonly claimedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
}

export interface GroupMemoryEvent {
  readonly summary: string;
  readonly firstMessageId: bigint;
  readonly lastMessageId: bigint;
}

export const SearchGroupMemoryInputSchema = Type.Object(
  {
    /** Chat-local `YYYY-MM-DD`; omit to search the newest entries across days. */
    date: Type.Optional(Type.String({ pattern: DATE_PATTERN })),
    keywords: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: GROUP_MEMORY_SEARCH_MAX_KEYWORDS,
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: GROUP_MEMORY_SEARCH_MAX_LIMIT })),
  },
  { additionalProperties: false },
);

export const ReadGroupMessagesInputSchema = Type.Object(
  {
    first_message_id: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    last_message_id: Type.Integer({ minimum: 1, maximum: 9_007_199_254_740_991 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: GROUP_MEMORY_READ_MAX_MESSAGES })),
  },
  { additionalProperties: false },
);

/**
 * The model's consolidation reply. Ranges are validated against the actual batch
 * after parsing; the schema only fixes their shape.
 */
export const ConsolidatedEventsSchema = Type.Object(
  {
    events: Type.Array(
      Type.Object(
        {
          summary: Type.String({ minLength: 1, maxLength: GROUP_MEMORY_SUMMARY_MAX_LENGTH }),
          first_message_id: Type.Integer({ minimum: 1 }),
          last_message_id: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: GROUP_MEMORY_EVENTS_MAX },
    ),
  },
  { additionalProperties: false },
);
