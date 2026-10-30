import { randomUUID } from 'node:crypto';
import Type from 'typebox';

/**
 * Memo Pad identifiers and model-facing contracts.
 *
 * One Memo entry belongs to one Chat (never one Forum Topic), and the id keeps
 * the historical `mem_` prefix so migrated short-term memories keep their audit
 * identity. Blobs use their own `blb_` prefix and are addressed from Markdown as
 * `pwblob://<id>`.
 */

export const MEMO_ID_PATTERN = '^mem_[a-f0-9]{32}$';
export const MEMO_BLOB_ID_PATTERN = '^blb_[a-f0-9]{32}$';
export const MEMO_BLOB_URI_PATTERN = '^pwblob://blb_[a-f0-9]{32}$';
export const MEMO_BLOB_URI_PREFIX = 'pwblob://';
export const MEMO_SUMMARY_MAX_LENGTH = 150;
export const MEMO_DETAIL_MAX_LENGTH = 32_768;
/** JSON may escape each character as six bytes; reserve room for keys, id and TTL. */
export const MEMO_WRITE_INPUT_MAX_BYTES = 6 * (MEMO_SUMMARY_MAX_LENGTH + MEMO_DETAIL_MAX_LENGTH) + 256;
export const MEMO_TTL_MIN_SECONDS = 60;
export const MEMO_TTL_MAX_SECONDS = 157_680_000;
export const MEMO_SEARCH_DEFAULT_LIMIT = 20;
export const MEMO_SEARCH_MAX_LIMIT = 50;
export const MEMO_SEARCH_MAX_KEYWORDS = 10;
/** PRD: the short-term injection budget is 10% of the model window, 1 token per character. */
export const MEMO_INJECTION_TOKEN_RATIO = 0.1;

export function newMemoId(): string {
  return `mem_${randomUUID().replaceAll('-', '')}`;
}

export function newMemoBlobId(): string {
  return `blb_${randomUUID().replaceAll('-', '')}`;
}

export function memoBlobUri(id: string): string {
  return `${MEMO_BLOB_URI_PREFIX}${id}`;
}

/** Returns the blob id for a well-formed `pwblob://` URI, otherwise undefined. */
export function parseMemoBlobUri(uri: string): string | undefined {
  if (!new RegExp(MEMO_BLOB_URI_PATTERN).test(uri)) {
    return undefined;
  }
  return uri.slice(MEMO_BLOB_URI_PREFIX.length);
}

const MEMO_BLOB_REFERENCE = /pwblob:\/\/blb_[a-f0-9]{32}/g;

/** Every blob id referenced by one Markdown body, in first-seen order. */
export function memoBlobIdsIn(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(MEMO_BLOB_REFERENCE)) {
    ids.add(match[0].slice(MEMO_BLOB_URI_PREFIX.length));
  }
  return [...ids];
}

export interface MemoEntry {
  readonly id: string;
  readonly chatId: bigint;
  readonly summary: string;
  readonly detail: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
}

/** One short-term entry as it appears in the injected list/delta state. */
export interface MemoStateEntry {
  readonly id: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoBlob {
  readonly id: string;
  readonly chatId: bigint;
  readonly sha256: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly storagePath: string;
  readonly createdAt: string;
}

/** Computed at render time; committed only after the batch is persisted. */
export interface MemoStateUpdate {
  readonly refreshSeq: bigint;
  readonly stateJson: string;
  readonly pending: boolean;
}

export const AddMemoInputSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: MEMO_SUMMARY_MAX_LENGTH }),
    detail: Type.String({ minLength: 1, maxLength: MEMO_DETAIL_MAX_LENGTH }),
    /** Omit for a permanent (long-term) entry; a value makes it short-term. */
    ttl_seconds: Type.Optional(Type.Integer({ minimum: MEMO_TTL_MIN_SECONDS, maximum: MEMO_TTL_MAX_SECONDS })),
  },
  { additionalProperties: false },
);

export const UpdateMemoInputSchema = Type.Object(
  {
    id: Type.String({ pattern: MEMO_ID_PATTERN }),
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: MEMO_SUMMARY_MAX_LENGTH })),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: MEMO_DETAIL_MAX_LENGTH })),
    /** Omit to leave the current expiry; `null` promotes the entry to permanent. */
    ttl_seconds: Type.Optional(
      Type.Union([Type.Integer({ minimum: MEMO_TTL_MIN_SECONDS, maximum: MEMO_TTL_MAX_SECONDS }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export const DeleteMemoInputSchema = Type.Object(
  { id: Type.String({ pattern: MEMO_ID_PATTERN }) },
  { additionalProperties: false },
);

const DateTextSchema = Type.String({
  minLength: 10,
  maxLength: 40,
  pattern: '^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?)?$',
});

export const SearchMemoryInputSchema = Type.Object(
  {
    keywords: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: MEMO_SEARCH_MAX_KEYWORDS,
      }),
    ),
    /** Inclusive lower bound on `created_at`. */
    from: Type.Optional(DateTextSchema),
    /** Inclusive upper bound on `created_at`. */
    to: Type.Optional(DateTextSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MEMO_SEARCH_MAX_LIMIT })),
  },
  { additionalProperties: false },
);

export const ReadMemoryInputSchema = Type.Object(
  { id: Type.String({ pattern: MEMO_ID_PATTERN }) },
  { additionalProperties: false },
);

export const SaveMemoImageInputSchema = Type.Object(
  {
    /** A conversation-authorized `img_` reference from the current batch or retained history. */
    image_ref: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
