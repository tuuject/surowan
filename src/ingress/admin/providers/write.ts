/**
 * Provider writes: the config edits a panel request turns into, in the order the
 * panel applies them, with the connection and model prechecks they run first.
 */
import {
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  supportedBuiltinApi,
} from '../../../platform/builtin-providers.ts';
import type { FileChat, ModelFileConfig, ProviderApi, ThinkingLevelConfig } from '../../../platform/config/index.ts';
import { type ConfigEdit, secretEdit } from '../../../platform/config/write.ts';
import { newKeyJarName } from '../../../platform/key-jar.ts';
import { supportedThinkingLevels } from '../../../platform/thinking-levels.ts';
import { AdminQueryError } from '../audit/shared.ts';
import type { CreateProviderBody, ProviderWriteContext, UpdateProviderBody } from './index.ts';
import { checkModel, modelApi, providerOf, registerSecrets } from './read.ts';
import { resolveVisionSection } from '../../../platform/config/resolve.ts';

export async function createProvider(context: ProviderWriteContext, body: CreateProviderBody): Promise<ConfigEdit[]> {
  if (context.file.providers[body.alias] !== undefined) {
    throw new AdminQueryError('provider_exists', `Provider ${body.alias} already exists`, 409);
  }
  const api = await resolveNewProviderApi(body);
  for (const model of body.models) {
    checkModel(api, model, `model ${model.id}`);
  }
  registerSecrets(context.secrets, [body.api_key, ...Object.values(body.headers ?? {})]);
  const keys: Record<string, string> = {};
  const toJar = (plaintext: string): { jar: string } => {
    const name = newKeyJarName();
    keys[name] = plaintext;
    return { jar: name };
  };
  const provider =
    body.kind === 'builtin'
      ? {
          kind: 'builtin' as const,
          provider: body.provider as string,
          api_key: toJar(body.api_key),
          models: body.models,
        }
      : {
          kind: 'custom' as const,
          base_url: (body.base_url as string).replace(/\/+$/, ''),
          api: body.api as ProviderApi,
          api_key: toJar(body.api_key),
          ...(body.headers === undefined
            ? {}
            : {
                headers: Object.fromEntries(Object.entries(body.headers).map(([name, value]) => [name, toJar(value)])),
              }),
          models: body.models,
        };
  return [{ path: ['providers', body.alias], value: provider, keys }];
}

async function resolveNewProviderApi(body: CreateProviderBody): Promise<ProviderApi> {
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
    const api = supportedBuiltinApi(source);
    if (api === null) {
      throw new AdminQueryError(
        'unsupported_builtin_provider',
        `Built-in provider ${body.provider} has no single supported API adapter`,
      );
    }
    return api;
  }
  if (body.base_url === undefined || body.api === undefined) {
    throw new AdminQueryError('invalid_body', 'base_url and api are required for a custom provider');
  }
  return body.api;
}

export async function updateProvider(
  context: ProviderWriteContext,
  alias: string,
  body: UpdateProviderBody,
): Promise<ConfigEdit[]> {
  const provider = providerOf(context.file, alias);
  const edits: ConfigEdit[] = [];
  const secretsToRegister: string[] = [];
  const removedHeaders: string[] = [];
  if (provider.kind === 'builtin') {
    if (body.base_url !== undefined || body.api !== undefined || body.headers !== undefined) {
      throw new AdminQueryError(
        'immutable_field',
        'A built-in provider only allows its API key to change; its base URL, API and headers come from Pi',
      );
    }
    if (body.api_key !== undefined) {
      secretsToRegister.push(body.api_key);
      edits.push(secretEdit(['providers', alias, 'api_key'], body.api_key));
    }
  } else {
    const baseUrl = body.base_url === undefined ? provider.base_url : body.base_url.replace(/\/+$/, '');
    const baseUrlChanged = baseUrl !== provider.base_url;
    if (baseUrlChanged) {
      // Moving the endpoint without re-entering the credentials would let a
      // stolen panel session point a configured key at its own server.
      if (body.api_key === undefined) {
        throw new AdminQueryError(
          'credentials_required',
          'Changing base_url requires the API key to be submitted again in the same request',
        );
      }
      for (const name of Object.keys(provider.headers ?? {})) {
        if (typeof body.headers?.[name] !== 'string') {
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
      secretsToRegister.push(body.api_key);
      edits.push(secretEdit(['providers', alias, 'api_key'], body.api_key));
    }
    for (const [name, value] of Object.entries(body.headers ?? {})) {
      if (value === null) {
        if (provider.headers?.[name] === undefined) {
          continue;
        }
        removedHeaders.push(name);
        continue;
      }
      secretsToRegister.push(value);
      edits.push(secretEdit(['providers', alias, 'headers', name], value));
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
  if (edits.length === 0) {
    throw new AdminQueryError('no_changes', 'The request does not change any connection field');
  }
  registerSecrets(context.secrets, secretsToRegister);
  return edits;
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

export function deleteModel(context: ProviderWriteContext, alias: string, modelId: string): ConfigEdit[] {
  const provider = providerOf(context.file, alias);
  const index = provider.models.findIndex((candidate) => candidate.id === modelId);
  if (index < 0) {
    throw new AdminQueryError('model_not_found', `Model ${modelId} is not configured on ${alias}`, 404);
  }
  if (
    (context.file.agent?.provider === alias && context.file.agent?.model === modelId) ||
    (context.file.vision?.provider === alias && context.file.vision?.model === modelId) ||
    referencingChats(context).some((chat) => chat.provider === alias && chat.model === modelId)
  ) {
    throw new AdminQueryError('model_in_use', `Model ${modelId} is used by the default agent, a Chat, or vision`, 409);
  }
  return [{ path: ['providers', alias, 'models', index], value: undefined }];
}

/**
 * `vision.*` is validated only when the model registry is built, so a bad choice
 * would stop the next startup. The precheck runs against the file configuration,
 * which is what that startup will read.
 */
export function visionEdits(
  context: ProviderWriteContext,
  body: { readonly provider: string; readonly model: string },
): ConfigEdit[] {
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
  return [
    { path: ['vision', 'provider'], value: body.provider },
    { path: ['vision', 'model'], value: body.model },
  ];
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
