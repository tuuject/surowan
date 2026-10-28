import type {
  ActiveAgentSettings,
  AgentRuntimeConfig,
  AgentSectionConfig,
  AgentSettings,
  FileChat,
  TelegramRuntimeConfig,
  TelegramSectionConfig,
  VisionModelReference,
  VisionRuntimeConfig,
  VisionSectionConfig,
} from './index.ts';
import type { HostKind } from '../im-host/identity.ts';

/**
 * Turns the optional `agent` and `vision` sections into the runtime shape: every
 * field that has a default is filled, while the model identity triple stays
 * optional so an absent triple still means "no invocations".
 */

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

/**
 * Values a configuration gets when it has no `telegram` section at all. The
 * section's presence is not a feature switch — an empty Chat allowlist already
 * means "no Chat is processed" — so these are ordinary defaults, chosen to
 * match the documented example configuration.
 */
export const TELEGRAM_DEFAULTS = {
  process_bot_messages: false,
  bucket_window_seconds: 15,
} as const;

/** Fills the optional `telegram` section, keeping an absent token absent. */
export function resolveTelegramSection(
  section: TelegramSectionConfig | null | undefined,
): Omit<TelegramRuntimeConfig, 'chats'> & { chats: TelegramSectionConfig['chats'] } {
  return {
    ...(section ?? {}),
    process_bot_messages: section?.process_bot_messages ?? TELEGRAM_DEFAULTS.process_bot_messages,
    bucket_window_seconds: section?.bucket_window_seconds ?? TELEGRAM_DEFAULTS.bucket_window_seconds,
    chats: section?.chats ?? [],
  };
}

/**
 * The debounce window a host collects its batches with.
 *
 * Telegram keeps the configured window; a room is sealed when its input is
 * released, so it collects nothing. There is no default case: a new host kind
 * does not compile until it names its window, because config validation checks
 * `agent.context.idle_grace_seconds` against every host's window.
 */
export function resolveBucketWindowSeconds(
  config: { readonly telegram: Pick<TelegramRuntimeConfig, 'bucket_window_seconds'> },
  hostKind: HostKind,
): number {
  switch (hostKind) {
    case 'telegram':
      return config.telegram.bucket_window_seconds;
    case 'playground':
      return 0;
  }
}

/** Values a configuration gets when it leaves a `vision` field out. */
export const VISION_DEFAULTS = {
  max_output_tokens: 2_048,
  max_concurrency: 2,
  background_sticker_concurrency: 1,
  prompt_version: 1,
  daily_budget: { max_tokens: 200_000, max_images: 200 },
} as const;

/** Fills the optional `vision` section with `VISION_DEFAULTS`, field by field. */
export function resolveVisionSection(section: VisionSectionConfig | null | undefined): VisionRuntimeConfig {
  return {
    ...(section?.provider === undefined ? {} : { provider: section.provider }),
    ...(section?.model === undefined ? {} : { model: section.model }),
    max_output_tokens: section?.max_output_tokens ?? VISION_DEFAULTS.max_output_tokens,
    max_concurrency: section?.max_concurrency ?? VISION_DEFAULTS.max_concurrency,
    background_sticker_concurrency: VISION_DEFAULTS.background_sticker_concurrency,
    prompt_version: section?.prompt_version ?? VISION_DEFAULTS.prompt_version,
    daily_budget: {
      max_tokens: section?.daily_budget?.max_tokens ?? VISION_DEFAULTS.daily_budget.max_tokens,
      max_images: section?.daily_budget?.max_images ?? VISION_DEFAULTS.daily_budget.max_images,
    },
  };
}

/** The configured vision model pair, or undefined when either half is missing. */
export function activeVisionModel(
  vision: Pick<VisionSectionConfig, 'provider' | 'model'> | null | undefined,
): VisionModelReference | undefined {
  const provider = vision?.provider;
  const model = vision?.model;
  return provider === undefined || model === undefined ? undefined : { provider, model };
}
