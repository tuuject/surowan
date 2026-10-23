import Type, { type Static, type TSchema } from 'typebox';
import Compile from 'typebox/compile';
import type { FileConfig, ModelFileConfig, ProviderApi, ThinkingLevelConfig } from '../../platform/config.ts';
import type { ModelMetadataDraft } from '../../platform/model-metadata.ts';
import type { RuntimeConfiguration } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { AdminQueryError } from './audit.ts';
import { ModelConfigSchema, ThinkingLevelSchema } from '../../platform/config-schema-model.ts';
import { PROVIDER_ALIAS_PATTERN } from '../../platform/config-semantics.ts';

/** Panel bodies carry whole model lists, so they are larger than audit filters. */
export const PROVIDER_BODY_MAX_BYTES = 512 * 1024;
const MAX_MODELS_PER_REQUEST = 200;
const MAX_LOOKUP_IDS = 100;
const Strict = { additionalProperties: false } as const;

const ApiSchema = Type.Union([
  Type.Literal('openai-responses'),
  Type.Literal('openai-completions'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);
const PlainSecretSchema = Type.String({ minLength: 1, maxLength: 8_192 });
const HeaderValuesSchema = Type.Record(Type.String({ minLength: 1 }), PlainSecretSchema);

const CreateProviderBodySchema = Type.Object(
  {
    alias: Type.String({ pattern: PROVIDER_ALIAS_PATTERN.source }),
    kind: Type.Union([Type.Literal('builtin'), Type.Literal('custom')]),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: PlainSecretSchema,
    headers: Type.Optional(HeaderValuesSchema),
    models: Type.Array(ModelConfigSchema, { minItems: 1, maxItems: MAX_MODELS_PER_REQUEST }),
  },
  Strict,
);

const UpdateProviderBodySchema = Type.Object(
  {
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: Type.Optional(PlainSecretSchema),
    /** `null` deletes a header; a missing name keeps the stored value. */
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Union([PlainSecretSchema, Type.Null()]))),
  },
  Strict,
);

const ModelsBodySchema = Type.Object(
  { models: Type.Array(ModelConfigSchema, { minItems: 1, maxItems: MAX_MODELS_PER_REQUEST }) },
  Strict,
);

const DiscoverBodySchema = Type.Object(
  {
    alias: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.Optional(Type.Union([Type.Literal('builtin'), Type.Literal('custom')])),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    api_key: Type.Optional(PlainSecretSchema),
    headers: Type.Optional(HeaderValuesSchema),
  },
  Strict,
);

const LookupMetadataBodySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('builtin'), Type.Literal('custom')]),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    base_url: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(ApiSchema),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_LOOKUP_IDS }),
  },
  Strict,
);

const VisionBodySchema = Type.Object(
  { provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) },
  Strict,
);
const ThinkingLevelBodySchema = Type.Object({ thinking_level: ThinkingLevelSchema }, Strict);

export type CreateProviderBody = Static<typeof CreateProviderBodySchema>;
export type UpdateProviderBody = Static<typeof UpdateProviderBodySchema>;
export type DiscoverBody = Static<typeof DiscoverBodySchema>;
export type LookupMetadataBody = Static<typeof LookupMetadataBodySchema>;

export interface ProviderView {
  readonly alias: string;
  readonly kind: 'builtin' | 'custom';
  readonly provider?: string;
  readonly api: ProviderApi;
  readonly base_url: string;
  readonly header_names: readonly string[];
  readonly models: readonly ModelFileConfig[];
}

