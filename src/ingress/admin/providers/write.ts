/**
 * Provider writes: the config edits a panel request turns into, in the order the
 * panel applies them, with the connection and model prechecks they run first.
 */

import type { JSONPath } from 'jsonc-parser';
import {
  builtinModelApi,
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  isSupportedProviderApi,
  SUPPORTED_PROVIDER_APIS,
} from '../../../platform/builtin-providers.ts';
import type {
  FileChat,
  ModelFileConfig,
  ProviderApi,
  SecretRef,
  ThinkingLevelConfig,
} from '../../../platform/config/index.ts';

import { resolveVisionSection } from '../../../platform/config/resolve.ts';
import {
  type ConfigEdit,
  type KeychainReplacement,
  type SecretWrite,
  secretEdit,
} from '../../../platform/config/write.ts';
import { supportedThinkingLevels } from '../../../platform/thinking-levels.ts';
import { AdminQueryError } from '../audit/shared.ts';
import {
  isSubmittedPlaintext,
  type ResolvedSecret,
  resolveSecretInput,
  SecretAllocator,
  type SecretInput,
  type SecretSlot,
  sameSecretRef,
} from '../secret-input.ts';
import type {
  CreateProviderBody,
  DeleteModelsBody,
  ProviderWriteContext,
  ProviderWritePlan,
  UpdateProviderBody,
  VisionBody,
} from './index.ts';
import { checkModel, modelApi, providerOf, registerSecrets } from './read.ts';

function slotOf(path: string, editPath: JSONPath, current: SecretRef | undefined, suggestedName: string): SecretSlot {
  return { path, editPath, current, suggestedName };
}

export async function createProvider(
  context: ProviderWriteContext,
  body: CreateProviderBody,
): Promise<ProviderWritePlan> {
  if (context.file.providers[body.alias] !== undefined) {
    throw new AdminQueryError('provider_exists', `Provider ${body.alias} already exists`, 409);
  }
  const apiOf = await resolveNewProviderApi(body);
  for (const model of body.models) {
    checkModel(apiOf(model.id), model, `model ${model.id}`);
  }
  const allocator = new SecretAllocator(context.keychain.entries, context.keychain.usage);
  const apiKey = resolveSecretInput(
    body.api_key,
    slotOf(`providers.${body.alias}.api_key`, ['providers', body.alias, 'api_key'], undefined, body.alias),
    context.caller,
    allocator,
  );
  const headerSecrets: ResolvedSecret[] = [];
  for (const [name, value] of Object.entries(body.headers ?? {})) {
    headerSecrets.push(
      resolveSecretInput(
        value,
        slotOf(
          `providers.${body.alias}.headers.${name}`,
          ['providers', body.alias, 'headers', name],
          undefined,
          `${body.alias}-${name}`,
        ),
        context.caller,
        allocator,
      ),
    );
  }
  registerSecrets(
    context.secrets,
    [apiKey, ...headerSecrets].flatMap((secret) => (secret.kind === 'reuse' ? [] : [secret.plaintext])),
  );
  const keys: Record<string, string> = Object.create(null);
  for (const resolved of [apiKey, ...headerSecrets]) {
    if (resolved.kind === 'new') {
      keys[resolved.name] = resolved.plaintext;
    }
  }
  const headers: Record<string, SecretRef> = {};
  for (const [index, name] of Object.keys(body.headers ?? {}).entries()) {
    headers[name] = headerSecrets[index]?.ref ?? { jar: 'unreachable' };
  }
  const provider =
    body.kind === 'builtin'
      ? {
          kind: 'builtin' as const,
          provider: body.provider as string,
          api_key: apiKey.ref,
          models: body.models,
        }
      : {
          kind: 'custom' as const,
          base_url: (body.base_url as string).replace(/\/+$/, ''),
          api: body.api as ProviderApi,
          api_key: apiKey.ref,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          models: body.models,
        };
  return { edits: [{ path: ['providers', body.alias], value: provider, keys }], secrets: {} };
}

/**
 * The api each created model is prechecked against, as a function of the model
 * id: a custom provider checks every model against its declared adapter, while a
 * builtin one checks against the api of the model's own catalog entry — pi 1.x
 * mixed catalogs like OpenRouter dispatch per model. Builtins that no configured
 * API key can drive are rejected here, before the file is rewritten.
 */
