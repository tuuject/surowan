import { isIP } from 'node:net';
import type { JSONPath } from 'jsonc-parser';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import {
  builtinModelApi,
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  SUPPORTED_PROVIDER_APIS,
} from './builtin-providers.ts';
import { supportedThinkingLevels } from './thinking-levels.ts';

const Strict = { additionalProperties: false } as const;
const PositiveInteger = Type.Integer({ minimum: 1 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
/** Provider aliases appear in Admin API paths and in `restart_required` strings. */
export const PROVIDER_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Which compat overrides each API adapter honours; anything else is rejected. */
const COMPAT_FIELDS_BY_API: Readonly<Record<ProviderApi, readonly string[]>> = {
  'openai-completions': [
    'supports_developer_role',
    'thinking_format',
    'max_tokens_field',
    'requires_reasoning_content',
    'cache_control_format',
  ],
  'openai-responses': ['supports_developer_role'],
  'anthropic-messages': [],
  'google-generative-ai': [],
};
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
/** File name of the key jar; kept here so validation messages name it without file I/O imports. */
export const KEY_JAR_FILE = 'key.json';

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
export type ToolSchemaKeywords = Static<typeof ToolSchemaKeywordsSchema>;
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
const BuiltinProviderSchema = Type.Object(
  {
    kind: Type.Literal('builtin'),
    provider: Type.String({ minLength: 1 }),
    api_key: SecretRefSchema,
    models: Type.Array(ModelConfigSchema, { minItems: 1 }),
  },
  Strict,
);
const CustomProviderApiSchema = Type.Union([
  Type.Literal('openai-responses'),
  Type.Literal('openai-completions'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);
const CustomProviderSchema = Type.Object(
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
// Local wall-clock times, resolved against the chat's timezone. `24:00` is the
// end of the day, so `00:00-24:00` covers a full day.
const ParticipationWindowSchema = Type.Object(
  {
    start: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
    end: Type.String({ pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' }),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, uniqueItems: true })),
  },
  Strict,
);
// `active_windows` and `trigger_keywords` are admin-authored lists whose length
// carries no behavioral meaning, so they stay unbounded like every other list in
// this file. An empty list is meaningful: no scheduled periods means the chat is
// reachable only through a trigger, and no keywords means only mentions and
// replies trigger it.
const ParticipationSchema = Type.Object(
  {
    active_windows: Type.Optional(Type.Array(ParticipationWindowSchema)),
    trigger_keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    attention_window_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  },
  Strict,
);
// Probabilistic scheduling for *proactive* group participation. Direct
// invocations (mention, reply to the bot, trigger keyword, bot command) never
// pass through it. Every field is optional so a Chat can inherit the global
// value field by field.
const ProactiveReplySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    base_probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    increment: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    // The attempt that is guaranteed to hit, counted from 1.
    hard_pity: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  Strict,
);
export type ProactiveReplyConfig = Static<typeof ProactiveReplySchema>;
export const DictionaryInjectionModeSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('on_demand'),
  Type.Literal('aggressive'),
]);
export type DictionaryInjectionMode = Static<typeof DictionaryInjectionModeSchema>;

/**
 * The file shape of the `agent` section: every field optional, because a
 * deployment may run without a model at all (message ingestion and the panel
 * still work; no invocation ever starts). The runtime-facing form is
 * `AgentRuntimeConfig`, produced by `resolveAgentSection`.
 */
export const AgentContextSectionSchema = Type.Object(
  {
    retained_sends_target: Type.Optional(Type.Integer({ minimum: 1 })),
    retained_sends_max: Type.Optional(Type.Integer({ minimum: 2 })),
    hard_token_ratio: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.8 })),
    ref_ttl_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
    idle_grace_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600 })),
    max_wall_clock_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    agent_cache_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_024 })),
  },
  Strict,
);
export const AgentRateLimitsSectionSchema = Type.Object(
  {
    sends_per_window: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    window_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    turns_per_injection: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  Strict,
);
export const AgentSectionSchema = Type.Object(
  {
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    daily_budget: Type.Optional(Type.Object({ max_tokens: Type.Optional(PositiveInteger) }, Strict)),
    thinking_level: Type.Optional(ThinkingLevelSchema),
    system_prompt_file: Type.Optional(Type.String({ minLength: 1 })),
    send_max_text_length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
    send_disallow_blank_lines: Type.Optional(Type.Boolean()),
    max_concurrency: Type.Optional(PositiveInteger),
    context_stop_ratio: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.8 })),
    history_messages: Type.Optional(Type.Integer({ minimum: 1 })),
    memory_ttl_warning_days: Type.Optional(PositiveInteger),
    send_nudge_enabled: Type.Optional(Type.Boolean()),
    send_barrier_enabled: Type.Optional(Type.Boolean()),
    allow_reply_message_multiple_times: Type.Optional(Type.Boolean({ default: false })),
    send_duplicate_guard_enabled: Type.Optional(Type.Boolean({ default: true })),
    context: Type.Optional(AgentContextSectionSchema),
    rate_limits: Type.Optional(AgentRateLimitsSectionSchema),
  },
  Strict,
);

