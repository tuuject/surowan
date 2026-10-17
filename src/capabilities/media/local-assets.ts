import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { playgroundAssets } from '../../store/schema.ts';
import type { Orm } from '../../store/store.ts';

/** The only formats a room may hold. Everything else is refused by content. */
export type LocalImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const IMAGE_FORMATS: Readonly<Record<LocalImageMime, string>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const EXTENSIONS: Readonly<Record<LocalImageMime, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** A room image is a static still, not an animation or a document. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_PIXELS = 40_000_000;
const ASSET_ID_PATTERN = /^[a-f0-9]{32}$/;

export type LocalAssetRejection =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'type_mismatch'
  | 'corrupt'
  | 'too_many_pixels'
  | 'animated';

export class LocalAssetRejected extends Error {
  readonly reason: LocalAssetRejection;

  constructor(reason: LocalAssetRejection, message: string) {
    super(message);
    this.name = 'LocalAssetRejected';
    this.reason = reason;
  }
}

export interface LocalAssetInput {
  readonly bytes: Uint8Array;
  /** MIME type as claimed by the uploader; must match the real content. */
  readonly declaredMime: string;
  readonly name?: string;
}

export interface LocalAsset {
  readonly id: string;
  readonly chatId: bigint;
  readonly sha256: string;
  readonly mime: LocalImageMime;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  /** Absolute path of the stored file; never derived from a caller string. */
  readonly path: string;
}

/**
 * Detect an image by its magic bytes.
 *
 * The uploader's claim is never trusted: an SVG, an HTML page or a `.png` that
 * is really a zip has no signature here and is refused.
 */
export function sniffImageMime(bytes: Uint8Array): LocalImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface PlaygroundAssetStoreOptions {
  readonly orm: Orm;
  /** Directory that owns local room assets; files are never written elsewhere. */
  readonly root: string;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
}

/**
 * Local static image assets for Playground rooms.
 *
 * Validation happens on the bytes, storage is confined to `root`, and the row
 * is the only way back to a file: no caller may name a path.
 */
export class PlaygroundAssetStore {
  readonly #orm: Orm;
  readonly #root: string;
  readonly #now: () => Date;
  readonly #maxBytes: number;
  readonly #maxPixels: number;