async function resolveNewProviderApi(body: CreateProviderBody): Promise<(modelId: string) => ProviderApi> {
  if (body.kind === 'builtin') {
    if (body.provider === undefined) {
      throw new AdminQueryError('invalid_body', 'provider is required for a builtin provider');
    }
    const source = findBuiltinProvider(body.provider);
    if (source === undefined) {
      throw new AdminQueryError('unknown_builtin_provider', `Unknown built-in provider: ${body.provider}`);
    }
    if (!isSupportedBuiltinPreset(source)) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} cannot be driven from a configured API key`,
      );
    }
    return (modelId) => {
      const api = builtinModelApi(source, modelId);
      if (api === null || !isSupportedProviderApi(api)) {
        throw new AdminQueryError(
          'invalid_model',
          `Provider ${body.alias} model ${modelId} has no supported API (${SUPPORTED_PROVIDER_APIS.join(', ')}) in Pi's ${source.id} catalog`,
        );
      }
      return api;
    };
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  const api = body.api as ProviderApi;
  return () => api;
}

export async function updateProvider(
  context: ProviderWriteContext,
  alias: string,
  body: UpdateProviderBody,
): Promise<ProviderWritePlan> {
  const provider = providerOf(context.file, alias);
  const edits: ConfigEdit[] = [];
  let replaces: readonly KeychainReplacement[] = [];
  const repairs: Record<string, string> = Object.create(null);
  const secretsToRegister: string[] = [];
  const removedHeaders: string[] = [];
  const allocator = new SecretAllocator(context.keychain.entries, context.keychain.usage);

  /** Files one submitted secret: an edit when the reference moves, a rotation or repair when it stays. */
  const accept = (slot: SecretSlot, input: SecretInput): void => {
    const resolved = resolveSecretInput(input, slot, context.caller, allocator);
    secretsToRegister.push(resolved.kind === 'reuse' ? '' : resolved.plaintext);
    if (resolved.kind === 'rotate') {
      replaces = [...replaces, { name: resolved.name, value: resolved.plaintext, requestedBy: slot.path }];
      return;
    }
    if (resolved.kind === 'repair') {
      // The file already names this entry; the value fills it in without a
      // reference change, so it travels outside the edits.
      repairs[resolved.name] = resolved.plaintext;
      return;
    }
    if (!sameSecretRef(resolved.ref, slot.current)) {
      if (resolved.kind === 'new') {
        edits.push(secretEdit(slot.editPath, resolved.plaintext, resolved.name));
      } else {
        edits.push({ path: slot.editPath, value: resolved.ref });
      }
    }
  };

  if (provider.kind === 'builtin') {
    if (body.base_url !== undefined || body.api !== undefined || body.headers !== undefined) {
      throw new AdminQueryError(
        'immutable_field',
        'A built-in provider only allows its API key to change; its base URL, API and headers come from Pi',
      );
    }
    if (body.api_key !== undefined) {
      accept(
        slotOf(`providers.${alias}.api_key`, ['providers', alias, 'api_key'], provider.api_key, alias),
        body.api_key,
      );
    }
  } else {
    const baseUrl = body.base_url === undefined ? provider.base_url : body.base_url.replace(/\/+$/, '');
    const baseUrlChanged = baseUrl !== provider.base_url;
    if (baseUrlChanged && context.caller === 'programmatic') {
      // Moving the endpoint without re-entering the credentials would let an
      // injected prompt point a configured key at its own server. A panel
      // session is the admin, and the entry picker makes the guard moot there.
      if (body.api_key === undefined) {
        throw new AdminQueryError(
          'credentials_required',
          'Changing base_url requires the API key to be submitted again in the same request',
        );
      }
      for (const name of Object.keys(provider.headers ?? {})) {
        if (!isSubmittedPlaintext(body.headers?.[name])) {
          throw new AdminQueryError(
            'credentials_required',
            `Changing base_url requires every header value to be submitted again: ${name}`,
          );
        }
      }
    }
    if (body.base_url !== undefined && baseUrlChanged) {
      edits.push({ path: ['providers', alias, 'base_url'], value: baseUrl });
    }
    if (body.api !== undefined && body.api !== provider.api) {
      edits.push({ path: ['providers', alias, 'api'], value: body.api });
    }
    if (body.api_key !== undefined) {
      accept(
        slotOf(`providers.${alias}.api_key`, ['providers', alias, 'api_key'], provider.api_key, alias),
        body.api_key,
      );
    }
    for (const [name, value] of Object.entries(body.headers ?? {})) {
      if (value === null) {
        if (provider.headers?.[name] === undefined) {
          continue;
        }
        removedHeaders.push(name);
        continue;
      }
      accept(
        slotOf(
          `providers.${alias}.headers.${name}`,
          ['providers', alias, 'headers', name],
          provider.headers?.[name],
          `${alias}-${name}`,
        ),
        value,
      );
    }
    const keptHeaders = Object.keys(provider.headers ?? {}).filter((name) => !removedHeaders.includes(name));
    const addedHeaders = Object.entries(body.headers ?? {}).filter(([, value]) => value !== null).length;
    if (removedHeaders.length > 0 && keptHeaders.length === 0 && addedHeaders === 0) {
      // The last header is gone, so the empty object goes with it instead of
      // leaving a `"headers": {}` behind in the file.
      edits.push({ path: ['providers', alias, 'headers'], value: undefined });
    } else {
      for (const name of removedHeaders) {
        edits.push({ path: ['providers', alias, 'headers', name], value: undefined });
      }
    }
  }
  const secrets: SecretWrite = {
    ...(Object.keys(repairs).length > 0 ? { add: repairs } : {}),
    ...(replaces.length > 0 ? { replace: replaces } : {}),
  };
  if (edits.length === 0 && secrets.add === undefined && secrets.replace === undefined) {
    throw new AdminQueryError('no_changes', 'The request does not change any connection field');
  }
  registerSecrets(
    context.secrets,
    secretsToRegister.filter((value) => value.length > 0),
  );
  return { edits, secrets };
}