/**
 * The system-wide auxiliary model for dictionary merge and future helper tasks.
 * Absent means "inherit the global agent settings"; each Chat override is
 * deliberately not consulted, so one group's chat model cannot change a
 * system-wide helper call.
 */
const ToolModelSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking_level: ThinkingLevelSchema,
  },
  Strict,
);

const DictionarySectionSchema = Type.Object({ injection_mode: Type.Optional(DictionaryInjectionModeSchema) }, Strict);
const ChatSchema = Type.Object(
  {
    id: Type.Integer(),
    topic_ids: Type.Optional(Type.Array(PositiveInteger, { minItems: 1, uniqueItems: true })),
    ignored_user_ids: Type.Optional(Type.Array(PositiveInteger, { uniqueItems: true })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    instructions_file: Type.Optional(Type.String({ minLength: 1 })),
    participation: Type.Optional(ParticipationSchema),
    proactive_reply: Type.Optional(ProactiveReplySchema),
    dictionary_injection_mode: Type.Optional(DictionaryInjectionModeSchema),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking_level: Type.Optional(ThinkingLevelSchema),
  },
  Strict,
);
const StickerSetSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    name: Type.String({ minLength: 1 }),
  },
  Strict,
);
const ToolPolicyFields = {
  read_only: Type.Boolean(),
  timeout_seconds: Type.Number({ exclusiveMinimum: 0 }),
};
const ToolPolicySchema = Type.Object({ name: Type.String({ minLength: 1 }), ...ToolPolicyFields }, Strict);
const DefaultToolPolicySchema = Type.Object(ToolPolicyFields, Strict);
const StdioMcpSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    transport: Type.Literal('stdio'),
    command: Type.Array(Type.String(), { minItems: 1 }),
    required: Type.Boolean(),
    tools: Type.Union([Type.Literal('*'), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })]),
    payload_max_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    result_max_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    tool_policies: Type.Optional(Type.Array(ToolPolicySchema)),
    default_tool_policy: Type.Optional(DefaultToolPolicySchema),
  },
  Strict,
);
const HttpMcpSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    transport: Type.Literal('streamable_http'),
    url: Type.String({ minLength: 1 }),
    follow_redirects: Type.Literal(false),
    required: Type.Boolean(),
    tools: Type.Union([Type.Literal('*'), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })]),
    payload_max_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    result_max_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    tool_policies: Type.Optional(Type.Array(ToolPolicySchema)),
    default_tool_policy: Type.Optional(DefaultToolPolicySchema),
  },
  Strict,
);
const AdminSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    session_ttl_hours: Type.Integer({ minimum: 1, maximum: 720 }),
    static_dir: Type.Optional(Type.String({ minLength: 1 })),
    public_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  Strict,
);

/**
 * The image section is soft-validated: `validateFileConfig` strips an invalid section
 * (recording a warning) instead of rejecting the whole configuration, so a
 * broken image block degrades to "image generation disabled" and can never
 * keep the bot from starting. The section's absence is simply "disabled".
 */
