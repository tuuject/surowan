import Type from 'typebox';
import { PositiveInteger, SecretRefSchema, Strict, ThinkingLevelSchema } from './schema-model.ts';

/**
 * The participation, chat, agent, vision, tool-model and dictionary sections of
 * the configuration file; `config-resolve.ts` turns the runtime-relevant ones
 * into their filled form.
 */

// Local wall-clock times, resolved against the chat's timezone. `24:00` is the
// end of the day, so `00:00-24:00` covers a full day.
export const ParticipationWindowSchema = Type.Object(
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
export const ParticipationSchema = Type.Object(
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
export const ProactiveReplySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    base_probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    increment: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    // The attempt that is guaranteed to hit, counted from 1.
    hard_pity: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  Strict,
);

export const DictionaryInjectionModeSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('on_demand'),
  Type.Literal('aggressive'),
]);

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
 * The file shape of the `vision` section: every field optional, because a
 * deployment may run without a vision model. Without the provider/model pair,
 * `read_image` and background sticker indexing are unavailable, while a
 * multimodal agent still receives newly injected images directly. The
 * runtime-facing form is `VisionRuntimeConfig`, produced by
 * `resolveVisionSection`.
 */
export const VisionSectionSchema = Type.Object(
  {
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    max_output_tokens: Type.Optional(PositiveInteger),
    max_concurrency: Type.Optional(PositiveInteger),
    background_sticker_concurrency: Type.Optional(Type.Literal(1)),
    prompt_version: Type.Optional(PositiveInteger),
    daily_budget: Type.Optional(
      Type.Object({ max_tokens: Type.Optional(PositiveInteger), max_images: Type.Optional(PositiveInteger) }, Strict),
    ),
  },
  Strict,
);

/**
 * The system-wide auxiliary model for dictionary merge and future helper tasks.
 * Absent means "inherit the global agent settings"; each Chat override is
 * deliberately not consulted, so one group's chat model cannot change a
 * system-wide helper call.
 */
export const ToolModelSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking_level: ThinkingLevelSchema,
  },
  Strict,
);

export const DictionarySectionSchema = Type.Object(
  { injection_mode: Type.Optional(DictionaryInjectionModeSchema) },
  Strict,
);

/**
 * One configured search engine. The provider id stays a plain string here: the
 * set of registered providers comes from plugins, so `validateWebSearchSection`
 * checks membership while the schema only checks the shape.
 */
export const SearchEngineSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }),
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    enabled: Type.Optional(Type.Boolean()),
    endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    api_key: Type.Optional(SecretRefSchema),
    results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 30 })),
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  Strict,
);

/**
 * The `web_search` section. The whole section is optional and its absence means
 * "disabled"; inside a present section only the switch is required to turn the
 * feature off, so `engines` may stay empty.
 */
export const WebSearchSectionSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    engines: Type.Optional(Type.Array(SearchEngineSchema, { maxItems: 32 })),
    url_filters: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 50 })),
  },
  Strict,
);

export const ChatSchema = Type.Object(
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
