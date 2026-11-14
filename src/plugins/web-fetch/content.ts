import { Defuddle } from 'defuddle/node';
import { MAX_DOWNLOAD_BYTES } from '../../capabilities/media/image.ts';
import { LocalAssetRejected } from '../../capabilities/media/local-assets.ts';
import type { ToolImageReference } from '../../platform/tool-images.ts';
import { WebFetchError } from './shared.ts';
import { readBody } from './transport.ts';

const TITLE_MAX_CHARS = 300;
// Inline base64 pictures cannot be fetched and would eat the whole result budget.
const DATA_IMAGE = /!\[([^\]]*)\]\(data:[^)]*\)/g;
export const LINKED_IMAGE = /!\[[^\]]*\]\(https?:\/\//;

/**
 * The body must arrive whole: a truncated picture is a corrupt one. The bytes
 * are sniffed and normalized by the shared tool-image path, never trusted by
 * their declared type.
 */
export async function storeFetchedImage(
  response: Response,
  storeImage: (bytes: Uint8Array, signal: AbortSignal) => Promise<ToolImageReference>,
  signal: AbortSignal,
): Promise<ToolImageReference> {
  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declaredLength > MAX_DOWNLOAD_BYTES) {
    // Discarding is best effort: a body that already failed must not mask the refusal.
    await response.body?.cancel().catch(() => undefined);
    throw new WebFetchError('image_too_large', `Image exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB`);
  }
  const body = await readBody(response, MAX_DOWNLOAD_BYTES);
  if (body.truncated) {
    throw new WebFetchError('image_too_large', `Image exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB`);
  }
  try {
    return await storeImage(body.bytes, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LocalAssetRejected) {
      throw new WebFetchError(`image_${error.reason}`, error.message);
    }
    throw new WebFetchError(
      'image_processing_failed',
      `Image could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function htmlToMarkdown(html: string, url: string): Promise<{ title: string; markdown: string }> {
  let result: Awaited<ReturnType<typeof Defuddle>>;
  try {
    result = await Defuddle(html, url, {
      markdown: true,
      // Kept as absolute ![alt](url) links the model can fetch with this tool.
      removeImages: false,
      // Async extractors call third-party APIs (oEmbed, YouTube, Bilibili...) that
      // would bypass the address checks in address.ts; the fetch stub backs up the flag.
      useAsync: false,
      fetch: refuseFetch,
    });
  } catch {
    throw new WebFetchError('conversion_failed', 'Could not convert HTML to Markdown; retry with raw: true');
  }
  return {
    title: result.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS),
    markdown: result.content.replace(DATA_IMAGE, '![$1](inline data image omitted)'),
  };
}

function refuseFetch(): Promise<Response> {
  return Promise.reject(new WebFetchError('conversion_failed', 'HTML conversion may not make network requests'));
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