export const ImageSectionSchema = Type.Object(
  {
    // Credential name -> SecretRef. Values are resolved per candidate
    // apply (never at diff time), so the core only ever sees strings.
    credentials: Type.Record(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), SecretRefSchema),
    // Structurally validated here; the exact capability/enum contract is
    // enforced by the image-service package when a snapshot is prepared.
    models: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }),
          name: Type.String({ minLength: 1, maxLength: 80 }),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
          provider: Type.String({ minLength: 1, maxLength: 40 }),
          upstreamModel: Type.String({ pattern: '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' }),
          credentialRef: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }),
          providerTag: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}(?:\\/[a-zA-Z0-9_-]{1,80})?$' }),
          capabilities: Type.Object(
            {
              imageInput: Type.Boolean(),
              maxInputImages: Type.Integer({ minimum: 0, maximum: 16 }),
              maxOutputs: Type.Integer({ minimum: 1, maximum: 10 }),
              aspectRatios: Type.Array(Type.String(), { minItems: 1 }),
              resolutionClasses: Type.Array(Type.String(), { minItems: 1 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    data_dir: Type.String({ minLength: 1 }),
    timezone: Type.String({ minLength: 1 }),
    telegram: Type.Object(
      {
        token: SecretRefSchema,
        process_bot_messages: Type.Boolean(),
        sticker_trigger_enabled: Type.Optional(Type.Boolean()),
        mention_typing_enabled: Type.Optional(Type.Boolean()),
        bucket_window_seconds: Type.Integer({ minimum: 0, maximum: 300 }),
        participation: Type.Optional(ParticipationSchema),
        proactive_reply: Type.Optional(ProactiveReplySchema),
        chats: Type.Array(ChatSchema, { minItems: 1 }),
        admins: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true })),
        sticker_sets: Type.Optional(Type.Array(StickerSetSchema)),
      },
      Strict,
    ),
    providers: Type.Record(Type.String({ minLength: 1 }), Type.Union([BuiltinProviderSchema, CustomProviderSchema])),
    // `agent` may be absent, null or a partial object: every field is optional,
    // and only the provider/model/thinking_level triple decides whether any
    // invocation can start — everything else resolves to AGENT_DEFAULTS.
    agent: Type.Optional(Type.Union([AgentSectionSchema, Type.Null()])),
    vision: Type.Object(
      {
        provider: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
        max_output_tokens: PositiveInteger,
        max_concurrency: PositiveInteger,
        background_sticker_concurrency: Type.Literal(1),
        prompt_version: PositiveInteger,
        daily_budget: Type.Object({ max_tokens: PositiveInteger, max_images: PositiveInteger }, Strict),
      },
      Strict,
    ),
    image: Type.Optional(ImageSectionSchema),
    dictionary: Type.Optional(DictionarySectionSchema),
    tool_model: Type.Optional(ToolModelSchema),
    retention: Type.Object({ online_days: PositiveInteger, backup_copies: PositiveInteger }, Strict),
    paths: Type.Object(
      {
        database: Type.String({ minLength: 1 }),
        media_cache: Type.String({ minLength: 1 }),
        backups: Type.String({ minLength: 1 }),
      },
      Strict,
    ),
    mcp: Type.Optional(Type.Object({ servers: Type.Array(Type.Union([StdioMcpSchema, HttpMcpSchema])) }, Strict)),
    admin: Type.Optional(AdminSchema),
    developer: Type.Optional(
      Type.Object(
        {
          record_model_payloads: Type.Optional(Type.Boolean({ default: false })),
          record_agent_thinking: Type.Optional(Type.Boolean({ default: false })),
        },
        Strict,
      ),
    ),
    web_fetch: Type.Optional(
      Type.Object(
        {
          // Proxy fake-ip modes (Clash, Surge) answer every DNS lookup with a
          // 198.18.0.0/15 address; only such deployments may accept it, since
          // anywhere else a hostname resolving there is an SSRF attempt.
          allow_proxy_synthetic_addresses: Type.Optional(Type.Boolean()),
          // Lets the model reach loopback, LAN and cloud metadata endpoints; only
          // for trusted single-user deployments that fetch their own services.
          dangerously_allow_all_ip_addresses: Type.Optional(Type.Boolean()),
          // Defaults to true: advertise text/markdown so negotiating sites skip HTML extraction.
          accept_markdown: Type.Optional(Type.Boolean()),
        },
        Strict,
      ),
    ),
  },
  Strict,
);

export type SecretRef = Static<typeof SecretRefSchema>;
export type ProviderApi = Static<typeof CustomProviderApiSchema>;
export type ModelCompatConfig = Static<typeof ModelCompatSchema>;
export type ThinkingLevelConfig = Static<typeof ThinkingLevelSchema>;
export type ModelFileConfig = Static<typeof ModelConfigSchema>;
export type AgentSectionConfig = Static<typeof AgentSectionSchema>;
export type FileConfig = Static<typeof ConfigSchema>;
export type FileChat = FileConfig['telegram']['chats'][number];
/**
 * The model identity triple as configured: every field may be absent, and only a
 * fully specified one can run an invocation (`completeAgentSettings` is the
 * gate). A Chat override may supply whichever fields the global section lacks.
 */
export type AgentSettings = Pick<AgentSectionConfig, 'provider' | 'model' | 'thinking_level'>;

/** All three identity fields present — the state in which invocations may start. */
export type ActiveAgentSettings = Required<AgentSettings>;

export function completeAgentSettings(settings: AgentSettings): ActiveAgentSettings | undefined {
  const { provider, model, thinking_level } = settings;
  if (provider === undefined || model === undefined || thinking_level === undefined) {
    return undefined;
  }
  return { provider, model, thinking_level };
}

