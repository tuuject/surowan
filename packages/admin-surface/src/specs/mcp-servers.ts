import type { EndpointSpec } from '../types.ts';

/**
 * The outbound MCP servers page: the servers the bot itself connects to
 * (`mcp.servers[]`), as distinct from the reverse `/mcp` endpoint this surface
 * also feeds. Creating is HTTP-only (stdio argv belongs in `config.jsonc`), an
 * edit never moves a stdio connection, and a delete is refused while a Chat
 * explicitly binds the alias.
 */
export const MCP_SERVER_SPECS: readonly EndpointSpec[] = [
  {
    command: 'mcp-server list',
    method: 'GET',
    path: 'mcp-servers',
    summary: 'Show configured MCP servers with live state, advertised tools and per-Chat usage',
  },
  {
    command: 'mcp-server create',
    method: 'POST',
    path: 'mcp-servers',
    body: true,
    revision: 'config',
    summary:
      'Add a streamable HTTP MCP server (alias, url, headers, tool selection, limits and policies); stdio servers must be added in config.jsonc',
  },
  {
    command: 'mcp-server update',
    method: 'PUT',
    path: 'mcp-servers/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    body: true,
    revision: 'config',
    summary:
      'Edit one server: url and headers for HTTP, only tool selection, limits and policies for stdio; the alias cannot change',
  },
  {
    command: 'mcp-server delete',
    method: 'DELETE',
    path: 'mcp-servers/:alias',
    positional: [{ name: 'alias', kind: 'text' }],
    revision: 'config',
    confirm: 'destructive',
    summary: 'Remove an MCP server; refused with mcp_server_in_use while a Chat still binds it',
  },
];
