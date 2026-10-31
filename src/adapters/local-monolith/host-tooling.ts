/**
 * Per-invocation tool wiring, shared by the composition root and by tests that
 * need the real thing.
 *
 * One environment assembles every tool an invocation may reach: the primitives
 * live in the runtime, everything else arrives through these factories. The
 * host profile decides what exists per host, the plugins decide what their
 * hosts mount, and the bridge decides per conversation whether an opt-in
 * capability (image generation) is on. Keeping that decision in one place is
 * what makes "the Playground never inherits Telegram-only tools" checkable.
 */
import { createDocumentTools } from '../../capabilities/document-tools.ts';
import { capability, type ExecutableCapability } from '../../capabilities/execute-tool.ts';
import {
  createMemoWriteTools,
  createSaveMemoImageTool,
  type MemoToolEnvironment,
} from '../../context/memo-pad/tools/index.ts';
import type { MemoBlobStore } from '../../context/memo-pad/blobs.ts';
import { MEMO_WRITE_INPUT_MAX_BYTES } from '../../context/memo-pad/index.ts';
import type { MemoPadStore } from '../../context/memo-pad/store.ts';
import type { MediaService } from '../../capabilities/media/index.ts';
import type { McpManager } from '../../capabilities/mcp/index.ts';
import type { StickerService } from '../../capabilities/stickers.ts';
import type { ImageBridge } from '../../image/bridge.ts';
import type { SecretStore } from '../../platform/secrets.ts';

import type { DocSpaces } from '../../platform/doc-spaces.ts';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import type { SkillVisibilityTarget, SystemSkill } from '../../platform/system-resources.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { LoadedPlugins } from '../../plugins/plugin.ts';
import type {
  AgentRuntimeOptions,
  CapabilityToolFactory,
  ToolFactory,
} from '../../orchestration/agent-runtime/types.ts';

export interface HostToolingOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly plugins: LoadedPlugins;
  readonly media: MediaService;
  readonly memoPad: MemoPadStore;
  readonly memoBlobs: MemoBlobStore;
  /**
   * The sticker worker of the moment. Read per invocation because the index
   * follows the Telegram instance: it is absent while Telegram is stopped and a
   * connected instance makes it available without rebuilding the tool wiring.
   */
  readonly stickers?: () => StickerService | undefined;
  /** Absent when this process serves no MCP servers at all. */
  readonly mcp?: McpManager;
  readonly tasks: LongTaskService;
  /** Absent when this process ships no documentation spaces at all. */
  readonly docSpaces?: DocSpaces;
  /** Absent when the process runs without image generation. */
  readonly imageBridge?: ImageBridge;
  /** Resolves capability credentials (web search) at call time. */
  readonly secrets?: SecretStore;
}

export interface HostTooling {
  /** Runtime-internal capabilities, reachable through the `execute` primitive. */
  readonly capabilityTools: CapabilityToolFactory;
  /** Tools exposed directly, today the allowlisted MCP set. */
  readonly additionalTools: ToolFactory;
  /** Whether one skill is part of one conversation's index. */
  readonly skillVisible: (skill: SystemSkill, target: SkillVisibilityTarget) => boolean;
}

export function createHostTooling(options: HostToolingOptions): HostTooling {
  const {
    store,
    configStore,
    plugins,
    media,
    memoPad,
    memoBlobs,
    stickers,
    mcp,
    tasks,
    docSpaces,
    imageBridge,
    secrets,
  } = options;
  const skillVisible = (skill: SystemSkill, target: SkillVisibilityTarget): boolean => {
    if (hostExecutionProfile(target.hostKind).hiddenSkills.includes(skill.name)) {
      return false;
    }
    const hosts = plugins.skillHosts.get(skill.name);
    if (hosts !== undefined && !hosts.includes(target.hostKind)) {
      return false;
    }
    // A plugin whose availability depends on configuration hides its skills in
    // the same breath as its capabilities; the index is what the model reads.
    if (!plugins.skillAvailable(skill.name, configStore.current().config)) {
      return false;
    }
    return skill.name !== 'image-generation' || (imageBridge?.enabledFor(target.conversationId) ?? false);
  };
  const capabilityTools: CapabilityToolFactory = (context, deadline, capabilities, live) => {
    const profile = hostExecutionProfile(context.hostKind);
    const tools: ExecutableCapability[] = [];
    if (profile.mediaRead) {
      tools.push(capability(media.createReadImageTool(context, capabilities, deadline, memoBlobs), false));
    }
    const currentStickers = stickers?.();
    if (profile.stickers && currentStickers !== undefined) {
      tools.push(capability(currentStickers.createSearchTool(context, capabilities), false));
    }
    const memoEnvironment: MemoToolEnvironment = {
      store,
      memoPad,
      blobs: memoBlobs,
      context,
      configStore,
      capabilities,
      prepareImage: (mediaId, signal) => media.prepareSceneImage(mediaId, signal),
    };
    tools.push(
      ...createMemoWriteTools(memoEnvironment).map((tool) =>
        capability(tool, true, tool.name === 'delete_memo' ? {} : { inputMaxBytes: MEMO_WRITE_INPUT_MAX_BYTES }),
      ),
    );
    tools.push(capability(createSaveMemoImageTool(memoEnvironment), true));
    if (docSpaces !== undefined) {
      tools.push(...createDocumentTools({ store, spaces: docSpaces, context }).map((tool) => capability(tool, false)));
    }
    tools.push(
      ...plugins.capabilities(
        store,
        configStore.current().config,
        context,
        deadline,
        tasks,
        capabilities.resolveMedia,
        {
          readConfig: () => configStore.current().config,
          ...(secrets === undefined ? {} : { secrets }),
          ...(live?.steer === undefined ? {} : { steer: live.steer }),
        },
      ),
    );
    return tools;
  };
  const additionalTools: ToolFactory = (context, deadline) =>
    mcp === undefined || !hostExecutionProfile(context.hostKind).mcp ? [] : [...mcp.createTools(context, deadline)];
  return { capabilityTools, additionalTools, skillVisible };
}

/**
 * The send pipeline's view of generated pictures: authorized by the
 * generation's owning conversation, read from the archive with their real
 * media type. Hosts that store the bytes themselves need the type; a wire host
 * re-derives it from the payload.
 */
export function imageDeliveryResolver(bridge: ImageBridge): NonNullable<AgentRuntimeOptions['imageGeneration']> {
  return {
    resolve: (generationId, conversationId) => {
      const outputs = bridge.sendableOutputs(generationId, conversationId);
      if (outputs === undefined) {
        return undefined;
      }
      return outputs.map((output) => {
        const content = bridge.assetContent(output.asset_id);
        return { assetId: output.asset_id, bytes: content.bytes, fileName: output.file_name, mime: content.mime };
      });
    },
  };
}
