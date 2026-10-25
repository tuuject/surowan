import { DEFAULT_MEMORY_TTL_WARNING_DAYS } from '../../../context/memory.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { json, listQuery, readJsonObject } from '../http.ts';
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

export interface MemoryAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
}

/** `/api/memories*`; `undefined` leaves a path that only shares the prefix alone. */
export function createMemoryAdminHandler(deps: MemoryAdminDeps) {
  const { store, configStore } = deps;

  /** Read per request: the warning window is a hot agent field. */
  const memoryWarningDays = (): number =>
    configStore.current().config.agent.memory_ttl_warning_days ?? DEFAULT_MEMORY_TTL_WARNING_DAYS;

  return {
    async handle(request: Request, url: URL, segments: readonly string[]): Promise<Response | undefined> {
      const route = segments.join('/');
      const query = listQuery(url);
      if (route === 'memories' && request.method === 'GET') {
        return json(listMemories(store.orm, query, memoryWarningDays()));
      }
      if (route === 'memories' && request.method === 'POST') {
        const body = parseCreateMemoryBody(await readJsonObject(request));
        return json(createMemory(store.orm, body, memoryWarningDays()));
      }
      if (route === 'memories/chats' && request.method === 'GET') {
        return json({ items: listMemoryChats(store.orm) });
      }
      if (segments[0] === 'memories' && segments.length === 2) {
        if (segments[1] === 'chats') {
          return json({ error: 'method_not_allowed', message: 'Memories chat options are read-only' }, 405);
        }
        const id = parseMemoryId(segments[1] ?? '');
        if (request.method === 'PUT') {
          const body = parseUpdateMemoryBody(await readJsonObject(request));
          return json(updateMemory(store.orm, id, body, memoryWarningDays()));
        }
        if (request.method === 'DELETE') {
          deleteMemory(store.orm, id);
          return json({ status: 'ok' });
        }
      }
      return undefined;
    },
  };
}