/**
 * Chats in the file, plus running Chats already removed from it. A removal waits
 * for a restart, so the running Chat still needs its model; without it the delete
 * would be written and only then rejected by the candidate check.
 */
function referencingChats(context: ProviderWriteContext): readonly Pick<FileChat, 'provider' | 'model'>[] {
  const fileChats = context.file.telegram?.chats ?? [];
  const saved = new Set(fileChats.map((chat) => chat.id));
  return [...fileChats, ...context.snapshot.config.telegram.chats.filter((chat) => !saved.has(chat.id))];
}

export function deleteProvider(context: ProviderWriteContext, alias: string): ConfigEdit[] {
  providerOf(context.file, alias);
  if (
    context.file.agent?.provider === alias ||
    context.file.vision?.provider === alias ||
    referencingChats(context).some((chat) => chat.provider === alias)
  ) {
    throw new AdminQueryError(
      'provider_in_use',
      `Provider ${alias} is used by the default agent, a Chat, or vision`,
      409,
    );
  }
  return [{ path: ['providers', alias], value: undefined }];
}

export async function appendModels(
  context: ProviderWriteContext,
  alias: string,
  models: readonly ModelFileConfig[],
): Promise<ConfigEdit[]> {
  const provider = providerOf(context.file, alias);
  const existing = new Set(provider.models.map((model) => model.id));
  for (const model of models) {
    if (existing.has(model.id)) {
      throw new AdminQueryError('model_exists', `Model ${model.id} is already configured on ${alias}`, 409);
    }
    existing.add(model.id);
    checkModel(modelApi(alias, provider, model.id), model, `model ${model.id}`);
  }
  const offset = provider.models.length;
  return models.map((model, index) => ({
    path: ['providers', alias, 'models', offset + index],
    value: model,
  }));
}

export function replaceModel(
  context: ProviderWriteContext,
  alias: string,
  modelId: string,
  model: ModelFileConfig,
): ConfigEdit[] {
  const provider = providerOf(context.file, alias);
  if (model.id !== modelId) {
    throw new AdminQueryError('invalid_model_id', 'The model id in the body must match the path');
  }
  const index = provider.models.findIndex((candidate) => candidate.id === modelId);
  if (index < 0) {
    throw new AdminQueryError('model_not_found', `Model ${modelId} is not configured on ${alias}`, 404);
  }
  checkModel(modelApi(alias, provider, model.id), model, `model ${model.id}`);
  return [{ path: ['providers', alias, 'models', index], value: model }];
}

function deletableModelIndex(context: ProviderWriteContext, alias: string, modelId: string): number {
  const provider = providerOf(context.file, alias);
  const index = provider.models.findIndex((candidate) => candidate.id === modelId);
  if (index < 0) {
    throw new AdminQueryError('model_not_found', `Model ${modelId} is not configured on ${alias}`, 404);
  }
  if (
    (context.file.agent?.provider === alias && context.file.agent?.model === modelId) ||
    (context.file.vision?.provider === alias && context.file.vision?.model === modelId) ||
    (context.file.tool_model?.provider === alias && context.file.tool_model?.model === modelId) ||
    referencingChats(context).some((chat) => chat.provider === alias && chat.model === modelId)
  ) {
    throw new AdminQueryError(
      'model_in_use',
      `Model ${modelId} is used by the default agent, a Chat, vision, or tool model`,
      409,
    );
  }
  return index;
}

