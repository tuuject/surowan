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
import type { MediaService } from '../../capabilities/media/media.ts';
import type { McpManager } from '../../capabilities/mcp.ts';
import type { StickerService } from '../../capabilities/stickers.ts';
import { createMemoryTools, type MemoryStore } from '../../context/memory.ts';
import type { ImageBridge } from '../../image/bridge.ts';

import type { DocSpaces } from '../../platform/doc-spaces.ts';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import type { SkillVisibilityTarget, SystemSkill } from '../../platform/system-resources.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { LongTaskService } from '../../store/long-tasks.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { LoadedPlugins } from '../../plugins/plugin.ts';
import type {
  AgentRuntimeOptions,
  CapabilityToolFactory,
  ToolFactory,
} from '../../orchestration/agent-runtime-types.ts';

export interface HostToolingOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly plugins: LoadedPlugins;
  readonly media: MediaService;
  readonly memory: MemoryStore;
  /** Absent when this process runs without the sticker index at all. */
  readonly stickers?: StickerService;
  /** Absent when this process serves no MCP servers at all. */
  readonly mcp?: McpManager;
  readonly tasks: LongTaskService;
  /** Absent when this process ships no documentation spaces at all. */
  readonly docSpaces?: DocSpaces;
  /** Absent when the process runs without image generation. */
  readonly imageBridge?: ImageBridge;
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
  const { store, configStore, plugins, media, memory, stickers, mcp, tasks, docSpaces, imageBridge } = options;
  const skillVisible = (skill: SystemSkill, target: SkillVisibilityTarget): boolean => {
    if (hostExecutionProfile(target.hostKind).hiddenSkills.includes(skill.name)) {
      return false;
    }
    const hosts = plugins.skillHosts.get(skill.name);
    if (hosts !== undefined && !hosts.includes(target.hostKind)) {
      return false;
    }
    // Never advertise a capability that is not registered.
    if (skill.name === 'web-search') {
      const settings = configStore.current().config.web_search;
      if (settings === undefined || settings.enabled === false) {
        return false;
      }
    }
    return skill.name !== 'image-generation' || (imageBridge?.enabledFor(target.conversationId) ?? false);
  };
  const capabilityTools: CapabilityToolFactory = (context, deadline, capabilities) => {
    const profile = hostExecutionProfile(context.hostKind);
    const tools: ExecutableCapability[] = [];
    if (profile.mediaRead) {
      tools.push(capability(media.createReadImageTool(context, capabilities, deadline), false));
    }
    if (profile.stickers && stickers !== undefined) {
      tools.push(capability(stickers.createSearchTool(context, capabilities), false));
    }
    tools.push(...createMemoryTools(memory, context).map((tool) => capability(tool, true)));
    if (docSpaces !== undefined) {
      tools.push(...createDocumentTools({ store, spaces: docSpaces, context }).map((tool) => capability(tool, false)));
    }
    tools.push(
      ...plugins.capabilities(store, configStore.current().config, context, deadline, tasks, capabilities.resolveMedia),
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