/** Resolves Chat overrides, or the global defaults when no Chat is supplied. */
export function resolveAgentSettings(
  config: { readonly agent?: AgentSettings | null },
  chat?: Pick<FileChat, 'provider' | 'model' | 'thinking_level'>,
): AgentSettings {
  const agent = config.agent ?? undefined;
  const provider = chat?.provider ?? agent?.provider;
  const model = chat?.model ?? agent?.model;
  const thinking_level = chat?.thinking_level ?? agent?.thinking_level;
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinking_level === undefined ? {} : { thinking_level }),
  };
}

/**
 * The runtime half of the `agent` section: `resolveAgentSection` fills every
 * field that has a default, so consumers keep reading concrete values. The
 * identity triple and the send/memory toggles stay optional — an absent triple
 * means "no invocations", an absent toggle means "off" (or on, for the
 * duplicate-send guard).
 */
export interface AgentRuntimeConfig extends AgentSettings {
  readonly daily_budget: { readonly max_tokens: number };
  readonly max_concurrency: number;
  readonly context_stop_ratio: number;
  readonly history_messages: number;
  readonly memory_ttl_warning_days?: number;
  readonly send_max_text_length?: number;
  readonly send_disallow_blank_lines?: boolean;
  readonly send_nudge_enabled?: boolean;
  readonly send_barrier_enabled?: boolean;
  readonly allow_reply_message_multiple_times?: boolean;
  readonly send_duplicate_guard_enabled?: boolean;
  readonly context: {
    readonly retained_sends_target: number;
    readonly retained_sends_max: number;
    readonly hard_token_ratio: number;
    readonly ref_ttl_hours: number;
    readonly idle_grace_seconds: number;
    readonly max_wall_clock_seconds: number;
    readonly agent_cache_size: number;
  };
  readonly rate_limits: {
    readonly sends_per_window: number;
    readonly window_seconds: number;
    readonly turns_per_injection: number;
  };
  /** Path the prompt text was loaded from; informational, the text lives in `system_prompt`. */
  readonly system_prompt_file?: string;
}

/**
 * Values a configuration gets when it leaves a field out. `idle_grace_seconds`
 * defaults to 0 — not 60 like the documented example — because it is the only
 * value that stays valid for every `telegram.bucket_window_seconds` an empty
 * `agent` section may sit next to.
 */
export const AGENT_DEFAULTS = {
  daily_budget: { max_tokens: 1_000_000_000 },
  max_concurrency: 4,
  context_stop_ratio: 0.8,
  history_messages: 20,
  context: {
    retained_sends_target: 20,
    retained_sends_max: 30,
    hard_token_ratio: 0.6,
    ref_ttl_hours: 72,
    idle_grace_seconds: 0,
    max_wall_clock_seconds: 1_800,
    agent_cache_size: 32,
  },
  rate_limits: {
    sends_per_window: 100,
    window_seconds: 300,
    turns_per_injection: 24,
  },
} as const;

/** Fills the optional `agent` section with `AGENT_DEFAULTS`, field by field. */
export function resolveAgentSection(section: AgentSectionConfig | null | undefined): AgentRuntimeConfig {
  const context = section?.context;
  const rateLimits = section?.rate_limits;
  return {
    ...(section ?? {}),
    daily_budget: { max_tokens: section?.daily_budget?.max_tokens ?? AGENT_DEFAULTS.daily_budget.max_tokens },
    max_concurrency: section?.max_concurrency ?? AGENT_DEFAULTS.max_concurrency,
    context_stop_ratio: section?.context_stop_ratio ?? AGENT_DEFAULTS.context_stop_ratio,
    history_messages: section?.history_messages ?? AGENT_DEFAULTS.history_messages,
    context: {
      retained_sends_target: context?.retained_sends_target ?? AGENT_DEFAULTS.context.retained_sends_target,
      retained_sends_max: context?.retained_sends_max ?? AGENT_DEFAULTS.context.retained_sends_max,
      hard_token_ratio: context?.hard_token_ratio ?? AGENT_DEFAULTS.context.hard_token_ratio,
      ref_ttl_hours: context?.ref_ttl_hours ?? AGENT_DEFAULTS.context.ref_ttl_hours,
      idle_grace_seconds: context?.idle_grace_seconds ?? AGENT_DEFAULTS.context.idle_grace_seconds,
      max_wall_clock_seconds: context?.max_wall_clock_seconds ?? AGENT_DEFAULTS.context.max_wall_clock_seconds,
      agent_cache_size: context?.agent_cache_size ?? AGENT_DEFAULTS.context.agent_cache_size,
    },
    rate_limits: {
      sends_per_window: rateLimits?.sends_per_window ?? AGENT_DEFAULTS.rate_limits.sends_per_window,
      window_seconds: rateLimits?.window_seconds ?? AGENT_DEFAULTS.rate_limits.window_seconds,
      turns_per_injection: rateLimits?.turns_per_injection ?? AGENT_DEFAULTS.rate_limits.turns_per_injection,
    },
  };
}

