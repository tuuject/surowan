import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { ConfigController, ConfigEdit, PersistedConfig } from '../../../platform/config/write.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { CONFIG_WRITE_STATUS } from '../config-file.ts';
import { decodeSegments, json, readJsonObject, redact, requiredRevision, revisionRequired } from '../http.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { checkModelHealth, parseHealthCheckBody } from '../model-health.ts';
import { discover, lookupMetadata } from '../providers/discover.ts';
import { listProviders } from '../providers/read.ts';
import {
  appendModels,
  createProvider,
  deleteModel,
  deleteProvider,
  replaceModel,
  thinkingLevelEdits,
  updateProvider,
  visionEdits,
} from '../providers/write.ts';
import {
  PROVIDER_BODY_MAX_BYTES,
  type ProviderWriteContext,
  type ProvidersView,
  parseAlias,
  parseCreateProviderBody,
  parseDiscoverBody,
  parseLookupMetadataBody,
  parseModelBody,
  parseModelsBody,
  parseThinkingLevelBody,
  parseUpdateProviderBody,
  parseVisionBody,
} from '../providers/index.ts';

export interface ProvidersAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
  /** Aborted when admin stops; joins every health check's own request signal. */
  readonly healthSignal: AbortSignal;
  /** Live in-flight health checks; `stop()` awaits this same set. */
  readonly healthChecks: Set<Promise<unknown>>;
}

/**
 * `/api/providers*` plus the two single-field configuration switches that ride
 * on the same write path (`/api/vision`, `/api/thinking-level`).
 */
