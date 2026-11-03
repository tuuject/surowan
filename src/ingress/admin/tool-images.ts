import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { localImageAssets } from '../../capabilities/media/local-assets.ts';
import { parseStoredToolContent, toolImageReferences } from '../../platform/tool-images.ts';
import type { Orm } from '../../store/store.ts';
import { AdminQueryError, parseId } from './audit/shared.ts';
import { SECURITY_HEADERS } from './http.ts';

export type ToolContentView =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; asset_id: string; width: number; height: number };

export function toolContentView(json: string | null, baseUrl: string): ToolContentView[] | null {
  const stored = parseStoredToolContent(json);
  if (stored === null) {
    return null;
  }
  const images = new Map(toolImageReferences(stored.details).map((image) => [image.contentIndex, image]));
  return stored.content.map((block, index) => {
    const image = images.get(index);
    return image === undefined
      ? block
      : {
          type: 'image',
          asset_id: image.assetId,
          width: image.width,
          height: image.height,
          url: `${baseUrl}/${image.assetId}`,
        };
  });
}

/** Session-only image reads, reached after the Admin server's session check. */
export async function readToolImageRoute(
  orm: Orm,
  dataDir: string,
  url: URL,
  segments: readonly string[],
): Promise<Response | undefined> {
  if (segments.length !== 6 || segments[4] !== 'images') {
    return undefined;
  }
  let row: { chat_id: bigint; result_json: string | null } | undefined;
  if (segments[0] === 'invocations' && segments[2] === 'tools') {
    let callId: string;
    try {
      callId = decodeURIComponent(segments[3] ?? '');
    } catch {
      throw new AdminQueryError('invalid_id', 'Invalid tool call id', 400);
    }
    row = orm.get(sql`SELECT c.chat_id, tc.result_content_json AS result_json
      FROM tool_calls tc JOIN invocations i ON i.id = tc.invocation_id
      JOIN conversations c ON c.id = i.conversation_id
      WHERE i.id = ${parseId(segments[1] ?? '', 'invocation_id')} AND tc.tool_call_id = ${callId}`);
  } else if (segments[0] === 'contexts' && segments[2] === 'messages') {
    row = orm.get(sql`SELECT c.chat_id, cm.payload_json AS result_json
      FROM context_messages cm JOIN conversation_contexts cc ON cc.id = cm.context_id
      JOIN conversations c ON c.id = cc.conversation_id
      WHERE c.id = ${parseId(segments[1] ?? '', 'conversation_id')} AND cm.seq = ${parseId(segments[3] ?? '', 'seq')}
        AND cm.role = 'toolResult'`);
  } else {
    return undefined;
  }
  if (url.searchParams.size > 0) {
    throw new AdminQueryError('invalid_query', 'Tool images take no query parameters', 400);
  }
  const stored = parseStoredToolContent(row?.result_json ?? null);
  const reference =
    stored === null ? undefined : toolImageReferences(stored.details).find((image) => image.assetId === segments[5]);
  const assets = localImageAssets(orm, dataDir);
  const asset = row === undefined || reference === undefined ? null : assets.assetFor(row.chat_id, reference.assetId);
  if (
    asset === null ||
    reference === undefined ||
    asset.byteSize !== reference.byteSize ||
    asset.mime !== reference.mimeType
  ) {
    throw new AdminQueryError('not_found', 'Tool image does not belong to this result', 404);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(asset.path);
  } catch {
    throw new AdminQueryError('not_found', 'Tool image is unavailable', 404);
  }
  if (bytes.byteLength !== asset.byteSize) {
    throw new AdminQueryError('not_found', 'Tool image is unavailable', 404);
  }
  return new Response(Uint8Array.from(bytes).buffer, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': asset.mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
    },
  });
}