export type ParticipationConfig = Static<typeof ParticipationSchema>;
export type ParticipationWindowConfig = Static<typeof ParticipationWindowSchema>;
export type RawConfig = Omit<FileConfig, 'agent' | 'telegram' | 'developer'> & {
  developer: { record_model_payloads: boolean; record_agent_thinking: boolean };
  agent: AgentRuntimeConfig & { readonly system_prompt: string };
  telegram: Omit<FileConfig['telegram'], 'chats'> & {
    chats: Array<Omit<FileChat, 'instructions_file'> & { instructions: string }>;
  };
};
export type ImageConfig = RawConfig['image'];
export type DictionaryConfig = RawConfig['dictionary'];
export type ToolModelConfig = RawConfig['tool_model'];
export type ProviderConfig = RawConfig['providers'][string];
export type McpServerConfig = NonNullable<RawConfig['mcp']>['servers'][number];

/** Validate a parsed configuration independently of its source or location. */
export function validateFileConfig(parsed: unknown): { fileConfig: FileConfig; warnings: readonly string[] } {
  const plaintext = plaintextSecrets(parsed);
  if (plaintext.length > 0) {
    // The schema would only report a failed union at each of these paths.
    throw new Error(
      `Invalid config: plaintext secrets are not accepted; move them into ${KEY_JAR_FILE} and reference them as { "jar": "<name>" }: ${plaintext.map((secret) => secret.path.join('.')).join(', ')}`,
    );
  }
  // Invalid image configuration is intentionally disabled with a warning,
  // while all other sections fail validation.
  const warnings: string[] = [];
  const root = asRecord(parsed);
  if (root.image !== undefined && !imageValidator.Check(root.image)) {
    const details = imageValidator
      .Errors(root.image)
      .slice(0, 5)
      .map((error) => `${error.instancePath || '/image'}: ${formatValidationError(error)}`)
      .join('; ');
    warnings.push(
      `image generation disabled: the "image" section is invalid and was ignored (${details}); fix or remove it to enable image generation`,
    );
    delete root.image;
  }
  if (!validator.Check(parsed)) {
    const details = validator
      .Errors(parsed)
      .slice(0, 10)
      .map((error) => `${error.instancePath || '/'}: ${formatValidationError(error)}`)
      .join('; ');
    throw new Error(`Invalid config: ${details}`);
  }
  validateSemantics(parsed);
  if (completeAgentSettings(resolveAgentSettings(parsed)) === undefined) {
    warnings.push(
      'agent.provider, agent.model and agent.thinking_level are not all set: the bot will run without starting any invocation',
    );
  }
  return { fileConfig: parsed, warnings };
}

const validator = Compile(ConfigSchema);
const imageValidator = Compile(ImageSectionSchema);

/**
 * The SecretRef fields of a parsed configuration that still hold a plain
 * string, as written before the key jar existed. Only the error message depends
 * on this list, so a field missing from it degrades to the schema's own error
 * rather than to anything unsafe.
 */
