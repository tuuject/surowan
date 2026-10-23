import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import { MAX_BODY_BYTES, json, readJsonObject } from './admin-http.ts';
import type { createPlaygroundAdminHandler } from './playground-admin.ts';

export type PlaygroundAdminHandler = ReturnType<typeof createPlaygroundAdminHandler>;

export interface PlaygroundRoutesDeps {
  /** The room surface; absent when the host runs without playground rooms. */
  readonly playground: PlaygroundAdminHandler | undefined;
  readonly scheduler: BucketScheduler | undefined;
}

/** `/api/playground*` — rooms, releases and staged assets. */
export function createPlaygroundAdminRoutes(deps: PlaygroundRoutesDeps) {
  const { playground, scheduler } = deps;

  return {
    async handle(
      request: Request,
      url: URL,
      segments: readonly string[],
      username: string,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'playground') {
        return undefined;
      }
      if (playground === undefined) {
        return json({ error: 'playground_unavailable', message: 'Playground rooms are not wired' }, 503);
      }
      const response = await playground(
        request,
        segments.slice(1),
        url,
        { username, wake: () => scheduler?.wake() },
        (maxBytes) => readJsonObject(request, maxBytes ?? MAX_BODY_BYTES),
      );
      if (response.kind === 'content') {
        return new Response(new Uint8Array(response.bytes), {
          status: response.status,
          headers: { 'content-type': response.mime, 'cache-control': 'private, no-store' },
        });
      }
      return json(response.body, response.status);
    },
  };
}