  constructor(options: PlaygroundAssetStoreOptions) {
    this.#orm = options.orm;
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date());
    this.#maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
    this.#maxPixels = options.maxPixels ?? MAX_ASSET_PIXELS;
  }

  ids(chatId: bigint): string[] {
    return this.#orm
      .select({ id: playgroundAssets.id })
      .from(playgroundAssets)
      .where(eq(playgroundAssets.chatId, chatId))
      .all()
      .map((row) => row.id);
  }

  async ingest(chatId: bigint, input: LocalAssetInput): Promise<LocalAsset> {
    if (input.bytes.byteLength === 0) {
      throw new LocalAssetRejected('empty', 'Image upload is empty');
    }
    if (input.bytes.byteLength > this.#maxBytes) {
      throw new LocalAssetRejected('too_large', 'Image upload exceeds the size limit');
    }
    const declared = input.declaredMime.trim().toLowerCase();
    if (!isLocalImageMime(declared)) {
      throw new LocalAssetRejected('unsupported_type', `Unsupported image type: ${input.declaredMime}`);
    }
    const sniffed = sniffImageMime(input.bytes);
    if (sniffed === null) {
      throw new LocalAssetRejected('unsupported_type', 'Upload is not a JPEG, PNG or WebP image');
    }
    if (sniffed !== declared) {
      throw new LocalAssetRejected('type_mismatch', 'Declared image type does not match the content');
    }
    const { width, height } = await this.#inspect(input.bytes, sniffed);

    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.#byContent(chatId, sha256);
    if (existing !== undefined) {
      return existing;
    }

    const id = randomBytes(16).toString('hex');
    const relativePath = join(chatId.toString(), `${id}.${EXTENSIONS[sniffed]}`);
    const absolute = this.#absolute(relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(temporary, input.bytes, { flag: 'wx' });
    await rename(temporary, absolute);

    this.#orm
      .insert(playgroundAssets)
      .values({
        id,
        chatId,
        sha256,
        mime: sniffed,
        byteSize: BigInt(input.bytes.byteLength),
        width: BigInt(width),
        height: BigInt(height),
        storagePath: relativePath,
        state: 'staged',
        createdAt: this.#now().toISOString(),
      })
      .run();

    return {
      id,
      chatId,
      sha256,
      mime: sniffed,
      byteSize: input.bytes.byteLength,
      width,
      height,
      path: absolute,
    };
  }

  /** Point an asset at the message media row that now owns it. */
  markAttached(assetId: string, mediaId: bigint): void {
    this.#orm
      .update(playgroundAssets)
      .set({ state: 'attached', mediaId, attachedAt: this.#now().toISOString() })
      .where(eq(playgroundAssets.id, assetId))
      .run();
  }

  /** Resolve an asset id to its stored file. Unknown ids resolve to null. */
  resolve(assetId: string): { path: string; mime: LocalImageMime; width: number; height: number } | null {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      return null;
    }
    const [row] = this.#orm.select().from(playgroundAssets).where(eq(playgroundAssets.id, assetId)).all();
    if (row === undefined) {
      return null;
    }
    if (!isLocalImageMime(row.mime)) {
      return null;
    }
    return {
      path: this.#absolute(row.storagePath),
      mime: row.mime,
      width: Number(row.width),
      height: Number(row.height),
    };
  }

  async read(assetId: string): Promise<Uint8Array | null> {
    const asset = this.resolve(assetId);
    if (asset === null) {
      return null;
    }
    try {
      return await readFile(asset.path);
    } catch {
      return null;
    }
  }

  /**
   * Remove uploads that never became a message, and files whose row is gone.
   *
   * Attached assets are kept: history still references them. A staged upload is
   * disposable once the retention window has passed.
   */
  async sweep(options: { readonly staleAfterMs?: number } = {}): Promise<{ staged: number; orphans: number }> {
    const staleAfterMs = options.staleAfterMs ?? 60 * 60 * 1000;
    const cutoff = new Date(this.#now().getTime() - staleAfterMs).toISOString();
    // A staged upload never became a message. An attached one whose media row
    // was removed (a rewound release deletes revisions) is just as orphaned:
    // `media_id` is nulled by the foreign key when that happens.
    const stale = this.#orm
      .select({ id: playgroundAssets.id, path: playgroundAssets.storagePath })
      .from(playgroundAssets)
      .where(
        and(
          lt(playgroundAssets.createdAt, cutoff),
          or(eq(playgroundAssets.state, 'staged'), isNull(playgroundAssets.mediaId)),
        ),
      )
      .all();

    let staged = 0;
    for (const asset of stale) {
      await rm(this.#absolute(asset.path), { force: true });
      this.#orm.delete(playgroundAssets).where(eq(playgroundAssets.id, asset.id)).run();
      staged += 1;
    }

    const orphans = await this.#sweepOrphanFiles(cutoff);
    return { staged, orphans };
  }

  async #inspect(bytes: Uint8Array, mime: LocalImageMime): Promise<{ width: number; height: number }> {
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: this.#maxPixels }).metadata();
    } catch {
      throw new LocalAssetRejected('corrupt', 'Image could not be decoded');
    }
    if (metadata.format !== IMAGE_FORMATS[mime]) {
      throw new LocalAssetRejected('type_mismatch', 'Decoded image format does not match the declared type');
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < 1 || height < 1) {
      throw new LocalAssetRejected('corrupt', 'Image has no usable dimensions');
    }
    if (width * height > this.#maxPixels) {
      throw new LocalAssetRejected('too_many_pixels', 'Image exceeds the pixel limit');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new LocalAssetRejected('animated', 'Animated images are not supported');
    }
    return { width, height };
  }

  #byContent(chatId: bigint, sha256: string): LocalAsset | undefined {
    const [row] = this.#orm
      .select()
      .from(playgroundAssets)
      .where(and(eq(playgroundAssets.chatId, chatId), eq(playgroundAssets.sha256, sha256)))
      .all();
    if (row === undefined || !isLocalImageMime(row.mime)) {
      return undefined;
    }
    return {
      id: row.id,
      chatId: row.chatId,
      sha256: row.sha256,
      mime: row.mime,
      byteSize: Number(row.byteSize),
      width: Number(row.width),
      height: Number(row.height),
      path: this.#absolute(row.storagePath),
    };
  }

  #absolute(storagePath: string): string {
    const absolute = resolve(this.#root, storagePath);
    const inside = absolute === this.#root || absolute.startsWith(`${this.#root}${sep}`);
    if (!inside) {
      throw new LocalAssetRejected('unsupported_type', 'Asset path escapes the media root');
    }
    return absolute;
  }

  async #sweepOrphanFiles(cutoff: string): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return 0;
    }
    for (const room of entries) {
      const roomDir = join(this.#root, room);
      let files: string[];
      try {
        const info = await stat(roomDir);
        if (!info.isDirectory()) {
          continue;
        }
        files = await readdir(roomDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(roomDir, file);
        if (this.#hasRow(relative(this.#root, path))) {
          continue;
        }
        try {
          const info = await stat(path);
          if (info.mtime.toISOString() >= cutoff) {
            continue;
          }
          await rm(path, { force: true });
          removed += 1;
        } catch {}
      }
    }
    return removed;
  }

  #hasRow(storagePath: string): boolean {
    const [row] = this.#orm
      .select({ id: playgroundAssets.id })
      .from(playgroundAssets)
      .where(eq(playgroundAssets.storagePath, storagePath))
      .all();
    return row !== undefined;
  }
}

export function isLocalImageMime(value: string): value is LocalImageMime {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}
