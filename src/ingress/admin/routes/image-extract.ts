import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import {
  AssetExtractionUnavailableError,
  extractAssetMetadata,
  ToolModelNoImageInputError,
} from '../../../image/asset-extraction.ts';
import { listActiveImageModels } from '../../../platform/models/switch.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import { resolveToolModel, type ToolModelSelection } from '../../../platform/tool-model.ts';
import type { Orm } from '../../../store/store.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { json, MAX_BODY_BYTES, readBoundedText, redact } from '../http.ts';
import type { ImageService } from '../../../image/service.ts';
import type { SecretStore } from '../../../platform/secrets.ts';

/**
 * `POST /api/image/images/:id/extract` — the two-step metadata extraction
 * preview. An image-capable model looks at one asset and proposes a name and
 * keywords; the panel fills its edit dialog from the reply, and the admin still
 * saves through the normal update. Nothing is written here, but the call costs
 * money, so the route sits on the paid surface (`write+paid` for API keys).
 *
 * The default model is the tool model. When it cannot read images the route
 * answers `tool_model_no_image_input` with the configured image-capable models
 * attached, so the panel can offer a one-off override; the override is validated
 * against the live registry and never persisted.
 */

/** One image-capable configured model the one-off picker lists. */
export interface ExtractionModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly thinking_levels: readonly string[];
}

export interface ImageExtractDeps {
  readonly service: ImageService;
  readonly configStore: RuntimeConfigurationStore;
  readonly orm: Orm;
  readonly secrets: SecretStore;
}

// The provider alias and model id bounds mirror the configuration's own
// schema (unbounded non-empty strings): every id the registry — and so the
// picker in the 409 body — can list must be submittable here.
const OverrideSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking_level: Type.String({ minLength: 1, maxLength: 16 }),
  },
  { additionalProperties: false },
);

/** `{}` extracts with the configured tool model; `{model: …}` overrides once. */
const BodySchema = Type.Object({ model: Type.Optional(OverrideSchema) }, { additionalProperties: false });
const bodyValidator = Compile(BodySchema);

function imageModelOptions(configStore: RuntimeConfigurationStore): readonly ExtractionModelOption[] {
  return listActiveImageModels(configStore).map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    name: entry.name,
    thinking_levels: [...entry.thinking_levels],
  }));
}

/**
 * Resolves the one-off override against the live registry: the model must
 * exist, accept image input (text too — it must reply), and accept the named
 * thinking level. Never persisted, never a fallback.
 */
function resolveOverride(deps: ImageExtractDeps, override: Static<typeof OverrideSchema>): ToolModelSelection {
  const snapshot = deps.configStore.current();
  const found = snapshot.models.getModel(override.provider, override.model);
  if (found === undefined) {
    throw new AdminQueryError(
      'unknown_model',
      `Model ${override.provider}/${override.model} is not registered in the running process`,
      400,
    );
  }
  if (!found.input.includes('image') || !found.input.includes('text')) {
    throw new AdminQueryError(
      'not_image_capable',
      `Model ${override.provider}/${override.model} does not accept image input`,
      400,
    );
  }
  const level = override.thinking_level as ToolModelSelection['thinkingLevel'];
  if (!getSupportedThinkingLevels(found).includes(level)) {
    throw new AdminQueryError(
      'unsupported_thinking_level',
      `Model ${override.provider}/${override.model} does not support thinking level ${override.thinking_level}`,
      422,
    );
  }
  return { provider: override.provider, model: override.model, thinkingLevel: level, inherited: false };
}

/** The body is optional: `{}` keeps the tool model, `{model: …}` overrides once. */
async function readOptionalBody(request: Request): Promise<Static<typeof BodySchema>> {
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdminQueryError('invalid_body', 'Request body must be JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AdminQueryError('invalid_body', 'Request body must be a JSON object', 400);
  }
  if (!bodyValidator.Check(parsed)) {
    const detail = [...bodyValidator.Errors(parsed)]
      .slice(0, 3)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
      .join('; ');
    throw new AdminQueryError(
      'invalid_body',
      `Expected {} or { model: { provider, model, thinking_level } }: ${detail}`,
      400,
    );
  }
  return parsed;
}

export function createImageExtractHandler(deps: ImageExtractDeps) {
  return async function handle(request: Request, id: string): Promise<Response> {
    const core = deps.service.core;
    let image: { readonly bytes: Buffer; readonly mime: string };
    try {
      const content = core.images.readContent(id);
      if (content.asset.deletedAt !== null) {
        return json({ error: 'asset_archived', message: '已归档的素材不能提取' }, 409);
      }
      image = { bytes: content.bytes, mime: content.asset.mime };
    } catch {
      return json({ error: 'not_found', message: '图片不存在' }, 404);
    }

    const body = await readOptionalBody(request);
    const selection =
      body.model === undefined
        ? resolveToolModel(deps.configStore.current().config)
        : resolveOverride(deps, body.model);
    if (selection === undefined) {
      return json({ error: 'tool_model_unavailable', message: 'No tool model is configured' }, 502);
    }
    try {
      const metadata = await extractAssetMetadata(
        { orm: deps.orm, secrets: deps.secrets, models: deps.configStore.current().models },
        selection,
        image,
        request.signal,
      );
      return json({ name: metadata.name, keywords: [...metadata.keywords] });
    } catch (error) {
      if (error instanceof ToolModelNoImageInputError) {
        return json(
          {
            error: 'tool_model_no_image_input',
            message: redact(deps.secrets, error),
            models: imageModelOptions(deps.configStore),
          },
          409,
        );
      }
      if (error instanceof AssetExtractionUnavailableError) {
        return json({ error: 'tool_model_unavailable', message: redact(deps.secrets, error) }, 502);
      }
      return json({ error: 'extraction_failed', message: redact(deps.secrets, error) }, 502);
    }
  };
}