export function plaintextSecrets(parsed: unknown): { readonly path: JSONPath; readonly value: string }[] {
  const found: { path: JSONPath; value: string }[] = [];
  const check = (value: unknown, path: JSONPath): void => {
    if (typeof value === 'string') {
      found.push({ path, value });
    }
  };
  const checkEach = (record: unknown, path: JSONPath): void => {
    for (const [name, value] of Object.entries(asRecord(record))) {
      check(value, [...path, name]);
    }
  };
  const root = asRecord(parsed);
  check(asRecord(root.telegram).token, ['telegram', 'token']);
  for (const [alias, provider] of Object.entries(asRecord(root.providers))) {
    check(asRecord(provider).api_key, ['providers', alias, 'api_key']);
    checkEach(asRecord(provider).headers, ['providers', alias, 'headers']);
  }
  const servers = asRecord(root.mcp).servers;
  for (const [index, server] of (Array.isArray(servers) ? servers : []).entries()) {
    checkEach(asRecord(server).env, ['mcp', 'servers', index, 'env']);
    checkEach(asRecord(server).headers, ['mcp', 'servers', index, 'headers']);
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * TypeBox reports an unexpected key as a bare "must not have additional properties", which forces
 * callers to diff their file against the schema by hand. The offending names live in `params`.
 */
function formatValidationError(error: TLocalizedValidationError): string {
  if (error.keyword === 'additionalProperties') {
    return `${error.message}: ${error.params.additionalProperties.join(', ')}`;
  }
  return error.message;
}

/**
 * Combines a validated `FileConfig` with already-read prompt texts.
 *
 * The result shares every nested object it is not asked to replace with
 * `fileConfig`; callers that keep a `FileConfig` and a `RawConfig` of the same
 * configuration (as `LoadedConfig` does) therefore hold aliases, not copies, and
 * must never mutate either side. The reload path builds both layers from a
 * `structuredClone` for exactly that reason.
 */
export function assembleRawConfig(
  fileConfig: FileConfig,
  systemPrompt: string,
  instructionsByChatId: ReadonlyMap<number, string>,
): RawConfig {
  const chats = fileConfig.telegram.chats.map((chat) => {
    const { instructions_file, ...rest } = chat;
    return { ...rest, instructions: instructionsByChatId.get(chat.id) ?? '' };
  });
  return {
    ...fileConfig,
    developer: {
      record_model_payloads: fileConfig.developer?.record_model_payloads ?? false,
      record_agent_thinking: fileConfig.developer?.record_agent_thinking ?? false,
    },
    agent: { ...resolveAgentSection(fileConfig.agent), system_prompt: systemPrompt },
    telegram: { ...fileConfig.telegram, chats },
  };
}

export function adminPublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('admin.public_url must be an HTTPS origin (HTTP localhost is allowed for local use)');
  }
  if (isIP(url.hostname) !== 0 || url.hostname.startsWith('[')) {
    throw new Error('admin.public_url must use a domain name, not an IP address (use localhost for local testing)');
  }
  const local = url.hostname === 'localhost';
  if (
    value !== value.trim() ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    ![url.origin, `${url.origin}/`].includes(value)
  ) {
    throw new Error(
      'admin.public_url must be a canonical HTTPS origin without credentials, path, query or fragment (HTTP localhost is allowed for local use)',
    );
  }
  return url.origin;
}

