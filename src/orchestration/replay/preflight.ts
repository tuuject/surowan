/**
 * Who may be replayed and with which model: the read-only source, runtime and
 * model-selection guards, plus the scene and fidelity shape a preflight reports.
 *
 * Split out of `replay.ts`; guard order, error codes and messages are unchanged.
 */

import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import type { SceneContext } from '../../context/scene/index.ts';
import type { ActiveAgentSettings, RawConfig } from '../../platform/config/index.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { isThinkingLevel } from '../../platform/thinking-levels.ts';
import { chats, conversations, invocations } from '../../store/schema/index.ts';
import { type BusinessStore, resolveChatConfig } from '../../store/store.ts';
import type { ReplayError, ReplayModelSelection } from './index.ts';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config/resolve.ts';

/**
 * The live objects the guards read, plus `ReplayError` passed in rather than
 * imported so this module graph stays acyclic.
 */
export interface ReplayGuardDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly error: typeof ReplayError;
}

/** Source identity only; no historical model requests or private agent history. */
export interface ReplaySource {
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
}

export interface ReplayRuntime {
  readonly snapshot: InvocationConfigSnapshot;
  readonly settings: ActiveAgentSettings;
  readonly model: Model<Api>;
  /** Which explicit model-selection fields the caller supplied, for disclosure. */
  readonly selection: {
    readonly provider: boolean;
    readonly model: boolean;
    readonly thinking_level: boolean;
  };
}

export type ReplayCheck =
  | { readonly ok: true; readonly source: ReplaySource }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type ReplayRuntimeCheck =
  | { readonly ok: true; readonly runtime: ReplayRuntime }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function sceneMetadata(scene: SceneContext) {
  return {
    cutoff_at: scene.cutoffAt,
    source_bucket_id: scene.bucketId.toString(),
    message_count: scene.messageCount,
    history_count: scene.historyCount,
    omitted_messages: scene.omittedMessages,
    ...(scene.slice === undefined
      ? {}
      : {
          slice: {
            before_send_id: scene.slice.beforeSendId,
            before_message_id: scene.slice.beforeMessageId,
            after_bot_message_id: scene.slice.afterBotMessageId,
          },
        }),
  };
}

export const PREFLIGHT_FIDELITY = {
  input: 'historical_public_chat',
  model_selection: 'current_chat_config',
  prompt_selection: 'current_chat_config',
  tool_selection: 'current_registry',
  hot_injections: 'not_replayed',
  external_tools: 'blocked',
  system_resources: 'current_read_only',
  side_effects: 'synthetic',
} as const;

/** Finished source identity, independent of developer recording. */
export function checkReplaySource(deps: ReplayGuardDeps, id: bigint): ReplayCheck {
  const { orm } = deps.store;
  const source = orm
    .select({
      state: invocations.state,
      finishedAt: invocations.finishedAt,
      hostKind: chats.hostKind,
      chatId: chats.telegramChatId,
      conversationId: conversations.id,
      threadId: conversations.messageThreadId,
    })
    .from(invocations)
    .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(eq(invocations.id, id))
    .get();
  if (source === undefined) {
    throw new deps.error('not_found', 'Invocation not found', 404);
  }
  if (source.finishedAt === null || source.state === 'queued' || source.state === 'running') {
    return {
      ok: false,
      code: 'replay_source_unfinished',
      message: 'Replay requires a finished invocation',
    };
  }
  // Replay resolves the Telegram chat configuration, so it can only reproduce
  // Telegram-hosted invocations. Say so explicitly instead of reading a
  // Telegram id that a virtual row does not have.
  if (source.hostKind !== 'telegram' || source.chatId === null) {
    return {
      ok: false,
      code: 'replay_host_unsupported',
      message: 'Replay currently supports Telegram-hosted invocations only',
    };
  }
  return {
    ok: true,
    source: {
      conversationId: source.conversationId,
      chatId: source.chatId,
      threadId: source.threadId,
    },
  };
}

