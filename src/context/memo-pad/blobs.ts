import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { and, eq, lt, sql } from 'drizzle-orm';
import { memoBlobs } from '../../store/schema/index.ts';
import { asRunResult, type Orm } from '../../store/store.ts';
import { type MemoBlob, MEMO_BLOB_URI_PREFIX, memoBlobIdsIn, newMemoBlobId } from './index.ts';

/** Matches the normalized image output cap; larger payloads are refused. */
export const MEMO_BLOB_MAX_BYTES = 10 * 1024 * 1024;

/**
 * A blob becomes referenced only when a Memo detail is written after
 * `save_memo_image` returns. Every save renews the grace window, including reuse,
 * so the two-call flow cannot lose the image before the model writes the URI.
 */
const MEMO_BLOB_SWEEP_GRACE_MS = 10 * 60_000;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface MemoBlobStoreOptions {
  readonly orm: Orm;
  /** `<data_dir>/images/memo-blobs`. */
  readonly root: string;
  readonly now?: () => Date;
}

const BLOB_FIELDS = {
  id: memoBlobs.id,
  chatId: memoBlobs.chatId,
  sha256: memoBlobs.sha256,
  mime: memoBlobs.mime,
  byteSize: memoBlobs.byteSize,
  storagePath: memoBlobs.storagePath,
  createdAt: memoBlobs.createdAt,
} as const;

/**
 * Chat-owned binary storage. Rows are deduped by `(chat_id, sha256)` so several
 * Memo entries in the same Chat share one file; another Chat always gets its own
 * copy. Deletion is reference-based: a file goes only once no Memo detail in
 * that Chat still contains its `pwblob://` URI.
 */
export class MemoBlobStore {
  readonly #orm: Orm;
  readonly #root: string;
  readonly #now: () => Date;

