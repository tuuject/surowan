import Type from 'typebox';
import {
  BuiltinProviderSchema,
  CustomProviderSchema,
  PositiveInteger,
  SecretRefSchema,
  Strict,
} from './schema-model.ts';
import {
  AgentSectionSchema,
  ChatSchema,
  DictionarySectionSchema,
  ParticipationSchema,
  ProactiveReplySchema,
  ToolModelSchema,
  VisionSectionSchema,
} from './schema-sections.ts';

/**
 * The remaining file sections — sticker sets, tool policies, MCP servers, admin
 * and image — plus the root `ConfigSchema` that composes every section into the
 * parsed file shape.
 */

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
    // The panel is part of every deployment now; only an operator who really
    // means to run headless (with Telegram connected) writes `false`.
    enabled: Type.Optional(Type.Boolean()),
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
    // `telegram` may be absent entirely: a deployment that only wants the
    // playground configures no IM at all. Inside a present section every field
    // keeps its old default rules — only the token is optional (empty means
    // "disabled") and the Chat allowlist may stay empty until the bot has been
    // added to a group.
    telegram: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(SecretRefSchema),
          process_bot_messages: Type.Boolean(),
          sticker_trigger_enabled: Type.Optional(Type.Boolean()),
          mention_typing_enabled: Type.Optional(Type.Boolean()),
          bucket_window_seconds: Type.Integer({ minimum: 0, maximum: 300 }),
          participation: Type.Optional(ParticipationSchema),
          proactive_reply: Type.Optional(ProactiveReplySchema),
          chats: Type.Array(ChatSchema),
          admins: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true })),
          sticker_sets: Type.Optional(Type.Array(StickerSetSchema)),
        },
        Strict,
      ),
    ),
    providers: Type.Record(Type.String({ minLength: 1 }), Type.Union([BuiltinProviderSchema, CustomProviderSchema])),
    // `agent` may be absent, null or a partial object: every field is optional,
    // and only the provider/model/thinking_level triple decides whether any
    // invocation can start — everything else resolves to AGENT_DEFAULTS.
    agent: Type.Optional(Type.Union([AgentSectionSchema, Type.Null()])),
    // `vision` may be absent, null or a partial object, like `agent`: only the
    // provider/model pair decides whether image analysis runs, and everything
    // else resolves to VISION_DEFAULTS.
    vision: Type.Optional(Type.Union([VisionSectionSchema, Type.Null()])),
    image: Type.Optional(ImageSectionSchema),
    dictionary: Type.Optional(DictionarySectionSchema),
    tool_model: Type.Optional(ToolModelSchema),
    retention: Type.Object(
      {
        online_days: PositiveInteger,
        backup_copies: PositiveInteger,
        // Read event warnings are kept this long after they are marked read.
        // Optional so existing configurations keep working; the runtime default
        // is 30 days.
        warning_read_days: Type.Optional(PositiveInteger),
      },
      Strict,
    ),
    paths: Type.Object(
      {
        database: Type.String({ minLength: 1 }),
        media_cache: Type.String({ minLength: 1 }),
        backups: Type.String({ minLength: 1 }),
      },
      Strict,
    ),
    mcp: Type.Optional(Type.Object({ servers: Type.Array(Type.Union([StdioMcpSchema, HttpMcpSchema])) }, Strict)),
    admin: AdminSchema,
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
