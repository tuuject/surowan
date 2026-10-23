/**
 * Process-wide mutable state of the E2E backend process.
 *
 * The concerns of `e2e/server.ts` live in sibling modules (relay fixture, rooms,
 * hooks, config, fixtures, lifecycle); they all reach the few handles boot
 * publishes here instead of importing each other's globals, which keeps the
 * module graph acyclic and the boot order in one readable place.
 */
import type { ServerType } from '@hono/node-server';
import type { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import type { AdminServer } from '../../../src/ingress/admin/server.ts';

export const state: {
  store: SqliteStore | null;
  /** The listener serving the API, the SPA and `/__e2e/**`. */
  server: ServerType | null;
  /** The loopback upstream the config's providers point at. */
  upstream: ServerType | null;
  admin: AdminServer | null;
  /** Temp directory holding the config, key jar and SQLite file; removed on shutdown. */
  directory: string;
  shuttingDown: boolean;
  /** Set by the hook that makes the next config apply fail. */
  failNextConfigApply: boolean;
} = {
  store: null,
  server: null,
  upstream: null,
  admin: null,
  directory: '',
  shuttingDown: false,
  failNextConfigApply: false,
};