export function validateSemantics(config: FileConfig): void {
  if (config.admin?.public_url !== undefined) {
    adminPublicOrigin(config.admin.public_url);
  }
  validateTimezone(config.timezone, 'timezone');
  validateParticipation(config.telegram.participation, 'telegram.participation');
  const agent = resolveAgentSection(config.agent);
  validateContextConfig(config, agent);
  const chatIds = new Set<number>();
  for (const chat of config.telegram.chats) {
    if (!Number.isSafeInteger(chat.id) || chat.id === 0) {
      throw new Error(`Invalid Telegram chat ID: ${chat.id}`);
    }
    if (chatIds.has(chat.id)) {
      throw new Error(`Duplicate Telegram chat ID: ${chat.id}`);
    }
    chatIds.add(chat.id);
    if (chat.participation !== undefined) {
      if (chat.id > 0) {
        throw new Error(`Chat ${chat.id} is a private chat and cannot configure participation`);
      }
      validateParticipation(chat.participation, `chat ${chat.id} participation`);
    }
    if (chat.proactive_reply !== undefined && chat.id > 0) {
      throw new Error(`Chat ${chat.id} is a private chat and cannot configure proactive_reply`);
    }
    if (chat.timezone !== undefined) {
      validateTimezone(chat.timezone, `chat ${chat.id} timezone`);
    }
    for (const ignoredUserId of chat.ignored_user_ids ?? []) {
      if (!Number.isSafeInteger(ignoredUserId) || ignoredUserId === 0) {
        throw new Error(`Invalid ignored Telegram user ID in chat ${chat.id}: ${ignoredUserId}`);
      }
    }
    if (chat.provider !== undefined || chat.model !== undefined) {
      if (chat.provider === undefined || chat.model === undefined) {
        throw new Error(`Chat ${chat.id}: provider and model must both be set when overriding agent settings`);
      }
      validateModelReference(config, chat.provider, chat.model, `chat ${chat.id}`, ['text']);
    }
    if (chat.provider !== undefined || chat.thinking_level !== undefined) {
      validateAgentThinkingLevel(config, resolveAgentSettings(config, chat), `chat ${chat.id}`);
    }
  }
  for (const adminId of config.telegram.admins ?? []) {
    if (!Number.isSafeInteger(adminId) || adminId === 0) {
      throw new Error(`Invalid Telegram admin user ID: ${adminId}`);
    }
  }
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.alias, 'sticker set alias');
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.name, 'sticker set name');
  const providerAliases = new Set(Object.keys(config.providers));
  // The agent model reference is validated only when both fields are written:
  // a missing provider/model pair never reaches a model lookup at runtime.
  if (agent.provider !== undefined && agent.model !== undefined) {
    validateModelReference(config, agent.provider, agent.model, 'agent', ['text']);
  }
  validateModelReference(config, config.vision.provider, config.vision.model, 'vision', ['image']);
  if (
    (agent.provider !== undefined && !providerAliases.has(agent.provider)) ||
    !providerAliases.has(config.vision.provider)
  ) {
    throw new Error('Agent and vision providers must reference configured aliases');
  }
  for (const [alias, provider] of Object.entries(config.providers)) {
    if (!PROVIDER_ALIAS_PATTERN.test(alias)) {
      throw new Error(
        `Provider alias ${JSON.stringify(alias)} must match ${PROVIDER_ALIAS_PATTERN.source}: the alias is a URL path segment and part of restart path strings`,
      );
    }
    assertUnique(provider.models, (model) => model.id, `provider ${alias} model ID`);
    if (provider.kind === 'custom') {
      validateEndpoint(provider.base_url, `provider ${alias} base_url`);
      for (const model of provider.models) {
        assertModelConfig(provider.api, model, `Provider ${alias} model ${model.id}`);
      }
    } else {
      // pi 1.x builtin catalogs mix chat adapters inside one provider, so each
      // configured model is validated against the api of its own catalog entry.
      for (const model of provider.models) {
        assertModelConfig(
          resolveBuiltinModelApi(alias, provider, model.id),
          model,
          `Provider ${alias} model ${model.id}`,
        );
      }
    }
  }
  validateAgentThinkingLevel(config, agent, 'agent');
  const toolModel = config.tool_model;
  if (toolModel !== undefined) {
    validateModelReference(config, toolModel.provider, toolModel.model, 'tool_model', ['text']);
    validateAgentThinkingLevel(config, toolModel, 'tool_model');
  }
  const servers = config.mcp?.servers ?? [];
  assertUnique(servers, (server) => server.alias, 'MCP server alias');
  for (const server of servers) {
    if (server.transport === 'streamable_http') {
      validateEndpoint(server.url, `MCP server ${server.alias} URL`, { allowQuery: true });
    }
    if (server.tools === '*' && server.default_tool_policy === undefined) {
      throw new Error(`MCP server ${server.alias} wildcard tools require default_tool_policy`);
    }
    const policies = server.tool_policies ?? [];
    assertUnique(policies, (policy) => policy.name, `MCP server ${server.alias} tool policy`);
    if (server.tools !== '*') {
      const allowed = new Set(server.tools);
      for (const policy of policies) {
        if (!allowed.has(policy.name)) {
          throw new Error(`MCP server ${server.alias} policy references unlisted tool ${policy.name}`);
        }
      }
      for (const tool of server.tools) {
        if (!policies.some((policy) => policy.name === tool)) {
          throw new Error(`MCP server ${server.alias} tool ${tool} has no policy`);
        }
      }
    }
  }
}

function validateModelReference(
  config: FileConfig,
  providerAlias: string,
  modelId: string,
  role: string,
  requiredInputs: readonly ('text' | 'image')[],
): void {
  const provider = config.providers[providerAlias];
  if (provider === undefined) {
    throw new Error(`${role}.provider references unknown alias ${providerAlias}`);
  }
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new Error(`${role}.model ${modelId} is absent from provider ${providerAlias}`);
  }
  for (const requiredInput of requiredInputs) {
    if (!model.input.includes(requiredInput)) {
      throw new Error(`${role}.model ${modelId} lacks ${requiredInput} input capability`);
    }
  }
}

/**
 * The API one configured model of a builtin alias speaks: its entry in Pi's
 * catalog, or — for ids the catalog does not list — the provider's uniform
 * catalog api. The uniform fallback keeps single-adapter providers accepting
 * catalog-external model ids; on a mixed-catalog provider there is nothing to
 * inherit, so such an id is a configuration error.
 */
export function resolveBuiltinModelApi(
  alias: string,
  provider: ProviderConfig & { kind: 'builtin' },
  modelId: string,
): ProviderApi {
  const source = findBuiltinProvider(provider.provider);
  if (source === undefined) {
    throw new Error(`Provider ${alias} references unknown built-in provider ${provider.provider}`);
  }
  if (!isSupportedBuiltinPreset(source)) {
    throw new Error(`Provider ${alias} built-in ${provider.provider} cannot be driven from a configured API key`);
  }
  const api = builtinModelApi(source, modelId);
  if (api === null || !SUPPORTED_PROVIDER_APIS.includes(api)) {
    throw new Error(
      `Provider ${alias} model ${modelId} has no supported API (${SUPPORTED_PROVIDER_APIS.join(', ')}) in Pi's ${provider.provider} catalog`,
    );
  }
  return api as ProviderApi;
}

