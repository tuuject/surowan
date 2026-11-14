/**
 * Provider model discovery: the fetch against a configured or temporary
 * connection, and the models.dev metadata that decorates its listing.
 */
import { findBuiltinProvider, preferredBuiltinApi } from '../../../platform/builtin-providers.ts';
import { resolveModelDrafts } from '../../../platform/models/metadata.ts';
import { loadModelsDevCatalog, MODELS_DEV_URL, type ModelsDevCatalog } from '../../../platform/models-dev.ts';
import { type DiscoveredProviderModel, fetchProviderModels } from '../../../platform/provider-models.ts';
import { sameConnection } from '../../../platform/providers.ts';
import type { RuntimeConfiguration } from '../../../platform/runtime-config.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import { AdminQueryError } from '../audit/shared.ts';
import type {
  DiscoverBody,
  DiscoverResponse,
  LookupMetadataBody,
  LookupMetadataResponse,
  ProviderWriteContext,
} from './index.ts';
import { discoveryApi, providerOf, registerSecrets } from './read.ts';

export async function discover(context: ProviderWriteContext, body: DiscoverBody): Promise<DiscoverResponse> {
  const request = await discoveryRequest(context, body);
  const listing = await fetchProviderModels(request.request);
  const catalog = await loadCatalog(context.snapshot, context.secrets);
  const drafts = resolveModelDrafts(request.descriptor, listing.models, catalog.catalog);
  const configured = new Set(
    (request.alias === undefined ? [] : (context.file.providers[request.alias]?.models ?? [])).map((model) => model.id),
  );
  return {
    endpoint: listing.endpoint,
    models: drafts.map((draft) => ({ ...draft, configured: configured.has(draft.id) })),
    metadata_source_error: catalog.error,
  };
}

interface CatalogLoad {
  readonly catalog: ModelsDevCatalog;
  readonly error: string | null;
}

/**
 * The catalog is one metadata source among several, so a fetch failure degrades
 * to "every field models.dev would have filled is missing" instead of failing
 * the request: the admin still sees the provider's own listing and can confirm
 * or type the rest.
 *
 * The address is read from the active snapshot on every lookup, so a hot
 * `models_dev.api_url` change takes effect on the next one.
 */
async function loadCatalog(snapshot: RuntimeConfiguration, secrets: SecretStore): Promise<CatalogLoad> {
  try {
    return {
      catalog: await loadModelsDevCatalog({ url: modelsDevUrl(snapshot) }),
      error: null,
    };
  } catch (error) {
    return { catalog: {}, error: secrets.redact(error instanceof Error ? error.message : String(error)) };
  }
}

interface DiscoveryRequest {
  readonly request: Parameters<typeof fetchProviderModels>[0];
  readonly descriptor: Parameters<typeof resolveModelDrafts>[0];
  readonly alias: string | undefined;
}

async function discoveryRequest(context: ProviderWriteContext, body: DiscoverBody): Promise<DiscoveryRequest> {
  if (body.alias !== undefined) {
    if (body.kind !== undefined || body.provider !== undefined || body.base_url !== undefined) {
      throw new AdminQueryError('invalid_body', 'Pass either alias or a full connection, not both');
    }
    const configured = providerOf(context.file, body.alias);
    const active = context.snapshot.config.providers[body.alias];
    if (active === undefined) {
      throw new AdminQueryError(
        'provider_not_registered',
        `Provider ${body.alias} is not registered in the running process; apply the config file first or use the temporary mode`,
        409,
      );
    }
    if (!sameConnection(active, configured)) {
      // The running process still holds the old connection, and its credentials
      // must never be sent to an address that only exists in the file.
      throw new AdminQueryError(
        'connection_not_applied',
        `Provider ${body.alias} has connection fields the running process has not applied; apply the config file first or use the temporary mode`,
        409,
      );
    }
    const registered = context.snapshot.models.getProvider(body.alias);
    if (registered === undefined) {
      throw new AdminQueryError(
        'provider_not_registered',
        `Provider ${body.alias} is not registered in the running process; apply the config file first or use the temporary mode`,
        409,
      );
    }
    const auth = await context.snapshot.models.getAuth(body.alias);
    const apiKey = auth?.auth.apiKey;
    if (apiKey === undefined) {
      throw new AdminQueryError('credentials_unavailable', `Provider ${body.alias} has no resolved API key`, 409);
    }
    const api = discoveryApi(configured);
    const baseUrl = registered.baseUrl;
    if (baseUrl === undefined) {
      throw new AdminQueryError('invalid_base_url', `Provider ${body.alias} has no base URL`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(registered.headers ?? {})) {
      // A `null` header value suppresses a provider default; there is nothing to send.
      if (value !== null) {
        headers[name] = value;
      }
    }
    const request = {
      ...(configured.kind === 'builtin' ? { builtinProvider: configured.provider } : {}),
      baseUrl,
      api,
      apiKey,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
    return {
      request,
      descriptor: {
        kind: configured.kind,
        ...(configured.kind === 'builtin' ? { builtinProvider: configured.provider } : {}),
        baseUrl,
        api,
      },
      alias: body.alias,
    };
  }
  if (body.kind === undefined || body.api_key === undefined) {
    throw new AdminQueryError('invalid_body', 'Temporary mode requires kind, a connection, and api_key');
  }
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    const api = preferredBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no supported API adapter`,
      );
    }
    registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
    const request = {
      builtinProvider: body.provider,
      baseUrl: source.baseUrl,
      api,
      apiKey: body.api_key,
      ...(body.headers === undefined ? {} : { headers: body.headers }),
    };
    return {
      request,
      descriptor: { kind: 'builtin', builtinProvider: body.provider, baseUrl: source.baseUrl, api },
      alias: undefined,
    };
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
  const baseUrl = body.base_url.replace(/\/+$/, '');
  const request = {
    baseUrl,
    api: body.api,
    apiKey: body.api_key,
    ...(body.headers === undefined ? {} : { headers: body.headers }),
  };
  return {
    request,
    descriptor: { kind: 'custom', baseUrl, api: body.api },
    alias: undefined,
  };
}

/** The catalog address the running process uses: the configured one, else models.dev. */
export function modelsDevUrl(snapshot: RuntimeConfiguration): string {
  return snapshot.config.models_dev?.api_url ?? MODELS_DEV_URL;
}

/** Metadata for ids the admin typed in, for endpoints with no listing to read. */
export async function lookupMetadata(
  body: LookupMetadataBody,
  snapshot: RuntimeConfiguration,
  secrets: SecretStore,
): Promise<LookupMetadataResponse> {
  const descriptor = await lookupDescriptor(body);
  const models: DiscoveredProviderModel[] = body.ids.map((id) => ({
    id,
    name: null,
    extension: { format: 'openai' },
  }));
  const catalog = await loadCatalog(snapshot, secrets);
  return { models: resolveModelDrafts(descriptor, models, catalog.catalog), metadata_source_error: catalog.error };
}

async function lookupDescriptor(body: LookupMetadataBody): Promise<Parameters<typeof resolveModelDrafts>[0]> {
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    const api = preferredBuiltinApi(source);
    if (api === null || source.baseUrl === undefined) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no supported API adapter`,
      );
    }
    return { kind: 'builtin', builtinProvider: body.provider, baseUrl: source.baseUrl, api };
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  return { kind: 'custom', baseUrl: body.base_url.replace(/\/+$/, ''), api: body.api };
}
