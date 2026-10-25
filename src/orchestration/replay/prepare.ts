/**
 * Everything a replay resolves from the live configuration before any model
 * request: the system prompt, the invocation context, the synthetic tool
 * registry and the retained public scene.
 *
 * Split out of `replay.ts`; resolution order and error mapping are unchanged.
 */

import type { ImageContent } from '@earendil-works/pi-ai';
import { createExecuteTool } from '../../capabilities/execute-tool.ts';
import { createReadTool } from '../../capabilities/read-tool.ts';
import { createSendTools } from '../../capabilities/send/index.ts';
import { ContextBuilder, type StablePrompt } from '../../context/builder/index.ts';
import { ContextRefStore } from '../../context/refs.ts';
import { buildSceneContext, type SceneContext } from '../../context/scene/index.ts';
import { SceneSliceError } from '../../context/scene/rows.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import { identityConversation } from '../../platform/im-host/identity.ts';
import { unwiredImHost } from '../../platform/im-host/index.ts';
import { type InvocationContext, unavailableCapabilities } from '../../platform/invocation-context.ts';
import type { SkillVisibilityTarget, SystemResources, SystemSkill } from '../../platform/system-resources.ts';
import type { ReplaySelection } from './index.ts';
import { type ReplayToolRegistry, toolDefinition } from './tools.ts';
import {
  checkReplayRuntime,
  checkReplaySource,
  type ReplayGuardDeps,
  type ReplayRuntime,
  type ReplaySource,
} from './preflight.ts';
import { duplicateSendGuard } from '../../capabilities/send/support.ts';

/**
 * Live dependencies of a replay: the same store, config source and scene tools
 * `ReplayRunner` was constructed with, read through these references and never
 * copied, plus `ReplayError` injected to keep the module graph acyclic.
 */
export interface ReplayPrepareDeps extends ReplayGuardDeps {
  readonly systemResources: SystemResources;
  readonly toolDefinitions?: (context: InvocationContext, config: RawConfig) => ReplayToolRegistry;
  readonly skillVisibility?: (skill: SystemSkill, target: SkillVisibilityTarget) => boolean;
  readonly imageLoader?: (mediaId: bigint, signal: AbortSignal) => Promise<ImageContent>;
}

/** Everything `run` and `inspect` need from the current configuration, resolved once. */
export interface ReplayPrepared {
  readonly source: ReplaySource;
  readonly runtime: ReplayRuntime;
  readonly stable: StablePrompt;
  readonly scene: SceneContext;
  readonly registry: ReplayToolRegistry;
}

export function prepareReplay(deps: ReplayPrepareDeps, id: bigint, selection: ReplaySelection = {}): ReplayPrepared {
  if (
    selection.before_send_id !== undefined &&
    (!/^[1-9]\d{0,18}$/.test(selection.before_send_id) || BigInt(selection.before_send_id) > 9_223_372_036_854_775_807n)
  ) {
    throw new deps.error('invalid_before_send_id', 'before_send_id must be a positive 64-bit decimal ID', 400);
  }
  const check = checkReplaySource(deps, id);
  if (!check.ok) {
    throw new deps.error(check.code, check.message);
  }
  const checkedRuntime = checkReplayRuntime(deps, check.source, selection);
  if (!checkedRuntime.ok) {
    throw new deps.error(checkedRuntime.code, checkedRuntime.message);
  }
  const runtime = checkedRuntime.runtime;
  const config = runtime.snapshot.config;
  const builder = new ContextBuilder(
    deps.store,
    new ContextRefStore(deps.store, { ttlHours: () => config.agent.context.ref_ttl_hours }),
    deps.systemResources.skills,
  );
  const stable = builder.buildSystemPrompt(
    config,
    builder.identity(config, id),
    runtime.model.input.includes('image'),
    { provider: runtime.model.provider, model: runtime.model.id },
    {
      imageInput: 'on_demand',
      ...(deps.skillVisibility === undefined
        ? {}
        : {
            skillFilter: (skill: SystemSkill) =>
              deps.skillVisibility?.(skill, {
                hostKind: 'telegram',
                conversationId: check.source.conversationId,
              }) ?? true,
          }),
    },
  );
  const context: InvocationContext = {
    invocationId: id,
    hostKind: 'telegram',
    ...check.source,
    systemPrompt: stable.systemPrompt,
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: null,
    completion: null,
    omittedNewMessages: 0,
  };
  const registry = deps.toolDefinitions?.(context, config) ?? defaultRegistry(deps, context, config);
  let scene: SceneContext;
  try {
    scene = buildSceneContext(deps.store, config, id, {
      contextWindow: runtime.model.contextWindow,
      maxOutputTokens: runtime.model.maxTokens,
      toolDefinitionCharacters: stable.systemPrompt.length + JSON.stringify(registry.tools.map(toolDefinition)).length,
      supportsImages: runtime.model.input.includes('image') && deps.imageLoader !== undefined,
      ...(selection.before_send_id === undefined ? {} : { beforeSendId: BigInt(selection.before_send_id) }),
    });
  } catch (error) {
    if (error instanceof SceneSliceError) {
      throw new deps.error(error.code, error.message);
    }
    if (error instanceof Error && error.message.includes('unavailable')) {
      throw new deps.error('replay_scene_unavailable', 'The invocation has no retained public opening messages');
    }
    throw new deps.error('replay_scene_invalid', 'The retained public chat scene is invalid or unsupported');
  }
  return { source: check.source, runtime, stable, scene, registry };
}

function defaultRegistry(deps: ReplayPrepareDeps, context: InvocationContext, config: RawConfig): ReplayToolRegistry {
  const { send, sendReply } = createSendTools({
    store: deps.store,
    context,
    host: unwiredImHost('telegram', 'No production executor is wired'),
    // Unused: the host above refuses every delivery, so this only has to be
    // well-formed enough to validate tool arguments.
    conversation: identityConversation(context, 'telegram', 'private'),
    capabilities: unavailableCapabilities(),
    sendRateLimit: { sendsPerWindow: 1, windowSeconds: 1 },
    maxTextLength: config.agent.send_max_text_length,
    disallowBlankLines: config.agent.send_disallow_blank_lines === true,
    allowReplyMessageMultipleTimes: config.agent.allow_reply_message_multiple_times === true,
    ...duplicateSendGuard(config.agent.send_duplicate_guard_enabled),
    deadline: Number.MAX_SAFE_INTEGER,
    bot: { id: 0n, displayName: '', username: null },
  });
  return {
    tools: [
      createReadTool({ store: deps.store, context, resources: deps.systemResources }),
      send,
      sendReply,
      createExecuteTool({
        capabilities: [],
        audit: { start: () => ({ succeed: () => {}, fail: () => {} }), reject: () => {} },
      }),
    ].map(toolDefinition),
    capabilities: [],
  };
}