export interface ProvidersView {
  readonly revision: string;
  /** Whether the deployment declares an external supervisor that restarts `serve`. */
  readonly supervised: boolean;
  /** Null fields mean the identity triple is not (fully) configured: no invocation can start. */
  readonly agent: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly thinking_level: ThinkingLevelConfig | null;
  };
  /** Null fields mean no vision model is configured: read_image and sticker indexing are unavailable. */
  readonly vision: { readonly provider: string | null; readonly model: string | null };
  /**
   * The system-wide auxiliary model. `inherited` means no dedicated config
   * exists and the three fields describe the global agent settings it follows;
   * they are null when the global agent itself is unconfigured.
   */
  readonly tool_model: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly thinking_level: ThinkingLevelConfig | null;
    readonly inherited: boolean;
  };
  readonly restart_required: readonly string[];
  readonly providers: readonly ProviderView[];
}

export interface ProviderPresetView {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly base_url: string;
}

export interface ModelDiscoveryItem extends ModelMetadataDraft {
  /** The model id is already configured on this provider. */
  readonly configured: boolean;
}

export interface DiscoverResponse {
  readonly endpoint: string;
  readonly models: readonly ModelDiscoveryItem[];
  /**
   * Set when the models.dev catalog could not be fetched. The listing itself is
   * still returned: metadata is enrichment, and the admin can fill it in by hand
   * rather than being blocked by a source that is only one of several.
   */
  readonly metadata_source_error: string | null;
}

export interface LookupMetadataResponse {
  readonly models: readonly ModelMetadataDraft[];
  readonly metadata_source_error: string | null;
}

export interface ProviderWriteContext {
  /** The configuration file as it is on disk right now. */
  readonly file: FileConfig;
  readonly secrets: SecretStore;
  /**
   * The configuration the running process serves. Saved-mode discovery compares
   * the file against it, because a connection the process has not applied may
   * not receive the credentials the process resolved.
   */
  readonly snapshot: RuntimeConfiguration;
}

const createProviderValidator = Compile(CreateProviderBodySchema);
const updateProviderValidator = Compile(UpdateProviderBodySchema);
const modelsBodyValidator = Compile(ModelsBodySchema);
const modelValidator = Compile(ModelConfigSchema);
const discoverValidator = Compile(DiscoverBodySchema);
const lookupValidator = Compile(LookupMetadataBodySchema);
const visionValidator = Compile(VisionBodySchema);
const thinkingLevelValidator = Compile(ThinkingLevelBodySchema);

export function parseAlias(segment: string): string {
  if (!PROVIDER_ALIAS_PATTERN.test(segment)) {
    throw new AdminQueryError('invalid_alias', 'alias must match the provider alias pattern');
  }
  return segment;
}

export function parseCreateProviderBody(value: unknown): CreateProviderBody {
  return parseWith(createProviderValidator, value);
}

export function parseUpdateProviderBody(value: unknown): UpdateProviderBody {
  return parseWith(updateProviderValidator, value);
}

export function parseModelsBody(value: unknown): readonly ModelFileConfig[] {
  return parseWith(modelsBodyValidator, value).models;
}

export function parseModelBody(value: unknown): ModelFileConfig {
  return parseWith(modelValidator, value);
}

export function parseDiscoverBody(value: unknown): DiscoverBody {
  return parseWith(discoverValidator, value);
}

export function parseLookupMetadataBody(value: unknown): LookupMetadataBody {
  return parseWith(lookupValidator, value);
}

export function parseVisionBody(value: unknown): { readonly provider: string; readonly model: string } {
  return parseWith(visionValidator, value);
}

export function parseThinkingLevelBody(value: unknown): { readonly thinking_level: ThinkingLevelConfig } {
  return parseWith(thinkingLevelValidator, value);
}

type Validator<T extends TSchema> = import('typebox/compile').Validator<import('typebox').TProperties, T>;

function parseWith<T extends TSchema>(validator: Validator<T>, value: unknown): Static<T> {
  if (typeof value !== 'object' || value === null) {
    throw new AdminQueryError('invalid_body', 'Request body must be a JSON object');
  }
  if (!validator.Check(value)) {
    const detail = validator
      .Errors(value)
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
      .join('; ');
    throw new AdminQueryError('invalid_body', detail);
  }
  return value as Static<T>;
}