  constructor(options: MemoBlobStoreOptions) {
    this.#orm = options.orm;
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date());
  }

  get(id: string, chatId: bigint): MemoBlob | undefined {
    const row = this.#orm
      .select(BLOB_FIELDS)
      .from(memoBlobs)
      .where(and(eq(memoBlobs.id, id), eq(memoBlobs.chatId, chatId)))
      .get();
    return row === undefined ? undefined : { ...row, byteSize: Number(row.byteSize) };
  }

  /** Admin-only lookup across Chats; the panel session is the permission check. */
  getUnscoped(id: string): MemoBlob | undefined {
    const row = this.#orm.select(BLOB_FIELDS).from(memoBlobs).where(eq(memoBlobs.id, id)).get();
    return row === undefined ? undefined : { ...row, byteSize: Number(row.byteSize) };
  }

  absolutePath(blob: MemoBlob): string {
    return this.#absolute(blob.storagePath);
  }

  async content(blob: MemoBlob): Promise<Uint8Array> {
    return await readFile(this.absolutePath(blob));
  }

  /**
   * Store one normalized image. Returns the existing row when these exact bytes
   * are already stored for this Chat; the caller may safely keep using the URI.
   */
  async ingest(
    chatId: bigint,
    input: { readonly bytes: Uint8Array; readonly mime: string },
  ): Promise<{ readonly blob: MemoBlob; readonly created: boolean }> {
    const extension = EXTENSIONS[input.mime];
    if (extension === undefined) {
      throw new Error('Memo blobs only accept JPEG or PNG images');
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MEMO_BLOB_MAX_BYTES) {
      throw new Error('Memo blob is empty or too large');
    }
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.#reuseByContent(chatId, sha256);
    if (existing !== undefined) {
      return { blob: existing, created: false };
    }
    const id = newMemoBlobId();
    const storagePath = join(chatId.toString(), `${id}.${extension}`);
    const absolute = this.#absolute(storagePath);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(temporary, input.bytes, { flag: 'wx' });
    await rename(temporary, absolute);
    const createdAt = this.#now().toISOString();
    const inserted = this.#orm
      .insert(memoBlobs)
      .values({
        id,
        chatId,
        sha256,
        mime: input.mime,
        byteSize: BigInt(input.bytes.byteLength),
        storagePath,
        createdAt,
        lastSavedAt: createdAt,
      })
      .onConflictDoUpdate({
        target: [memoBlobs.chatId, memoBlobs.sha256],
        set: { lastSavedAt: createdAt },
      })
      .returning({ id: memoBlobs.id })
      .get();
    if (inserted?.id !== id) {
      // Protect the concurrent winner before awaiting removal of this copy,
      // then renew again so the caller gets a full grace window on return.
      await rm(absolute, { force: true });
      const winner = this.#reuseByContent(chatId, sha256);
      if (winner === undefined) {
        throw new Error('Concurrent Memo blob save left no row');
      }
      return { blob: winner, created: false };
    }
    return {
      blob: { id, chatId, sha256, mime: input.mime, byteSize: input.bytes.byteLength, storagePath, createdAt },
      created: true,
    };
  }

  /**
   * Drops blobs that the previous detail referenced and the new one does not,
   * but only when no other Memo entry in the Chat still references them.
   */
  async cleanupAfterDetailChange(chatId: bigint, previousDetail: string): Promise<number> {
    const referenced = new Set(
      this.#orm
        .all<{ detail: string }>(sql`SELECT detail FROM memo_pad_entries WHERE chat_id = ${chatId}`)
        .flatMap((row) => memoBlobIdsIn(row.detail)),
    );
    const candidates = memoBlobIdsIn(previousDetail).filter((id) => !referenced.has(id));
    let deleted = 0;
    for (const id of candidates) {
      if (await this.#deleteIfUnreferenced(chatId, id)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Deletes unreferenced blobs once the grace window since their last save passes. */
  async sweep(
    chatId: bigint | null = null,
    now = new Date(),
    graceMilliseconds = MEMO_BLOB_SWEEP_GRACE_MS,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - graceMilliseconds).toISOString();
    const rows = this.#orm.all<{ id: string; storage_path: string }>(
      chatId === null
        ? sql`SELECT b.id, b.storage_path
              FROM memo_blobs b
              WHERE b.last_saved_at < ${cutoff}
                AND NOT EXISTS (
                  SELECT 1 FROM memo_pad_entries e
                  WHERE e.chat_id = b.chat_id AND instr(e.detail, ${MEMO_BLOB_URI_PREFIX} || b.id) > 0
                )`
        : sql`SELECT b.id, b.storage_path
              FROM memo_blobs b
              WHERE b.chat_id = ${chatId}
                AND b.last_saved_at < ${cutoff}
                AND NOT EXISTS (
                  SELECT 1 FROM memo_pad_entries e
                  WHERE e.chat_id = b.chat_id AND instr(e.detail, ${MEMO_BLOB_URI_PREFIX} || b.id) > 0
                )`,
    );
    let deleted = 0;
    for (const row of rows) {
      const removed = asRunResult(
        this.#orm
          .delete(memoBlobs)
          .where(
            and(
              eq(memoBlobs.id, row.id),
              chatId === null ? undefined : eq(memoBlobs.chatId, chatId),
              lt(memoBlobs.lastSavedAt, cutoff),
              sql`NOT EXISTS (
                SELECT 1 FROM memo_pad_entries e
                WHERE e.chat_id = ${memoBlobs.chatId}
                  AND instr(e.detail, ${MEMO_BLOB_URI_PREFIX} || ${memoBlobs.id}) > 0
              )`,
            ),
          )
          .run(),
      );
      if (removed.changes === 1) {
        await rm(this.#absolute(row.storage_path), { force: true }).catch(() => undefined);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Storage paths of one Chat, collected before its rows are deleted. */
  storagePaths(chatId: bigint): string[] {
    return this.#orm
      .select({ storagePath: memoBlobs.storagePath })
      .from(memoBlobs)
      .where(eq(memoBlobs.chatId, chatId))
      .all()
      .map((row) => row.storagePath);
  }

  /** Removes the given relative files; an already missing file is ignored. */
  async removeFiles(storagePaths: readonly string[]): Promise<void> {
    for (const storagePath of storagePaths) {
      await rm(this.#absolute(storagePath), { force: true }).catch(() => undefined);
    }
  }

  /** Removes the files of one Chat. Rows are removed by the `chats` cascade. */
  async deleteChatFiles(chatId: bigint): Promise<void> {
    await this.removeFiles(this.storagePaths(chatId));
  }

  async #deleteIfUnreferenced(chatId: bigint, id: string): Promise<boolean> {
    const referenced = this.#orm
      .all<{ present: number }>(
        sql`SELECT 1 AS present FROM memo_pad_entries
            WHERE chat_id = ${chatId} AND instr(detail, ${`${MEMO_BLOB_URI_PREFIX}${id}`}) > 0
            LIMIT 1`,
      )
      .at(0);
    if (referenced !== undefined) {
      return false;
    }
    const row = this.#orm
      .select({ storagePath: memoBlobs.storagePath })
      .from(memoBlobs)
      .where(and(eq(memoBlobs.id, id), eq(memoBlobs.chatId, chatId)))
      .get();
    if (row === undefined) {
      return false;
    }
    const removed = asRunResult(
      this.#orm
        .delete(memoBlobs)
        .where(and(eq(memoBlobs.id, id), eq(memoBlobs.chatId, chatId)))
        .run(),
    );
    if (removed.changes !== 1) {
      return false;
    }
    await rm(this.#absolute(row.storagePath), { force: true }).catch(() => undefined);
    return true;
  }

  #reuseByContent(chatId: bigint, sha256: string): MemoBlob | undefined {
    const row = this.#orm
      .update(memoBlobs)
      .set({ lastSavedAt: this.#now().toISOString() })
      .where(and(eq(memoBlobs.chatId, chatId), eq(memoBlobs.sha256, sha256)))
      .returning(BLOB_FIELDS)
      .get();
    return row === undefined ? undefined : { ...row, byteSize: Number(row.byteSize) };
  }

  #absolute(storagePath: string): string {
    const absolute = resolve(this.#root, storagePath);
    if (absolute !== this.#root && !absolute.startsWith(`${this.#root}${sep}`)) {
      throw new Error('Memo blob path escapes the blob root');
    }
    return absolute;
  }
}
