import type { BusinessStore } from '../../../store/store.ts';
import { json, listQuery, readJsonObject } from '../http.ts';
import {
  deleteGroupMemory,
  groupMemoryProgress,
  groupMemorySource,
  listGroupMemories,
  listGroupMemoryRuns,
  parseGroupMemoryId,
  parseUpdateGroupMemory,
  updateGroupMemory,
} from '../group-memory.ts';

export interface GroupMemoryAdminDeps {
  readonly store: BusinessStore;
}

/** `/api/group-memories*` — generated event summaries, not the Memo Pad. */
export function createGroupMemoryAdminHandler(deps: GroupMemoryAdminDeps) {
  const { store } = deps;

  return {
    async handle(request: Request, url: URL, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] !== 'group-memories') {
        return undefined;
      }
      if (segments.length === 1 && request.method === 'GET') {
        return json(listGroupMemories(store.orm, listQuery(url)));
      }
      if (segments.length === 2 && request.method === 'GET' && segments[1] === 'chats') {
        return json({ error: 'method_not_allowed', message: 'Group memory chat options reuse /memories/chats' }, 405);
      }
      if (segments.length === 2 && request.method === 'GET' && segments[1] === 'progress') {
        return json(groupMemoryProgress(store.orm));
      }
      if (segments.length === 2 && request.method === 'GET' && segments[1] === 'runs') {
        return json(listGroupMemoryRuns(store.orm, listQuery(url)));
      }
      if (segments.length === 3 && segments[2] === 'messages' && request.method === 'GET') {
        return json(groupMemorySource(store.orm, parseGroupMemoryId(segments[1] ?? '')));
      }
      if (segments.length === 2) {
        const id = parseGroupMemoryId(segments[1] ?? '');
        if (request.method === 'PUT') {
          return json(updateGroupMemory(store.orm, id, parseUpdateGroupMemory(await readJsonObject(request))));
        }
        if (request.method === 'DELETE') {
          deleteGroupMemory(store.orm, id);
          return json({ status: 'ok' });
        }
      }
      return undefined;
    },
  };
}
