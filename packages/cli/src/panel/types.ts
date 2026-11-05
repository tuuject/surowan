/**
 * The Admin Panel surface is shared with the MCP server. This module re-exports
 * the declarative table so existing CLI imports keep working; the source of
 * truth lives in `@surowan/admin-surface`.
 */
export type {
  AdminAccess,
  EndpointSpec,
  HttpMethod,
  PanelCommand,
  PositionalArg,
  ResponseKind,
  RevisionKind,
  ConfirmKind,
} from '@surowan/admin-surface';
