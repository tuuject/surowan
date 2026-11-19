import { Compile } from 'typebox/compile';
import type { ImageBridge } from '../../../image/bridge/index.ts';
import type { ImageService } from '../../../image/service.ts';
import type { BusinessStore } from '../../../store/store.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import { createImageExtractHandler } from './image-extract.ts';
import type { SecretRef } from '../../../platform/config/index.ts';
import type { ConfigController, ConfigEdit, KeychainReplacement, SecretWrite } from '../../../platform/config/write.ts';
import {
  listOpenRouterImageEndpoints,
  listOpenRouterImageModels,
  validImageModelId,
} from '../../../platform/image-models.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import { CONFIG_WRITE_STATUS } from '../config-file.ts';
import { json, readJsonObject, redact, requiredRevision, revisionRequired } from '../http.ts';
import type { createImageAdminHandler, ImageAdminResponse } from '../image.ts';
import {
  type CallerClass,
  resolveSecretInput,
  SecretAllocator,
  type SecretInput,
  sameSecretRef,
  secretSourceOf,
} from '../secret-input.ts';

export type ImageAdminHandler = ReturnType<typeof createImageAdminHandler>;

export interface ImageAdminRoutesDeps {
  /** The generation surface; absent when the host runs without image services. */
  readonly image: ImageAdminHandler | undefined;
  readonly bridge: ImageBridge | undefined;
  /** The image core owner; the extraction preview reads the asset bytes from it. */
  readonly service: ImageService | undefined;
  /** The live model registry and configuration; the extraction resolves its model here. */
  readonly configStore: RuntimeConfigurationStore | undefined;
  /** Host store; the extraction audits its model call through `model_calls`. */
  readonly store: BusinessStore | undefined;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

/** `/api/image*` — generation, discovery and the image section of the config file. */
export function createImageAdminRoutes(deps: ImageAdminRoutesDeps) {
  const { image, bridge, service, configStore, store, configReloader, secrets } = deps;

  const imageConfigView = async (withSources: boolean): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = await reloader.revision();
    const loaded = await reloader.readPersisted();
    if (revision !== (await reloader.revision())) {
      return json({ error: 'config_conflict', message: '配置已变化，请重新加载' }, 409);
    }
    const credentials = Object.entries(loaded.fileConfig.image?.credentials ?? {});
    return json({
      revision,
      enabled: loaded.fileConfig.image !== undefined,
      credentials: credentials.map(([name]) => name),
      ...(withSources
        ? { credential_key_sources: Object.fromEntries(credentials.map(([name, ref]) => [name, secretSourceOf(ref)])) }
        : {}),
      models: loaded.fileConfig.image?.models ?? [],
    });
  };

