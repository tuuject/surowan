import type { ImConnectionRegistry } from '../../platform/im-connection.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import {
  WARNING_DEFINITIONS,
  type WarningCategory,
  type WarningDefinition,
  standingWarnings,
} from '../../platform/warning-catalog.ts';
import type { WarningService } from '../../store/warnings.ts';
import { AdminQueryError, parseId, parseLimit } from './audit/shared.ts';
import { json } from './http.ts';

const LIST_PARAMS = new Set(['limit', 'cursor', 'unread']);

export interface WarningsAdminDeps {
  readonly warnings: WarningService;
  readonly configStore: RuntimeConfigurationStore;
  /** Live per-IM state; standing warnings follow it on every read. */
  readonly connections: Pick<ImConnectionRegistry, 'get'>;
}

function categoryOf(code: string): WarningCategory {
  return (WARNING_DEFINITIONS as Record<string, WarningDefinition>)[code]?.category ?? 'runtime';
}

/**
 * Warnings are a read-mostly control surface: listing includes the standing
 * warnings derived from the active configuration, while only stored event
 * warnings can be marked read or cleared.
 */
export function createWarningsAdminHandler(deps: WarningsAdminDeps) {
  const { warnings, configStore, connections } = deps;

  const list = (url: URL): Response => {
    for (const key of url.searchParams.keys()) {
      if (!LIST_PARAMS.has(key)) {
        throw new AdminQueryError('invalid_query', 'Warnings listing accepts only limit, cursor and unread');
      }
    }
    const limit = parseLimit(url.searchParams.get('limit'));
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam === null || cursorParam.length === 0 ? undefined : parseId(cursorParam, 'cursor');
    const unreadParam = url.searchParams.get('unread');
    if (
      unreadParam !== null &&
      unreadParam !== '1' &&
      unreadParam !== 'true' &&
      unreadParam !== '0' &&
      unreadParam !== 'false'
    ) {
      throw new AdminQueryError('invalid_query', 'unread must be 1, true, 0 or false');
    }
    const page = warnings.list({
      limit,
      cursor,
      unreadOnly: unreadParam === '1' || unreadParam === 'true',
    });
    const now = new Date();
    return json({
      generated_at: now.toISOString(),
      standing: standingWarnings(configStore.current().config, connections, now),
      items: page.items.map((item) => ({
        id: item.id.toString(),
        kind: 'event',
        code: item.code,
        category: categoryOf(item.code),
        severity: item.severity,
        variables: item.variables,
        created_at: item.created_at,
        updated_at: item.updated_at,
        read_at: item.read_at,
      })),
      next_cursor: page.next_cursor,
      unread_count: warnings.unreadCount(),
    });
  };

  return {
    async handle(request: Request, url: URL, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] !== 'warnings') {
        return undefined;
      }
      if (segments.length === 1) {
        if (request.method === 'GET') {
          return list(url);
        }
        if (request.method === 'DELETE') {
          return json({ cleared: warnings.clear() });
        }
        return json({ error: 'method_not_allowed', message: 'Unsupported Warnings operation' }, 405);
      }
      if (segments.length === 3 && segments[2] === 'read') {
        if (request.method !== 'POST') {
          return json({ error: 'method_not_allowed', message: 'Unsupported Warnings operation' }, 405);
        }
        const item = warnings.markRead(parseId(segments[1] ?? '', 'id'));
        if (item === null) {
          throw new AdminQueryError('warning_not_found', 'Warning does not exist', 404);
        }
        return json({
          item: {
            id: item.id.toString(),
            kind: 'event',
            code: item.code,
            category: categoryOf(item.code),
            severity: item.severity,
            variables: item.variables,
            created_at: item.created_at,
            updated_at: item.updated_at,
            read_at: item.read_at,
          },
        });
      }
      throw new AdminQueryError('not_found', 'Unknown warnings route', 404);
    },
  };
}
