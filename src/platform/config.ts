import type { Static } from 'typebox';
import { resolveAgentSection, resolveVisionSection } from './config-resolve.ts';
import type { ConfigSchema } from './config-schema.ts';
import type {
  CustomProviderApiSchema,
  ModelCompatSchema,
  ModelConfigSchema,
  SecretRefSchema,
  ThinkingLevelSchema,
  ToolSchemaKeywordsSchema,
} from './config-schema-model.ts';
import type {
  AgentSectionSchema,
  DictionaryInjectionModeSchema,
  ParticipationSchema,
  ParticipationWindowSchema,
  ProactiveReplySchema,
  VisionSectionSchema,
} from './config-schema-sections.ts';

export type SecretRef = Static<typeof SecretRefSchema>;
export type ProviderApi = Static<typeof CustomProviderApiSchema>;
export type ModelCompatConfig = Static<typeof ModelCompatSchema>;
export type ThinkingLevelConfig = Static<typeof ThinkingLevelSchema>;
export type ModelFileConfig = Static<typeof ModelConfigSchema>;
export type AgentSectionConfig = Static<typeof AgentSectionSchema>;
export type VisionSectionConfig = Static<typeof VisionSectionSchema>;
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

export type ToolSchemaKeywords = Static<typeof ToolSchemaKeywordsSchema>;

export type ProactiveReplyConfig = Static<typeof ProactiveReplySchema>;

export type DictionaryInjectionMode = Static<typeof DictionaryInjectionModeSchema>;

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

/** The vision model pair as configured; analysis runs only when both are present. */
export interface VisionModelReference {
  readonly provider: string;
  readonly model: string;
}

/**
 * The runtime half of the `vision` section: every field with a default is
 * filled, and the provider/model pair stays optional — an absent or partial
 * pair means "no vision model".
 */
export interface VisionRuntimeConfig {
  provider?: string;
  model?: string;
  max_output_tokens: number;
  max_concurrency: number;
  background_sticker_concurrency: 1;
  prompt_version: number;
  daily_budget: { max_tokens: number; max_images: number };
}

export type ParticipationConfig = Static<typeof ParticipationSchema>;
export type ParticipationWindowConfig = Static<typeof ParticipationWindowSchema>;
export type RawConfig = Omit<FileConfig, 'agent' | 'vision' | 'telegram' | 'developer'> & {
  developer: { record_model_payloads: boolean; record_agent_thinking: boolean };
  agent: AgentRuntimeConfig & { readonly system_prompt: string };
  vision: VisionRuntimeConfig;
  telegram: Omit<FileConfig['telegram'], 'chats'> & {
    chats: Array<Omit<FileChat, 'instructions_file'> & { instructions: string }>;
  };
};
export type ImageConfig = RawConfig['image'];
export type DictionaryConfig = RawConfig['dictionary'];
export type ToolModelConfig = RawConfig['tool_model'];
export type ProviderConfig = RawConfig['providers'][string];
export type McpServerConfig = NonNullable<RawConfig['mcp']>['servers'][number];

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
    vision: resolveVisionSection(fileConfig.vision),
    telegram: { ...fileConfig.telegram, chats },
  };
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
