import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { MAX_DOWNLOAD_BYTES } from './image.ts';
import { createWorkDirectory, type MediaImageInputDeps, selectMediaRow } from './image-input.ts';

const NamedDocument = Compile(Type.Object({ file_name: Type.String({ minLength: 1, maxLength: 255 }) }));

/**
 * One stored picture exactly as its host keeps it, for a send that delivers it
 * as a file. Unlike the image-input paths nothing is normalized: re-encoding
 * would defeat the point of sending the file. Stickers are not pictures a
 * user saves, so they are refused.
 */
export async function readOriginalFile(
  deps: MediaImageInputDeps,
  mediaId: bigint,
  signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly fileName: string; readonly mime: string }> {
  const media = selectMediaRow(deps.store.orm, mediaId);
  if (media === undefined || media.kind === 'sticker') {
    throw new Error('Media is unavailable as a file');
  }
  if (media.fileSize !== null && media.fileSize > BigInt(MAX_DOWNLOAD_BYTES)) {
    throw new Error('Telegram media exceeds 20 MB');
  }
  const mime = media.mimeType ?? 'image/jpeg';
  const fileName = documentName(media.telegramJson) ?? `${media.kind}-${media.id.toString()}`;
  if (media.hostKind === 'playground') {
    const asset = media.localAssetId === null ? null : (deps.localAssets?.resolve(media.localAssetId) ?? null);
    if (asset === null) {
      throw new Error('Room media is unavailable');
    }
    return { bytes: await readFile(asset.path), fileName, mime };
  }
  const directory = await createWorkDirectory(deps.configStore, 'file-');
  try {
    const path = join(directory, 'original');
    await deps.mediaClient.download(media.fileId, path, signal);
    return { bytes: await readFile(path), fileName, mime };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The name a user gave a picture they sent as a file, when Telegram kept one. */
function documentName(telegramJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(telegramJson);
  } catch {
    return undefined;
  }
  return NamedDocument.Check(parsed) ? parsed.file_name : undefined;
}