export function deleteModel(context: ProviderWriteContext, alias: string, modelId: string): ConfigEdit[] {
  return [{ path: ['providers', alias, 'models', deletableModelIndex(context, alias, modelId)], value: undefined }];
}

export function deleteModels(context: ProviderWriteContext, body: DeleteModelsBody): ConfigEdit[] {
  const byProvider = new Map<string, Set<number>>();
  for (const target of body.models) {
    const index = deletableModelIndex(context, target.provider, target.model);
    const indexes = byProvider.get(target.provider) ?? new Set<number>();
    if (indexes.has(index)) {
      throw new AdminQueryError('invalid_body', `Duplicate model ${target.provider}/${target.model}`);
    }
    indexes.add(index);
    byProvider.set(target.provider, indexes);
  }
  const edits: ConfigEdit[] = [];
  for (const [alias, indexes] of byProvider) {
    // JSONC array removals shift later indexes, so remove from the end.
    for (const index of [...indexes].sort((left, right) => right - left)) {
      edits.push({ path: ['providers', alias, 'models', index], value: undefined });
    }
  }
  return edits;
}

/**
 * `vision.*` is validated only when the model registry is built, so a bad choice
 * would stop the next startup. The precheck runs against the file configuration,
 * which is what that startup will read.
 *
 * A body with `thinking_level` sets the effort too. Without one the stored
 * effort stays when the model accepts it; otherwise it is removed, so the
 * switch falls back to the model's default instead of leaving an effort the
 * new model rejects.
 */
export function visionEdits(context: ProviderWriteContext, body: VisionBody): ConfigEdit[] {
  const provider = context.file.providers[body.provider];
  if (provider === undefined) {
    throw new AdminQueryError('unknown_provider', `Provider ${body.provider} is not configured`);
  }
  const model = provider.models.find((candidate) => candidate.id === body.model);
  if (model === undefined) {
    throw new AdminQueryError('unknown_model', `Model ${body.model} is absent from provider ${body.provider}`);
  }
  if (!model.input.includes('image')) {
    throw new AdminQueryError('not_image_capable', `Model ${body.model} does not accept image input`);
  }
  const maxOutputTokens = resolveVisionSection(context.file.vision).max_output_tokens;
  if (maxOutputTokens > model.max_tokens) {
    throw new AdminQueryError(
      'max_output_tokens_exceeded',
      `vision.max_output_tokens (${maxOutputTokens}) exceeds the model limit (${model.max_tokens})`,
    );
  }
  const supported = supportedThinkingLevels(model);
  const edits: ConfigEdit[] = [
    { path: ['vision', 'provider'], value: body.provider },
    { path: ['vision', 'model'], value: body.model },
  ];
  if (body.thinking_level !== undefined) {
    if (!supported.includes(body.thinking_level)) {
      throw new AdminQueryError(
        'unsupported_thinking_level',
        `${body.provider}/${body.model} does not accept thinking level ${body.thinking_level} (supported: ${supported.join(', ')})`,
        422,
      );
    }
    edits.push({ path: ['vision', 'thinking_level'], value: body.thinking_level });
  } else {
    const stored = context.file.vision?.thinking_level;
    if (stored !== undefined && !supported.includes(stored)) {
      edits.push({ path: ['vision', 'thinking_level'], value: undefined });
    }
  }
  return edits;
}

/**
 * Sets the agent's thinking level. The level has to be one the agent model in
 * the file accepts, which is the same check the configuration runs on load.
 */
export function thinkingLevelEdits(
  context: ProviderWriteContext,
  body: { readonly thinking_level: ThinkingLevelConfig },
): ConfigEdit[] {
  const provider = context.file.agent?.provider;
  const modelId = context.file.agent?.model;
  // Without a configured pair there is no model to check the level against.
  const model =
    provider === undefined || modelId === undefined
      ? undefined
      : context.file.providers[provider]?.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new AdminQueryError('unknown_model', `Agent model ${provider}/${modelId} is absent from the configuration`);
  }
  const supported = supportedThinkingLevels(model);
  if (!supported.includes(body.thinking_level)) {
    throw new AdminQueryError(
      'unsupported_thinking_level',
      `${provider}/${modelId} does not accept thinking level ${body.thinking_level} (supported: ${supported.join(', ')})`,
      422,
    );
  }
  return [{ path: ['agent', 'thinking_level'], value: body.thinking_level }];
}