export function createProvidersAdminHandler(deps: ProvidersAdminDeps) {
  const { store, configStore, configReloader, secrets, healthSignal, healthChecks } = deps;

  /**
   * A write endpoint: the file is read for the prechecks, the edits are applied
   * inside the reloader's lock, and the response carries both the apply summary
   * and the refreshed view so the panel needs no second round trip.
   */
  const providerWrite = async (
    request: Request,
    build: (context: ProviderWriteContext) => Promise<ConfigEdit[]> | ConfigEdit[],
  ): Promise<Response> => {
    if (configReloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const revision = requiredRevision(request);
    if (revision === null) {
      return revisionRequired();
    }
    let context: ProviderWriteContext;
    try {
      context = await providerContext(configReloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: redact(secrets, error) }, 422);
    }
    let edits: readonly ConfigEdit[];
    try {
      edits = await build(context);
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      return json({ error: 'provider_write_failed', message: redact(secrets, error) }, 500);
    }
    const result = await configReloader.writeAndApply(edits, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return json({ error: result.code, message }, CONFIG_WRITE_STATUS[result.code] ?? 409);
    }
    return json({
      ...(await providersView(configReloader)),
      apply: { applied: result.applied, restart_required: result.restartRequired, outside_serve: result.outsideServe },
    });
  };

  /** A read-shaped POST: provider discovery and metadata lookup write nothing. */
  const providerResponse = async (build: (context: ProviderWriteContext) => Promise<unknown>): Promise<Response> => {
    if (configReloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    let context: ProviderWriteContext;
    try {
      context = await providerContext(configReloader);
    } catch (error) {
      return json({ error: 'config_invalid', message: redact(secrets, error) }, 422);
    }
    try {
      return json(await build(context));
    } catch (error) {
      if (error instanceof AdminQueryError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      // Upstream failures echo the request, key included.
      return json({ error: 'provider_discovery_failed', message: redact(secrets, error) }, 502);
    }
  };

  const providerContext = async (reloader: ConfigController): Promise<ProviderWriteContext> => {
    if (secrets === undefined) {
      throw new Error('Provider management is not wired');
    }
    const loaded = await reloader.readPersisted();
    return { file: loaded.fileConfig, secrets, snapshot: configStore.current() };
  };

  /**
   * The panel reads the file, not the active configuration: a pending restart
   * must be visible as what is on disk, and the revision is the file's own.
   */
  const providersView = async (reloader: ConfigController): Promise<ProvidersView> => {
    let loaded: PersistedConfig;
    try {
      loaded = await reloader.readPersisted();
    } catch (error) {
      throw new AdminQueryError('config_invalid', redact(secrets, error), 422);
    }
    const revision = await reloader.revision();
    return listProviders(loaded.fileConfig, revision, reloader.status().restartRequired);
  };

  /**
   * `/api/providers` — the model manager's read and write surface.
   *
   * Model ids may contain `/`, so the path is split on `/` first and each segment
   * is decoded afterwards: `PUT /providers/:alias/models/:id` only matches when
   * the client encoded the id.
   */
  const providers = async (request: Request, segments: readonly string[]): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined || secrets === undefined) {
      return json({ error: 'providers_unavailable', message: 'Provider management is not wired' }, 503);
    }
    const parts = decodeSegments(segments);
    if (parts === null) {
      return json({ error: 'invalid_path', message: 'Path segments must be valid percent-encoded UTF-8' }, 400);
    }
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    if (parts.length === 2 && second === 'health-check' && request.method !== 'PUT' && request.method !== 'DELETE') {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed', message: 'Use POST to check model health' }, 405);
      }
      const body = parseHealthCheckBody(await readJsonObject(request));
      let context: ProviderWriteContext;
      try {
        context = await providerContext(reloader);
      } catch (error) {
        return json({ error: 'config_invalid', message: redact(secrets, error) }, 422);
      }
      if (healthSignal.aborted) {
        return json({ error: 'server_stopping', message: 'Admin server is stopping' }, 503);
      }
      if (healthChecks.size >= 3) {
        return json({ error: 'health_check_busy', message: 'Three model health checks are already running' }, 429);
      }
      const check = checkModelHealth(store, context, body, AbortSignal.any([request.signal, healthSignal]));
      healthChecks.add(check);
      try {
        return json(await check);
      } finally {
        healthChecks.delete(check);
      }
    }
    // Checked before the body is parsed, so a missing revision is reported as
    // such even when the payload is malformed too. Discovery and metadata lookup
    // write nothing and therefore need no revision.
    const readShapedPost = parts.length === 2 && (second === 'discover' || second === 'lookup-metadata');
    if (request.method !== 'GET' && !readShapedPost && requiredRevision(request) === null) {
      return revisionRequired();
    }
    if (parts.length === 1 && request.method === 'GET') {
      return json(await providersView(reloader));
    }
    if (parts.length === 1 && request.method === 'POST') {
      const body = parseCreateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await providerWrite(request, (context) => createProvider(context, body));
    }
    if (parts.length === 2 && second === 'discover' && request.method === 'POST') {
      const body = parseDiscoverBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await providerResponse((context) => discover(context, body));
    }
    if (parts.length === 2 && second === 'lookup-metadata' && request.method === 'POST') {
      const body = parseLookupMetadataBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await providerResponse((context) => lookupMetadata(body, context.secrets));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'PUT') {
      const alias = parseAlias(second);
      const body = parseUpdateProviderBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await providerWrite(request, (context) => updateProvider(context, alias, body));
    }
    if (parts.length === 2 && second !== undefined && request.method === 'DELETE') {
      const alias = parseAlias(second);
      return await providerWrite(request, (context) => deleteProvider(context, alias));
    }
    if (parts.length === 3 && second !== undefined && third === 'models' && request.method === 'POST') {
      const alias = parseAlias(second);
      const models = parseModelsBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
      return await providerWrite(request, (context) => appendModels(context, alias, models));
    }
    if (parts.length === 4 && second !== undefined && third === 'models' && fourth !== undefined) {
      const alias = parseAlias(second);
      if (request.method === 'PUT') {
        const model = parseModelBody(await readJsonObject(request, PROVIDER_BODY_MAX_BYTES));
        return await providerWrite(request, (context) => replaceModel(context, alias, fourth, model));
      }
      if (request.method === 'DELETE') {
        return await providerWrite(request, (context) => deleteModel(context, alias, fourth));
      }
    }
    return json({ error: 'not_found', message: 'Unknown providers route' }, 404);
  };

  /** `/api/providers*`, `/api/vision` and `/api/thinking-level`; `undefined` leaves the path alone. */
  const handle = async (request: Request, segments: readonly string[]): Promise<Response | undefined> => {
    if (segments[0] === 'providers') {
      return await providers(request, segments);
    }
    const route = segments.join('/');
    if (route === 'vision' && request.method === 'PUT') {
      const body = parseVisionBody(await readJsonObject(request));
      return await providerWrite(request, (context) => visionEdits(context, body));
    }
    if (route === 'thinking-level' && request.method === 'PUT') {
      const body = parseThinkingLevelBody(await readJsonObject(request));
      return await providerWrite(request, (context) => thinkingLevelEdits(context, body));
    }
    return undefined;
  };

  return { handle };
}
