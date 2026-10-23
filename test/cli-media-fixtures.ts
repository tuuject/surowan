import { Buffer } from 'node:buffer';
import { rm } from 'node:fs/promises';
import { binaryResponse, jsonResponse, requestPath, requestQuery, startServer } from './cli-harness.ts';

export const API_KEY = 'test-api-key-media';
export const ENV = (baseUrl: string) => ({ SUROWAN_ENDPOINT: baseUrl, SUROWAN_API_KEY: API_KEY });
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
export const PDF_BYTES = Buffer.from('%PDF-1.4 test document');

export interface ItemOverrides {
  readonly kind?: string;
  readonly mime_type?: string | null;
  readonly file_size?: number | null;
  readonly variants?: readonly string[];
  readonly [key: string]: unknown;
}

export function mediaItem(id: string, overrides: ItemOverrides = {}) {
  return {
    id,
    message_id: `msg-${id}`,
    revision_id: `rev-${id}`,
    kind: 'photo',
    mime_type: 'image/jpeg',
    file_size: null,
    variants: ['original', 'preview'],
    ...overrides,
  };
}

export interface ContentEntry {
  readonly body: Buffer | string;
  readonly contentType?: string;
  readonly variant?: string | null;
}

/** Routes the media list plus each `/media/<id>/content` download. */
export function mediaServer(
  invocationId: string,
  items: readonly unknown[],
  entries: ReadonlyMap<string, ContentEntry>,
) {
  const contentPattern = new RegExp(`^/api/invocations/${invocationId}/media/(\\d+)/content$`);
  return startServer((request, response) => {
    const path = requestPath(request);
    if (path === `/api/invocations/${invocationId}/media`) {
      jsonResponse(response, 200, { invocation_id: invocationId, items });
      return;
    }
    const match = contentPattern.exec(path);
    const entry = match?.[1] !== undefined ? entries.get(match[1]) : undefined;
    if (entry === undefined) {
      // Echo the key like a sloppy proxy would, to prove manifest redaction.
      jsonResponse(response, 404, { error: 'media_missing', message: `no such media (key ${API_KEY})` });
      return;
    }
    const headers: Record<string, string> = {};
    if (entry.contentType !== undefined) {
      headers['content-type'] = entry.contentType;
    }
    if (entry.variant !== null) {
      headers['x-plasticwan-media-variant'] = entry.variant ?? requestQuery(request).variant ?? 'original';
    }
    binaryResponse(response, 200, entry.body, headers);
  });
}

export interface MediaManifest {
  readonly invocation_id: string;
  readonly variant: string;
  readonly directory: string;
  readonly items: readonly {
    readonly id: string;
    readonly status: string;
    readonly path: string | null;
    readonly mime_type: string | null;
    readonly bytes: number | null;
    readonly sha256: string | null;
    readonly error: { readonly code: string; readonly message: string } | null;
  }[];
}

export async function cleanup(manifest: MediaManifest | undefined): Promise<void> {
  if (manifest !== undefined) {
    await rm(manifest.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
