import Type from 'typebox';

/**
 * The provider, model and secret shapes as written in the configuration file.
 * Validation rules live in `config-semantics.ts` and resolved defaults in
 * `config-resolve.ts`; `ConfigSchema` in `config-schema.ts` composes these into
 * the file's root shape.
 */

export const Strict = { additionalProperties: false } as const;
export const PositiveInteger = Type.Integer({ minimum: 1 });
const NonNegativeNumber = Type.Number({ minimum: 0 });

/** Pi's thinking levels; `thinking-levels.ts` holds their order. */
export const ThinkingLevelSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);

/**
 * A plaintext secret has no form here: it lives in the key jar next to the file
 * (`key-jar.ts`), and the configuration only names its entry.
 */
export const SecretRefSchema = Type.Union([
  Type.Object({ jar: Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }) }, Strict),
  Type.Object({ env: Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) }, Strict),
  Type.Object({ command: Type.Array(Type.String(), { minItems: 1 }) }, Strict),
]);

const CostSchema = Type.Object(
  {
    input: NonNegativeNumber,
    output: NonNegativeNumber,
    cache_read: NonNegativeNumber,
    cache_write: NonNegativeNumber,
  },
  Strict,
);

/**
 * Selected Pi compat overrides. Every field is optional, and omitting one leaves
 * Pi's own detection in charge — the panel therefore shows "automatic" rather
 * than freezing a detected value into the file.
 *
 * `thinking_format` only lists the values that need no extra kwargs;
 * `cache_control_format` only has the one value Pi can force, because Pi merges
 * compat with `??` and has no way to switch the detected default off.
 */
export const ModelCompatSchema = Type.Object(
  {
    supports_developer_role: Type.Optional(Type.Boolean()),
    thinking_format: Type.Optional(
      Type.Union([
        Type.Literal('openai'),
        Type.Literal('openrouter'),
        Type.Literal('deepseek'),
        Type.Literal('together'),
        Type.Literal('zai'),
        Type.Literal('qwen'),
        Type.Literal('string-thinking'),
      ]),
    ),
    max_tokens_field: Type.Optional(Type.Union([Type.Literal('max_completion_tokens'), Type.Literal('max_tokens')])),
    requires_reasoning_content: Type.Optional(Type.Boolean()),
    cache_control_format: Type.Optional(Type.Literal('anthropic')),
  },
  Strict,
);

/**
 * How much of a tool definition's JSON Schema may be sent to one model, honoured
 * by `tool-schema.ts` rather than by Pi. Omitting it sends every keyword the
 * runtime builds; `minimal` reduces the schema to what a grammar folder can
 * fold, because such an endpoint rejects the whole request — before the model
 * produces a token — with `unsupported schema keyword "minLength"` or `more
 * than one JSON reading of the same emitted value`.
 */
export const ToolSchemaKeywordsSchema = Type.Literal('minimal');

export const ModelConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Boolean(),
    /**
     * The thinking levels this model accepts. Only a reasoning model may declare
     * them; leaving the list out keeps Pi's default (`off` through `high`).
     */
    thinking_levels: Type.Optional(Type.Array(ThinkingLevelSchema, { minItems: 1, uniqueItems: true })),
    compat: Type.Optional(ModelCompatSchema),
    tool_schema_keywords: Type.Optional(ToolSchemaKeywordsSchema),
    input: Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]), {
      minItems: 1,
      uniqueItems: true,
    }),
    context_window: PositiveInteger,
    max_tokens: PositiveInteger,
    cost: CostSchema,
  },
  Strict,
);

export const BuiltinProviderSchema = Type.Object(
  {
    kind: Type.Literal('builtin'),
    provider: Type.String({ minLength: 1 }),
    api_key: SecretRefSchema,
    models: Type.Array(ModelConfigSchema, { minItems: 1 }),
  },
  Strict,
);

export const CustomProviderApiSchema = Type.Union([
  Type.Literal('openai-responses'),
  Type.Literal('openai-completions'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);

export const CustomProviderSchema = Type.Object(
  {
    kind: Type.Literal('custom'),
    base_url: Type.String({ minLength: 1 }),
    api: CustomProviderApiSchema,
    api_key: SecretRefSchema,
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    models: Type.Array(ModelConfigSchema, { minItems: 1 }),
  },
  Strict,
);
