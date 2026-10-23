import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import type { DirectImage } from '../../platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { media as mediaTable } from '../../store/schema.ts';
import type { BusinessStore, Orm } from '../../store/store.ts';
import type { LocalAssetResolver } from './media.ts';
import type { MediaDownloader } from './media-download.ts';
import { MAX_DOWNLOAD_BYTES, type NormalizedImage, prepareMediaImage } from './media-image.ts';

/** A stored row as `prepareMediaImage` wants it, plus the host columns the row may carry. */
export type RowImageSource = Parameters<typeof prepareMediaImage>[0] & {
  readonly hostKind?: string;
  readonly localAssetId?: string | null;
};

/**
 * What the image-input paths need from the service that owns them. Everything
 * here is the live service state; nothing is copied.
 */
export interface MediaImageInputDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly mediaClient: MediaDownloader;
  readonly localAssets: LocalAssetResolver | undefined;
}

/**
 * The one media row selection every reader shares: the vision path, the scene
 * path and the direct-image path must all see the same columns.
 */
export function selectMediaRow(orm: Orm, mediaId: bigint) {
  return orm
    .select({
      id: mediaTable.id,
      kind: mediaTable.kind,
      fileId: mediaTable.fileId,
      fileUniqueId: mediaTable.fileUniqueId,
      mimeType: mediaTable.mimeType,
      fileSize: mediaTable.fileSize,
      telegramJson: mediaTable.telegramJson,
      hostKind: mediaTable.hostKind,
      localAssetId: mediaTable.localAssetId,
    })
    .from(mediaTable)
    .where(eq(mediaTable.id, mediaId))
    .get();
}

/**
 * One private working directory under the media cache, locked to the owner like
 * the cache itself on every platform but Windows. The caller removes it.
 */
export async function createWorkDirectory(configStore: RuntimeConfigurationStore, prefix: string): Promise<string> {
  const mediaCache = configStore.current().config.paths.media_cache;
  await mkdir(mediaCache, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(mediaCache, prefix));
  if (process.platform !== 'win32') {
    await chmod(temporaryDirectory, 0o700);
  }
  return temporaryDirectory;
}

/**
 * Shared engine behind the generation and scene reads. `allowSticker` is the
 * only difference: generation never accepts a sticker, while a scene read
 * resolves one through the same normalization the vision path uses.
 */
export async function prepareImageBytes(
  deps: MediaImageInputDeps,
  mediaId: bigint,
  signal: AbortSignal,
  allowSticker: boolean,
): Promise<{ readonly base64: string; readonly mime: string }> {
  const media = selectMediaRow(deps.store.orm, mediaId);
  if (media === undefined || (media.kind === 'sticker' && !allowSticker)) {
    throw new Error(allowSticker ? 'Media is unavailable as scene input' : 'Media is unavailable as generation input');
  }
  if (media.fileSize !== null && media.fileSize > BigInt(MAX_DOWNLOAD_BYTES)) {
    throw new Error('Telegram media exceeds 20 MB');
  }
  const temporaryDirectory = await createWorkDirectory(deps.configStore, 'gen-input-');
  try {
    const normalized = await prepareRowImage(
      deps,
      media,
      join(temporaryDirectory, 'input'),
      temporaryDirectory,
      signal,
    );
    return {
      base64: Buffer.from(await readFile(normalized.path)).toString('base64'),
      mime: normalized.mimeType,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function loadDirectImages(
  deps: MediaImageInputDeps,
  images: readonly DirectImage[],
  signal: AbortSignal,
): Promise<ImageContent[]> {
  if (images.length === 0) {
    return [];
  }
  const temporaryDirectory = await createWorkDirectory(deps.configStore, 'direct-');
  try {
    const content: ImageContent[] = [];
    for (const [index, image] of images.entries()) {
      const media = selectMediaRow(deps.store.orm, image.mediaId);
      if (media === undefined || media.kind === 'sticker') {
        throw new Error('Direct image is unavailable');
      }
      if (media.fileSize !== null && media.fileSize > BigInt(MAX_DOWNLOAD_BYTES)) {
        throw new Error('Telegram media exceeds 20 MB');
      }
      const imageDirectory = join(temporaryDirectory, String(index));
      await mkdir(imageDirectory, { mode: 0o700 });
      const normalized = await prepareRowImage(deps, media, join(imageDirectory, 'input'), imageDirectory, signal);
      content.push({
        type: 'image',
        data: Buffer.from(await readFile(normalized.path)).toString('base64'),
        mimeType: normalized.mimeType,
      });
    }
    return content;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Prepare one media row for the model.
 *
 * A Playground row is read from its local asset and nothing else: there is no
 * Telegram file id to fall back to, and an unknown asset is an error rather
 * than a silent download. A Telegram row can never point at a local asset.
 */
export async function prepareRowImage(
  deps: MediaImageInputDeps,
  media: RowImageSource,
  inputPath: string,
  directory: string,
  signal: AbortSignal,
): Promise<NormalizedImage> {
  if (media.hostKind === 'playground') {
    if (media.kind === 'sticker') {
      throw new Error('A room asset cannot be a sticker');
    }
    const assetId = media.localAssetId ?? null;
    const asset = assetId === null ? null : (deps.localAssets?.resolve(assetId) ?? null);
    if (asset === null) {
      throw new Error('Room media is unavailable');
    }
    return prepareMediaImage(media, inputPath, directory, deps.mediaClient, signal, { path: asset.path });
  }
  if (media.localAssetId !== undefined && media.localAssetId !== null) {
    throw new Error('Telegram media cannot point at a local asset');
  }
  return prepareMediaImage(media, inputPath, directory, deps.mediaClient, signal);
}
