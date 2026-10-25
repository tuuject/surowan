import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { ImageBridge } from '../../../image/bridge.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { ConfigController, ConfigEdit } from '../../../platform/config/write.ts';
import {
  listOpenRouterImageEndpoints,
  listOpenRouterImageModels,
  validImageModelId,
} from '../../../platform/image-models.ts';
import { json, readJsonObject, redact, requiredRevision, revisionRequired } from '../http.ts';
import { CONFIG_WRITE_STATUS } from '../config-file.ts';
import { type createImageAdminHandler, type ImageAdminResponse, reusableImageCredentials } from '../image.ts';

const imageCredentialSourcesValidator = Compile(
  Type.Record(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), Type.String({ minLength: 1, maxLength: 80 })),
);

export type ImageAdminHandler = ReturnType<typeof createImageAdminHandler>;

export interface ImageAdminRoutesDeps {
  /** The generation surface; absent when the host runs without image services. */
  readonly image: ImageAdminHandler | undefined;
  readonly bridge: ImageBridge | undefined;
  readonly configReloader: ConfigController | undefined;
  readonly secrets: SecretStore | undefined;
}

/** `/api/image*` — generation, discovery and the image section of the config file. */
export function createImageAdminRoutes(deps: ImageAdminRoutesDeps) {
  const { image, bridge, configReloader, secrets } = deps;

  const imageConfigView = async (): Promise<Response> => {
    const reloader = configReloader;
    if (reloader === undefined) {
      return json({ error: 'config_reload_unavailable', message: 'Configuration reloading is not wired' }, 503);
    }
    const revision = await reloader.revision();
    const loaded = await reloader.readPersisted();
    if (revision !== (await reloader.revision())) {
      return json({ error: 'config_conflict', message: '配置已变化，请重新加载' }, 409);
    }
    return json({
      revision,
      enabled: loaded.fileConfig.image !== undefined,
      credentials: Object.keys(loaded.fileConfig.image?.credentials ?? {}),
      credential_providers: Object.keys(reusableImageCredentials(loaded.fileConfig)),
      models: loaded.fileConfig.image?.models ?? [],
    });
  };

  /**
   * The image capability switch: enable writes the `image` section (plaintext
   * credentials travel as edit keys into the key jar, the file keeps SecretRef
   * names), disable removes the section — which also garbage-collects the
   * now-unreferenced jar entries. Applies through the reloader lock, so the
   * snapshot publishes without a restart.
   */
  const applyImageConfig = async (body: Record<string, unknown>, revision: string): Promise<ImageAdminResponse> => {
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
      const credentialNames: Record<string, string> = {};
      const secretRefs = { ...loaded.fileConfig.image?.credentials };
      const sources = body.credential_sources ?? {};
      if (!imageCredentialSourcesValidator.Check(sources)) {
        return { kind: 'json', status: 400, body: { error: 'invalid_body', message: '凭据来源格式不正确' } };
      }
      const reusable = reusableImageCredentials(loaded.fileConfig);
      for (const [name, alias] of Object.entries(sources)) {
        const ref = Object.hasOwn(reusable, alias) ? reusable[alias] : undefined;
        if (ref === undefined) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `OpenRouter 凭据来源不存在：${alias}` },
          };
        }
        secretRefs[name] = ref;
      }
      for (const [name, plaintext] of Object.entries(credentials)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name) || typeof plaintext !== 'string' || plaintext.length === 0) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `invalid credential entry: ${name}` },
          };
        }
        credentialNames[name] = plaintext;
        secretRefs[name] = { jar: name };
      }
      const { ImageSectionSchema } = await import('../../../platform/config/schema.ts');
      const sectionValidator = Compile(ImageSectionSchema);
      if (!sectionValidator.Check({ credentials: secretRefs, models })) {
        const detail = [...sectionValidator.Errors({ credentials: secretRefs, models })]
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
        if (!Object.hasOwn(secretRefs, model.credentialRef)) {
          return {
            kind: 'json',
            status: 400,
            body: { error: 'invalid_body', message: `模型 ${model.name} 的凭据 ${model.credentialRef} 尚未配置` },
          };
        }
      }
      for (const plaintext of Object.values(credentialNames)) {
        secrets?.remember(plaintext);
      }
      edits = [
        { path: ['image', 'credentials'], value: secretRefs, keys: credentialNames },
        { path: ['image', 'models'], value: models },
      ];
    }
    const result = await reloader.writeAndApply(edits, revision);
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
    ): Promise<Response | undefined> {
      if (segments[0] !== 'image') {
        return undefined;
      }
      const route = segments.join('/');
      if (route === 'image/config' && request.method === 'GET') {
        return await imageConfigView();
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
      if (image === undefined) {
        return json({ error: 'image_unavailable', message: 'Image generation is not wired' }, 503);
      }
      const response = await image(
        request,
        segments,
        url,
        { username },
        (maxBytes) => readJsonObject(request, maxBytes),
        async (body) => await applyImageConfig(body, requiredRevision(request) ?? ''),
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
