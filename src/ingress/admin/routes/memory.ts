import { MEMO_BLOB_ID_PATTERN } from '../../../context/memo-pad/index.ts';
import type { MemoBlobStore } from '../../../context/memo-pad/blobs.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { SECURITY_HEADERS, json, listQuery, readJsonObject } from '../http.ts';
import {
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryChats,
  parseCreateMemoryBody,
  parseMemoryId,
  parseUpdateMemoryBody,
  updateMemory,
} from '../memory.ts';

/** `detail` is capped at 32,768 characters; JSON escaping can exceed 8 KiB. */
const MEMORY_BODY_MAX_BYTES = 256 * 1024;

export interface MemoryAdminDeps {
  readonly store: BusinessStore;
  readonly memoBlobs: MemoBlobStore;
}

/** `/api/memories*`; `undefined` leaves a path that only shares the prefix alone. */
export function createMemoryAdminHandler(deps: MemoryAdminDeps) {
  const { store, memoBlobs } = deps;

  const blobContent = async (id: string): Promise<Response> => {
    if (!new RegExp(MEMO_BLOB_ID_PATTERN).test(id)) {
      throw new AdminQueryError('invalid_id', 'id must be a memo blob id', 400);
    }
    const blob = memoBlobs.getUnscoped(id);
    if (blob === undefined) {
      throw new AdminQueryError('not_found', 'Memo blob does not exist', 404);
    }
    let bytes: Uint8Array;
    try {
      bytes = await memoBlobs.content(blob);
    } catch {
      throw new AdminQueryError('not_found', 'Memo blob file is missing', 404);
    }
    return new Response(Uint8Array.from(bytes).buffer, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'content-type': blob.mime,
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store',
        'content-disposition': 'inline',
      },
    });
  };

  return {
    async handle(request: Request, url: URL, segments: readonly string[]): Promise<Response | undefined> {
      const route = segments.join('/');
      const query = listQuery(url);
      if (route === 'memories' && request.method === 'GET') {
        return json(listMemories(store.orm, query));
      }
      if (route === 'memories' && request.method === 'POST') {
        const body = parseCreateMemoryBody(await readJsonObject(request, MEMORY_BODY_MAX_BYTES));
        return json(createMemory(store.orm, body));
      }
      if (route === 'memories/chats' && request.method === 'GET') {
        return json({ items: listMemoryChats(store.orm) });
      }
      if (
        segments[0] === 'memories' &&
        segments.length === 4 &&
        segments[1] === 'blobs' &&
        segments[3] === 'content' &&
        request.method === 'GET'
      ) {
        return await blobContent(segments[2] ?? '');
      }
      if (segments[0] === 'memories' && segments.length === 2) {
        if (segments[1] === 'chats') {
          return json({ error: 'method_not_allowed', message: 'Memories chat options are read-only' }, 405);
        }
        const id = parseMemoryId(segments[1] ?? '');
        if (request.method === 'PUT') {
          const body = parseUpdateMemoryBody(await readJsonObject(request, MEMORY_BODY_MAX_BYTES));
          const result = updateMemory(store.orm, id, body);
          if (body.detail !== undefined && body.detail !== result.previousDetail) {
            await memoBlobs.cleanupAfterDetailChange(result.chatId, result.previousDetail).catch(() => undefined);
          }
          await memoBlobs.sweep(result.chatId).catch(() => undefined);
          return json(result.item);
        }
        if (request.method === 'DELETE') {
          const removed = deleteMemory(store.orm, id);
          await memoBlobs.cleanupAfterDetailChange(removed.chatId, removed.detail).catch(() => undefined);
          await memoBlobs.sweep(removed.chatId).catch(() => undefined);
          return json({ status: 'ok' });
        }
      }
      return undefined;
    },
  };
}