/**
 * The current-configuration half of the guard: the source chat and the
 * effective agent model must still exist. An explicit model selection is
 * validated against the same snapshot before anything else runs: the pair
 * rule, registry membership, text capability and thinking-level support are
 * all rejected before a preflight or a run can reach the model.
 */
export function checkReplayRuntime(
  deps: ReplayGuardDeps,
  source: ReplaySource,
  selection: ReplayModelSelection = {},
): ReplayRuntimeCheck {
  const snapshot = deps.configStore.beginInvocation();
  const config: RawConfig = snapshot.config;
  const chat = resolveChatConfig(config, deps.store.orm, source.chatId);
  if (chat === undefined) {
    return { ok: false, code: 'replay_chat_unconfigured', message: 'The source chat is no longer configured' };
  }
  if (chat.topic_ids !== undefined && !chat.topic_ids.some((topic) => BigInt(topic) === source.threadId)) {
    return { ok: false, code: 'replay_topic_unconfigured', message: 'The source topic is no longer configured' };
  }
  const settings = completeAgentSettings(resolveAgentSettings(config, chat));
  if (settings === undefined) {
    return { ok: false, code: 'replay_model_unavailable', message: 'The current agent model is not configured' };
  }
  const currentModel = snapshot.models.getModel(settings.provider, settings.model);
  if (currentModel === undefined) {
    return { ok: false, code: 'replay_model_unavailable', message: 'The current agent model is unavailable' };
  }
  const selectionFlags = {
    provider: selection.provider !== undefined,
    model: selection.model !== undefined,
    thinking_level: selection.thinking_level !== undefined,
  };
  let model = currentModel;
  let effective: ActiveAgentSettings = settings;
  if (selection.provider !== undefined || selection.model !== undefined) {
    // An explicit pair overrides the Chat settings for this replay only; a
    // pair without a thinking level resets it to the weakest level the target
    // supports, exactly like a configuration model switch.
    if (selection.provider === undefined || selection.model === undefined) {
      throw new deps.error('replay_model_pair_required', 'provider and model must be provided together', 400);
    }
    const target = targetReplayModel(deps, snapshot, selection.provider, selection.model);
    const supported = getSupportedThinkingLevels(target);
    const thinkingLevel = selection.thinking_level ?? supported[0] ?? 'off';
    if (!supported.includes(thinkingLevel)) {
      throw new deps.error(
        'replay_thinking_level_unsupported',
        `Thinking level ${thinkingLevel} is not supported by ${selection.provider}/${selection.model}`,
        400,
      );
    }
    model = target;
    effective = { provider: selection.provider, model: selection.model, thinking_level: thinkingLevel };
  } else if (selection.thinking_level !== undefined) {
    if (!isThinkingLevel(selection.thinking_level)) {
      throw new deps.error('replay_thinking_level_invalid', `Unknown thinking level ${selection.thinking_level}`, 400);
    }
    if (!getSupportedThinkingLevels(currentModel).includes(selection.thinking_level)) {
      throw new deps.error(
        'replay_thinking_level_unsupported',
        `Thinking level ${selection.thinking_level} is not supported by ${settings.provider}/${settings.model}`,
        400,
      );
    }
    effective = { ...settings, thinking_level: selection.thinking_level };
  }
  return { ok: true, runtime: { snapshot, settings: effective, model, selection: selectionFlags } };
}

/** Validates one explicit target against the active configuration and its registry. */
export function targetReplayModel(
  deps: ReplayGuardDeps,
  snapshot: InvocationConfigSnapshot,
  provider: string,
  modelId: string,
): Model<Api> {
  if (snapshot.config.providers[provider] === undefined) {
    throw new deps.error('unknown_provider', `Provider ${provider} is not configured`, 400);
  }
  const found = snapshot.models.getModel(provider, modelId);
  if (found === undefined) {
    throw new deps.error('unknown_model', `Model ${provider}/${modelId} is not registered`, 400);
  }
  if (!found.input.includes('text')) {
    throw new deps.error('not_text_capable', `Model ${provider}/${modelId} does not accept text input`, 400);
  }
  return found;
}
