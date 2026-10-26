import type { ConfigController } from '../../../platform/config/write.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import { CONFIG_WRITE_STATUS, readConfigFile } from '../config-file.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from '../http.ts';
import { parseSearchConfigBody, reusableSearchCredentials, searchConfigEdits, searchConfigView } from '../search.ts';

export interface SearchAdminRoutesDeps {
  /** Absent when the process has no reloadable configuration (tests, panels). */
  readonly configReloader?: ConfigController | undefined;
  readonly secrets?: SecretStore | undefined;
  /** Providers registered by the loaded plugins; the panel never invents one. */
  readonly searchProviders: readonly SearchProviderRule[];
}

/** A form with up to 32 engines, each with a note and an endpoint. */
const SEARCH_BODY_MAX_BYTES = 64 * 1024;

/**
 * `/api/search/config` — the web-search settings page's read and write surface.
 *
 * The write is an ordinary panel configuration write: an `If-Match` revision,
 * the same file-and-apply path as every other editor, and new credentials only
 * as key-jar entries. `writeConfigEdits` drops jar entries the new file no
 * longer references, so disabling or removing an engine recycles its key.
 */
export function createSearchAdminRoutes(deps: SearchAdminRoutesDeps) {
  const searchConfigViewOf = async (reloader: ConfigController): Promise<Response> => {
    const { loaded, revision } = await readConfigFile(reloader, deps.secrets);
    return json(searchConfigView(loaded.fileConfig, loaded.config, revision, deps.searchProviders));
  };

  return {
    async handle(request: Request, _url: URL, segments: readonly string[]): Promise<Response | undefined> {
      if (segments[0] !== 'search') {
        return undefined;
      }
      if (segments.join('/') !== 'search/config') {
        return json({ error: 'not_found', message: 'Unknown search route' }, 404);
      }
      const reloader = deps.configReloader;
      if (reloader === undefined) {
        return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
      }
      if (request.method === 'GET') {
        return await searchConfigViewOf(reloader);
      }
      if (request.method !== 'PUT') {
        return json({ error: 'method_not_allowed', message: 'Use GET or PUT for search settings' }, 405);
      }
      const revision = requiredRevision(request);
      if (revision === null) {
        return revisionRequired();
      }
      if (revision !== (await reloader.revision())) {
        return json({ error: 'config_conflict', message: '配置已变化，请重新加载后保存' }, 409);
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(request, SEARCH_BODY_MAX_BYTES);
      } catch (error) {
        return json({ error: 'invalid_body', message: errorMessage(error) }, 400);
      }
      const persisted = await reloader.readPersisted();
      const parsed = parseSearchConfigBody(
        body,
        persisted.fileConfig.web_search,
        deps.searchProviders,
        reusableSearchCredentials(persisted.fileConfig),
      );
      for (const plaintext of Object.values(parsed.keys)) {
        deps.secrets?.remember(plaintext);
      }
      const result = await reloader.writeAndApply(searchConfigEdits(parsed), revision);
      if (!result.ok) {
        const message = result.fileWritten
          ? `config.jsonc was updated but not applied: ${result.message}`
          : result.message;
        return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
      }
      const next = await reloader.readPersisted();
      return json({
        ...searchConfigView(next.fileConfig, next.config, await reloader.revision(), deps.searchProviders),
        apply: { applied: result.applied, restart_required: result.restartRequired },
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