/**
 * The model invariants a provider's API imposes, shared by the configuration
 * validator and the Admin Panel so a rejected edit is reported as a user error
 * before the file is rewritten.
 */
export function assertModelConfig(api: ProviderApi, model: ModelFileConfig, label: string): void {
  if (model.max_tokens > model.context_window) {
    throw new Error(`${label} max_tokens exceeds context_window`);
  }
  if (!model.reasoning && model.thinking_levels !== undefined) {
    throw new Error(`${label} declares thinking_levels but is not a reasoning model`);
  }
  for (const field of Object.keys(model.compat ?? {})) {
    if (!COMPAT_FIELDS_BY_API[api].includes(field)) {
      throw new Error(`${label} cannot set ${field} for api ${api}`);
    }
  }
}

/**
 * The configured entry for one provider alias and model id, or `undefined` when
 * the configuration no longer carries it.
 */
function configuredModel(
  config: { readonly providers: FileConfig['providers'] },
  providerAlias: string,
  modelId: string,
): ModelFileConfig | undefined {
  return config.providers[providerAlias]?.models.find((candidate) => candidate.id === modelId);
}

/**
 * The tool-schema keyword profile one configured model declares. Every caller
 * that sends tool definitions to a model reads it here, so the reduction is
 * decided by the same entry the model was registered from.
 */
export function configuredToolSchemaKeywords(
  config: { readonly providers: FileConfig['providers'] },
  providerAlias: string,
  modelId: string,
): ToolSchemaKeywords | undefined {
  return configuredModel(config, providerAlias, modelId)?.tool_schema_keywords;
}

/**
 * The configured level has to be one the agent model accepts: Pi would otherwise
 * clamp it on some adapters and send it unchanged on others.
 */
function validateAgentThinkingLevel(config: FileConfig, settings: AgentSettings, label: string): void {
  const { provider, model: modelId, thinking_level: level } = settings;
  // An incomplete identity never runs, so there is nothing to check the level
  // against; the file stays loadable instead of rejecting a legal section.
  if (provider === undefined || modelId === undefined || level === undefined) {
    return;
  }
  const model = config.providers[provider]?.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    return;
  }
  const supported = supportedThinkingLevels(model);
  if (!supported.includes(level)) {
    throw new Error(
      `${label}.thinking_level ${level} is not supported by ${provider}/${modelId} (supported: ${supported.join(', ')})`,
    );
  }
}

function validateEndpoint(value: string, label: string, options: { allowQuery?: boolean } = {}): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const invalidQuery = !options.allowQuery && url.search.length > 0;
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    invalidQuery ||
    url.hash
  ) {
    const forbiddenParts = options.allowQuery ? 'credentials or fragment' : 'credentials, query, or fragment';
    throw new Error(`${label} must be an HTTP(S) URL without ${forbiddenParts}`);
  }
}

// A zero-length window can never match, so it is a configuration mistake
// rather than a quiet way to disable one entry.
function validateParticipation(participation: ParticipationConfig | undefined, label: string): void {
  for (const window of participation?.active_windows ?? []) {
    if (window.start === window.end) {
      throw new Error(`${label} has an empty active window: ${window.start}-${window.end}`);
    }
  }
}

/**
 * Conversation Context invariants. `idle_grace_seconds = 0` is the supported way
 * to turn long-lived invocations off, but a grace shorter than one bucket
 * window would look enabled while every run ends before the next bucket is due:
 * a silent degradation, rejected here instead of at 3 a.m. in production.
 */
function validateContextConfig(config: FileConfig, agent: AgentRuntimeConfig): void {
  const context = agent.context;
  if (context.retained_sends_target >= context.retained_sends_max) {
    throw new Error('agent.context.retained_sends_target must be smaller than retained_sends_max');
  }
  if (context.hard_token_ratio > agent.context_stop_ratio) {
    throw new Error('agent.context.hard_token_ratio must not exceed agent.context_stop_ratio');
  }
  if (context.idle_grace_seconds > 0 && context.idle_grace_seconds < config.telegram.bucket_window_seconds) {
    throw new Error(
      'agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_window_seconds',
    );
  }
  if (context.max_wall_clock_seconds <= context.idle_grace_seconds) {
    throw new Error('agent.context.max_wall_clock_seconds must exceed idle_grace_seconds');
  }
}

function validateTimezone(value: string, label: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertUnique<T>(items: readonly T[], select: (item: T) => string, label: string): void {
  const values = new Set<string>();
  for (const item of items) {
    const value = select(item);
    if (values.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    values.add(value);
  }
}
