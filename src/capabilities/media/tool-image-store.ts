import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolImageReference } from '../../platform/tool-images.ts';
import { MAX_DOWNLOAD_BYTES, normalizeImage } from './image.ts';
import { LocalAssetRejected, type PlaygroundAssetStore, sniffImageMime } from './local-assets.ts';

/**
 * Turns raw picture bytes a tool obtained into a stored tool image.
 *
 * Every tool that hands pixels to the model goes through this one path, so the
 * rules cannot drift: the bytes are sniffed (never trusted by name), normalized
 * with sharp under the same pixel and byte ceilings as any other media, stored
 * as a Chat-owned local asset, and referenced by an opaque id. `declaredMime`
 * is for transports that do state a type (MCP image blocks); without it the
 * content decides.
 */
export async function ingestToolImage(
  assets: PlaygroundAssetStore,
  chatId: bigint,
  bytes: Uint8Array,
  signal: AbortSignal,
  options: { readonly declaredMime?: string } = {},
): Promise<ToolImageReference> {
  if (options.declaredMime === undefined) {
    if (sniffImageMime(bytes) === null) {
      throw new LocalAssetRejected('unsupported_type', 'Tool image is not a JPEG, PNG or WebP image');
    }
  } else {
    await assets.validate({ bytes, declaredMime: options.declaredMime });
  }
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new LocalAssetRejected('too_large', 'Tool image exceeds the media byte limit');
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'surowan-tool-image-'));
  try {
    const input = join(directory, 'input');
    await writeFile(input, bytes, { mode: 0o600, signal });
    const normalized = await normalizeImage(input, directory, signal);
    const normalizedBytes = await readFile(normalized.path, { signal });
    signal.throwIfAborted();
    const asset = await assets.ingest(chatId, { bytes: normalizedBytes, declaredMime: normalized.mimeType });
    signal.throwIfAborted();
    return {
      contentIndex: 0,
      assetId: asset.id,
      mimeType: asset.mime,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
