/**
 * The interface catalogs: one generated page per Admin API route group, plus
 * the reverse MCP tool table and the client CLI command table.
 *
 * The route rows come from `ADMIN_SURFACE_SPECS` and the tool rows from the MCP
 * server's own `TOOL_CATALOG`, so a route or tool added to the code appears here
 * on the next build. Only method, path, where the parameters travel, permission,
 * concurrency revision, confirmation and response kind are generated: request
 * bodies, enums and error codes stay in the hand-written pages of the same
 * directory, because the specs do not model them (each handler validates its
 * own body).
 *
 * The routes a panel session owns are not all in the specs: `/api/keychain*`
 * and the live streams are absent, `/api/auth/*` and `/api/api-keys*` are
 * refused to every programmatic credential, so they are listed from their route
 * implementations and labelled in the page text.
 */
export {
  CATALOG_PAGE_MAX_BYTES,
  CLI_CATALOG_PAGE,
  HTTP_CATALOG_PATHS,
  MCP_CATALOG_PAGE,
  type CatalogAssignment,
  type CatalogPageId,
  catalogAssignment,
} from './pages.ts';
export {
  CATALOG_HAND_WRITTEN,
  INTERFACE_CATALOG_PAGES,
  mcpCatalogRows,
  renderInterfaceCatalogPages,
} from './render.ts';
export { SESSION_ONLY_ROUTES, type SessionRoute } from './session-routes.ts';
