import { Defuddle } from 'defuddle/node';
import { MAX_DOWNLOAD_BYTES } from '../../capabilities/media/image.ts';
import { LocalAssetRejected } from '../../capabilities/media/local-assets.ts';
import type { ToolImageReference } from '../../platform/tool-images.ts';
import { WebFetchError } from './shared.ts';
import { parseUrl, readBody } from './transport.ts';

const TITLE_MAX_CHARS = 300;
const DESCRIPTION_MAX_CHARS = 1_000;
const FIELD_MAX_CHARS = 200;
// The web_fetch url input limit: a longer link could not be fetched anyway.
const URL_MAX_CHARS = 2_048;
// JSON-LD often repeats the whole article; the Markdown body keeps the result budget.
const SCHEMA_ORG_MAX_BYTES = 4_096;
const SCHEMA_ORG_TRUNCATION_MARKER = ' [truncated]';
// Page-controlled text must not open a line of its own and forge a header.
const LINE_BREAKING = /[\s\u0085]+/g;
// JSON.stringify leaves these raw, and they read as line breaks.
const JSON_LINE_BREAKING = /[\u0085\u2028\u2029]/g;
// Inline base64 pictures cannot be fetched and would eat the whole result budget.
const DATA_IMAGE = /!\[([^\]]*)\]\(data:[^)]*\)/g;
// A whole link: truncation may leave only the start of one.
export const LINKED_IMAGE = /!\[[^\]]*\]\(https?:\/\/[^)]+\)/;

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

export interface ConvertedPage {
  readonly markdown: string;
  /** Metadata Defuddle reads or infers from the page, as `Label: value` header lines; empty fields are left out. */
  readonly metadataLines: readonly string[];
  /** The page's preview picture (og:image and the like) as a link web_fetch accepts. */
  readonly previewImage: string | undefined;
}

export async function htmlToMarkdown(html: string, url: string): Promise<ConvertedPage> {
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
  const previewImage = fetchableUrl(result.image, url);
  // Every field of Defuddle's metadata except parseTime: that is our own parse
  // time, not page metadata, and would make identical fetches read differently.
  const fields: readonly (readonly [label: string, value: string])[] = [
    ['Title', oneLine(result.title, TITLE_MAX_CHARS)],
    ['Description', oneLine(result.description, DESCRIPTION_MAX_CHARS)],
    ['Author', oneLine(result.author, FIELD_MAX_CHARS)],
    ['Published', oneLine(result.published, FIELD_MAX_CHARS)],
    ['Site', oneLine(result.site, FIELD_MAX_CHARS)],
    ['Domain', oneLine(result.domain, FIELD_MAX_CHARS)],
    ['Language', oneLine(result.language, FIELD_MAX_CHARS)],
    ['Word count', Number.isSafeInteger(result.wordCount) ? String(result.wordCount) : ''],
    ['Preview image', previewImage ?? ''],
    ['Favicon', fetchableUrl(result.favicon, url) ?? ''],
    ['Schema.org', schemaOrgJson(result.schemaOrgData)],
  ];
  return {
    markdown: result.content.replace(DATA_IMAGE, '![$1](inline data image omitted)'),
    metadataLines: fields.filter(([, value]) => value.length > 0).map(([label, value]) => `${label}: ${value}`),
    previewImage,
  };
}

function oneLine(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const cut = value.replace(LINE_BREAKING, ' ').trim().slice(0, maxChars);
  // A cut between the halves of a surrogate pair leaves half a character, which UTF-8 turns into U+FFFD.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Metadata links are often relative, and Defuddle passes them through as written.
 * Only links the model could hand straight back to web_fetch are kept.
 */
function fetchableUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.trim(), base);
    url.hash = '';
    const href = parseUrl(url.href).href;
    return href.length <= URL_MAX_CHARS ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Defuddle's schemaOrgData: one entry per JSON-LD block, empty blocks included. */
function schemaOrgJson(value: unknown): string {
  const blocks = (Array.isArray(value) ? value : [value]).filter((block) => !isEmptyBlock(block));
  if (blocks.length === 0) {
    return '';
  }
  let json: string;
  try {
    json = JSON.stringify(blocks);
  } catch {
    // Nesting too deep to serialize: the page gets no Schema.org line rather than a failed fetch.
    return '';
  }
  const escaped = json.replace(JSON_LINE_BREAKING, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const cut = truncateUtf8(escaped, SCHEMA_ORG_MAX_BYTES);
  return cut.truncated ? `${cut.text}${SCHEMA_ORG_TRUNCATION_MARKER}` : cut.text;
}

function isEmptyBlock(block: unknown): boolean {
  if (block === null || block === undefined || block === '') {
    return true;
  }
  return typeof block === 'object' && Object.keys(block).length === 0;
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
