/**
 * `/api/mcp-servers` — the MCP servers page's read and write surface.
 *
 * The write is an ordinary panel configuration write: an `If-Match` revision,
 * the same file-and-apply path as every other editor, and new header secrets
 * only as keychain entries. Live state and advertised tools come from the
 * process's `McpManager` when one runs; a standalone panel reports neither.
 */
import type { McpServerToolListing } from '../../../capabilities/mcp/support.ts';
import type { ConfigApplyResult, ConfigController, SecretWrite } from '../../../platform/config/write.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import type { McpServerAvailability } from '../../../platform/warning-catalog.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from '../http.ts';
import { mcpServersView } from '../mcp-servers/read.ts';
import { createMcpServer, deleteMcpServer, updateMcpServer } from '../mcp-servers/write.ts';
import type { CallerClass } from '../secret-input.ts';

export interface McpServersAdminDeps {
  /** Absent when the process has no reloadable configuration (tests, panels). */
  readonly configReloader?: ConfigController | undefined;
  readonly secrets?: SecretStore | undefined;
  /** Live per-alias availability; absent outside `serve`, where no MCP runs. */
  readonly mcpServerStates?: (() => readonly McpServerAvailability[]) | undefined;
  /** Advertised tools per alias; absent alongside the states. */
  readonly mcpServerTools?: (() => readonly McpServerToolListing[]) | undefined;
  /** The deployment's registered search providers, for candidate validation. */
  readonly searchProviders: readonly SearchProviderRule[];
}

/** Policies for a server's whole tool list plus its headers stay well under this. */
const MCP_BODY_MAX_BYTES = 32 * 1024;

export function createMcpServersAdminRoutes(deps: McpServersAdminDeps) {
  // Panel sessions see secret origins and the verbatim URLs the edit form
  // needs; programmatic callers get neither — query values may be API keys.
  const view = async (caller: CallerClass) => {
    const reloader = deps.configReloader;
    if (reloader === undefined) {
      throw new AdminQueryError('mcp_unavailable', 'MCP server management is not wired', 503);
    }
    const { loaded, revision } = await readConfigFile(reloader, deps.secrets);
    return mcpServersView(loaded.fileConfig, revision, {
      ...(deps.mcpServerStates === undefined ? {} : { serverStates: deps.mcpServerStates() }),
      ...(deps.mcpServerTools === undefined ? {} : { toolListings: deps.mcpServerTools() }),
      withSources: caller === 'session',
      redactUrls: caller === 'programmatic',
    });
  };

  const writeFailed = (result: Extract<ConfigApplyResult, { readonly ok: false }>): Response => {
    const message = result.fileWritten ? `config.jsonc was updated but not applied: ${result.message}` : result.message;
    return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
  };

  const applied = (result: Extract<ConfigApplyResult, { readonly ok: true }>) => ({
    applied: result.applied,
    restart_required: result.restartRequired,
    outside_serve: result.outsideServe,
  });

  return {
    async handle(
      request: Request,
      _url: URL,
      segments: readonly string[],
      caller: CallerClass,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'mcp-servers') {
        return undefined;
      }
      const reloader = deps.configReloader;
      if (reloader === undefined) {
        return json({ error: 'mcp_unavailable', message: 'MCP server management is not wired' }, 503);
      }
      const method = request.method;
      if (method === 'GET' && segments.length === 1) {
        return json(await view(caller));
      }
      const alias = segments[1] ?? '';
      const isCreate = method === 'POST' && segments.length === 1;
      const isUpdate = method === 'PUT' && segments.length === 2;
      const isDelete = method === 'DELETE' && segments.length === 2;
      if (!isCreate && !isUpdate && !isDelete) {
        return json(
          { error: 'method_not_allowed', message: 'Use GET or POST on the list, PUT or DELETE on one server' },
          405,
        );
      }
      const revision = requiredRevision(request);
      if (revision === null) {
        return revisionRequired();
      }
      if (isDelete) {
        // No body: the alias names the target and the revision pins it. The
        // double revision check inside `readConfigFile` means the delete runs
        // against exactly the file the caller described.
        const { loaded, revision: snapshotRevision } = await readConfigFile(reloader, deps.secrets);
        if (revision !== snapshotRevision) {
          return json(
            { error: 'config_conflict', message: 'The configuration file changed; reload before editing' },
            409,
          );
        }
        const result = await reloader.writeAndApply(deleteMcpServer(loaded.fileConfig, alias), revision);
        if (!result.ok) {
          return writeFailed(result);
        }
        return json({ ...(await view(caller)), apply: applied(result) });
      }
      if (revision !== (await reloader.revision())) {
        return json(
          { error: 'config_conflict', message: 'The configuration file changed; reload before editing' },
          409,
        );
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(request, MCP_BODY_MAX_BYTES);
      } catch (error) {
        return json({ error: 'invalid_body', message: errorMessage(error) }, 400);
      }
      // The snapshot the edits are parsed from must be the one the caller's
      // revision describes: another writer committing while the body streamed
      // in would otherwise turn a stale no-op into a silent 200.
      const { loaded, revision: snapshotRevision } = await readConfigFile(reloader, deps.secrets);
      if (revision !== snapshotRevision) {
        return json(
          { error: 'config_conflict', message: 'The configuration file changed; reload before editing' },
          409,
        );
      }
      const snapshot = await reloader.keychainSnapshot();
      const keychain = {
        entries: new Set(snapshot.entries.map((entry) => entry.name)),
        usage: snapshot.usage.file ?? {},
      };
      const parsed = isCreate
        ? createMcpServer(loaded.fileConfig, body, caller, keychain, deps.searchProviders)
        : updateMcpServer(loaded.fileConfig, alias, body, caller, keychain, deps.searchProviders);
      for (const plaintext of Object.values(parsed.keys)) {
        deps.secrets?.remember(plaintext);
      }
      const secretsWrite: SecretWrite = {
        ...(Object.keys(parsed.repairs).length > 0 ? { add: parsed.repairs } : {}),
        ...(parsed.replacements.length > 0 ? { replace: parsed.replacements } : {}),
      };
      const hasSecrets = Object.keys(parsed.repairs).length > 0 || parsed.replacements.length > 0;
      // A no-change edit writes nothing; a keychain-only change still applies.
      if (parsed.edits.length === 0 && !hasSecrets) {
        return json({
          ...(await view(caller)),
          apply: { applied: [], restart_required: reloader.status().restartRequired, outside_serve: [] },
        });
      }
      const result = await reloader.writeSecretsAndApply(parsed.edits, secretsWrite, revision);
      if (!result.ok) {
        return writeFailed(result);
      }
      return json({ ...(await view(caller)), apply: applied(result) });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