  /**
   * The image capability switch: enable writes the `image` section (plaintext
   * credentials travel as edit keys into the keychain, the file keeps SecretRef
   * names), disable removes the section — leaving the entries in place for an
   * explicit purge. Applies through the reloader lock, so the snapshot
   * publishes without a restart.
   */
  const applyImageConfig = async (
    body: Record<string, unknown>,
    revision: string,
    caller: CallerClass,
  ): Promise<ImageAdminResponse> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return {
        kind: 'json',
        status: 503,
        body: { error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' },
      };
    }
    const enabled = body.enabled;
    if (typeof enabled !== 'boolean') {
      return { kind: 'json', status: 400, body: { error: 'invalid_body', message: 'enabled must be a boolean' } };
    }
    if (revision !== (await reloader.revision())) {
      return { kind: 'json', status: 409, body: { error: 'config_conflict', message: '配置已变化，请重新加载后保存' } };
    }
    let edits: readonly ConfigEdit[];
    let repairs: Record<string, string> | undefined;
    let replaces: KeychainReplacement[] | undefined;
    if (!enabled) {
      edits = [{ path: ['image'], value: undefined }];
    } else {
      const credentials = body.credentials;
      const models = body.models;
      if (
        typeof credentials !== 'object' ||
        credentials === null ||
        Array.isArray(credentials) ||
        !Array.isArray(models) ||
        models.length === 0
      ) {
        return {
          kind: 'json',
          status: 400,
          body: { error: 'invalid_body', message: 'enabling requires credentials (name -> secret) and a models array' },
        };
      }
      const loaded = await reloader.readPersisted();
      const snapshot = await reloader.keychainSnapshot();
      const allocator = new SecretAllocator(
        new Set(snapshot.entries.map((entry) => entry.name)),
        snapshot.usage.file ?? {},
      );
      const savedRefs: Record<string, SecretRef> = Object.assign(
        Object.create(null),
        loaded.fileConfig.image?.credentials ?? {},
      );
      const keys: Record<string, string> = Object.create(null);

      const remembered: string[] = [];
      for (const [name, value] of Object.entries(credentials as Record<string, unknown>)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `invalid credential entry: ${name}` },
          };
        }
        const read = readCredentialInput(value);
        if (read === null) {
          // No submitted secret for this name: the stored reference stays.
          continue;
        }
        if (!read.ok) {
          return {
            kind: 'json',
            status: 400,
            body: {
              error: 'invalid_body',
              message: `credential ${name} must be a string, { value, name? } or { entry }, or null to keep the stored one`,
            },
          };
        }
        const resolved = resolveSecretInput(
          read.input,
          {
            path: `image.credentials.${name}`,
            editPath: ['image', 'credentials', name],
            current: savedRefs[name],
            suggestedName: name,
          },
          caller,
          allocator,
        );
        if (resolved.kind !== 'reuse') {
          remembered.push(resolved.plaintext);
        }
        if (resolved.kind === 'new') {
          keys[resolved.name] = resolved.plaintext;
        } else if (resolved.kind === 'repair') {
          const target: Record<string, string> = repairs ?? Object.create(null);
          target[resolved.name] = resolved.plaintext;
          repairs = target;
        } else if (resolved.kind === 'rotate') {
          if (replaces === undefined) {
            replaces = [];
          }
          replaces.push({
            name: resolved.name,
            value: resolved.plaintext,
            requestedBy: `image.credentials.${name}`,
          });
        }
        if (!sameSecretRef(resolved.ref, savedRefs[name])) {
          savedRefs[name] = resolved.ref;
        }
      }
      const { ImageSectionSchema } = await import('../../../platform/config/schema.ts');
      const sectionValidator = Compile(ImageSectionSchema);
      if (!sectionValidator.Check({ credentials: savedRefs, models })) {
        const detail = [...sectionValidator.Errors({ credentials: savedRefs, models })]
          .slice(0, 3)
          .map((error) => `${error.instancePath}: ${error.message ?? 'invalid'}`)
          .join('; ');
        return {
          kind: 'json',
          status: 400,
          body: { error: 'invalid_body', message: `image section is invalid: ${detail}` },
        };
      }
      const modelIds = new Set<string>();
      for (const model of models) {
        if (modelIds.has(model.id)) {
          return { kind: 'json', status: 400, body: { error: 'invalid_body', message: `模型 ID 重复：${model.id}` } };
        }
        modelIds.add(model.id);
        if (!Object.hasOwn(savedRefs, model.credentialRef)) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `模型 ${model.name} 的凭据 ${model.credentialRef} 尚未配置` },
          };
        }
      }
      for (const plaintext of remembered) {
        secrets?.remember(plaintext);
      }
      // A rotate-only save (every reference stays, no new entries) is not a
      // configuration change: the rotation rides on the keychain alone and the
      // no-op edits are dropped, so `writeConfigEdits` does not reject them.
      const refsMoved = JSON.stringify(savedRefs) !== JSON.stringify(loaded.fileConfig.image?.credentials ?? {});
      const modelsMoved = JSON.stringify(models) !== JSON.stringify(loaded.fileConfig.image?.models ?? []);
      const nextEdits: ConfigEdit[] = [];
      if (refsMoved || Object.keys(keys).length > 0) {
        nextEdits.push({
          path: ['image', 'credentials'],
          value: savedRefs,
          ...(Object.keys(keys).length > 0 ? { keys } : {}),
        });
      }
      if (modelsMoved) {
        nextEdits.push({ path: ['image', 'models'], value: models });
      }
      edits = nextEdits;
    }
    const secretsWrite: SecretWrite = {
      ...(repairs === undefined || Object.keys(repairs).length === 0 ? {} : { add: repairs }),
      ...(replaces !== undefined && replaces.length > 0 ? { replace: replaces } : {}),
    };
    const result = await reloader.writeSecretsAndApply(edits, secretsWrite, revision);
    if (!result.ok) {
      const message = result.fileWritten
        ? `config.jsonc was updated but not applied: ${result.message}`
        : result.message;
      return { kind: 'json', status: CONFIG_WRITE_STATUS[result.code] ?? 409, body: { error: result.code, message } };
    }
    const bridgeEnabled = bridge?.enabled() ?? false;
    return {
      kind: 'json',
      status: 200,
      body: {
        enabled: enabled && bridgeEnabled,
        apply: { applied: result.applied, restart_required: result.restartRequired },
      },
    };
  };

  return {
    async handle(
      request: Request,
      url: URL,
      segments: readonly string[],
      username: string,
      caller: CallerClass,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'image') {
        return undefined;
      }
      const route = segments.join('/');
      if (route === 'image/config' && request.method === 'GET') {
        return await imageConfigView(caller === 'session');
      }
      if (request.method === 'GET' && (route === 'image/models' || route === 'image/models/endpoints')) {
        const model = url.searchParams.get('model');
        if (route === 'image/models/endpoints' && !validImageModelId(model)) {
          return json({ error: 'invalid_model', message: '图片模型 ID 不合法' }, 400);
        }
        try {
          return json(
            route === 'image/models'
              ? { models: await listOpenRouterImageModels() }
              : { endpoints: await listOpenRouterImageEndpoints(model as string) },
          );
        } catch (error) {
          return json({ error: 'image_discovery_failed', message: redact(secrets, error) }, 502);
        }
      }
      if (route === 'image/config' && request.method === 'PUT' && requiredRevision(request) === null) {
        return revisionRequired();
      }
      // The two-step metadata extraction preview: paid, read-only, never persisted.
      if (
        request.method === 'POST' &&
        segments[1] === 'images' &&
        segments[3] === 'extract' &&
        segments[2] !== undefined
      ) {
        if (service === undefined || configStore === undefined || store === undefined || secrets === undefined) {
          return json({ error: 'image_unavailable', message: 'Image generation is not wired' }, 503);
        }
        const extract = createImageExtractHandler({ service, configStore, orm: store.orm, secrets });
        return await extract(request, segments[2]);
      }
      if (image === undefined) {
        return json({ error: 'image_unavailable', message: 'Image generation is not wired' }, 503);
      }
      const response = await image(
        request,
        segments,
        url,
        { username },
        (maxBytes) => readJsonObject(request, maxBytes),
        async (body) => await applyImageConfig(body, requiredRevision(request) ?? '', caller),
      );
      if (response.kind === 'content') {
        return new Response(new Uint8Array(response.bytes), {
          status: response.status,
          headers: { 'content-type': response.mime, 'cache-control': 'private, no-store' },
        });
      }
      return json(response.body, response.status);
    },
  };
}

/** One submitted credential value: the shared secret input union, or nothing. */
function readCredentialInput(
  value: unknown,
): { readonly ok: true; readonly input: SecretInput } | { readonly ok: false } | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    return { ok: true, input: value };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.entry === 'string' && Object.keys(record).length === 1) {
      return { ok: true, input: { entry: record.entry } };
    }
    if (typeof record.value === 'string') {
      const name = typeof record.name === 'string' ? record.name : undefined;
      return {
        ok: true,
        input: name === undefined ? { value: record.value } : { value: record.value, name },
      };
    }
  }
  return { ok: false };
}
