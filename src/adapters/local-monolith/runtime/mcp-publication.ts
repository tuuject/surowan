/**
 * The MCP side of the running process: one publication object per process.
 *
 * The composition root builds it once and hands it three entry points — the
 * reloader's per-model candidate check, the manager's registry validator, and
 * the serialized cutover a publish runs. Keeping them together is what makes the
 * "which models must fit which per-Chat set" rule and the cutover's own state
 * live in one place instead of inline in `serve-run.ts`.
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import type { McpManager } from '../../../capabilities/mcp/index.ts';
import type { McpConfigPublishResult, McpCutover, McpCutoverDeps } from './mcp-cutover/shared.ts';
import { createMcpCutover } from './mcp-cutover/index.ts';
import type { AgentRuntime } from '../../../orchestration/agent-runtime/index.ts';
import type { ConversationRuntime } from '../../../orchestration/conversation-runtime.ts';
import type { HostReadiness } from '../../../orchestration/host-scope.ts';
import type { BucketScheduler } from '../../../orchestration/scheduler/index.ts';
import type { RawConfig } from '../../../platform/config/index.ts';
import type { InvocationContext } from '../../../platform/invocation-context.ts';
import { configuredAgentModels, modelsForTelegramChats } from '../../../platform/providers.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import type { BusinessStore } from '../../../store/store.ts';

export interface McpPublicationOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly scheduler: BucketScheduler;
  readonly conversationRuntime: ConversationRuntime;
  readonly isHostReady: HostReadiness;
  readonly mcp: McpManager;
  readonly runtime: AgentRuntime;
  /** The tool registry validation context; it never authorizes an invocation. */
  readonly preview: InvocationContext;
}

export interface McpPublication {
  /**
   * The reloader's candidate check. Each Chat gets its own MCP tool set, so a
   * model only has to fit the sets its own Chats resolve to; the base registry
   * is checked on its own first, because a configuration without Chats still
   * runs Playground work.
   */
  validateModel(config: RawConfig, model: Model<Api>): void;
  /**
   * The manager's registry validator plus the startup base-registry check: the
   * no-MCP tool set must fit every configured model, including one no Telegram
   * Chat uses (Playground rooms run on it).
   */
  validateRegistry(): void;
  /** Runs the serialized cutover for one published configuration. */
  publish(
    previous: RawConfig,
    next: RawConfig,
    generation: number,
    rotated?: ReadonlySet<string>,
  ): Promise<McpConfigPublishResult>;
}

export function createMcpPublication(options: McpPublicationOptions): McpPublication {
  const { configStore, conversationRuntime, isHostReady, mcp, preview, runtime, scheduler, secrets, store } = options;
  // One serialized MCP cutover for the process lifetime: a handed-off cutover
  // keeps its fences up, so the next publish must wait for it to finish before
  // it reconciles anything (see `createMcpCutover`).
  const cutover: McpCutover = createMcpCutover({
    store,
    configStore,
    scheduler,
    isHostReady,
    mcp,
    roundInProgress: (conversationId) => conversationRuntime.isRoundInProgress(conversationId),
    forgetConversation: (conversationId) => conversationRuntime.forget(conversationId),
    redactError: (error) => secrets.redactError(error),
  } satisfies McpCutoverDeps);

  return {
    validateModel(candidate, model) {
      runtime.validateAdditionalTools(preview, [], model);
      for (const toolSet of mcp.toolSets(candidate)) {
        if (modelsForTelegramChats(candidate, [model], toolSet.chatIds).length === 0) {
          continue;
        }
        runtime.validateAdditionalTools(preview, toolSet.tools, model);
      }
    },
    validateRegistry() {
      mcp.setRegistryValidator((mcpTools, chatIds) => {
        const snapshot = configStore.current();
        const models = configuredAgentModels(snapshot.config, snapshot.models).map((entry) => entry.model);
        // Only the models the Chats that resolve to this set can run on: a set a
        // large-context Chat uses must not fail a small-context Chat's server.
        for (const model of modelsForTelegramChats(snapshot.config, models, chatIds)) {
          runtime.validateAdditionalTools(preview, mcpTools, model);
        }
      });
      // The base registry (no MCP tools) must fit every configured model,
      // including one no Telegram Chat uses and a configuration without Chats.
      // The reload path checks the same thing per apply.
      for (const { model } of configuredAgentModels(configStore.current().config, configStore.current().models)) {
        runtime.validateAdditionalTools(preview, [], model);
      }
    },
    async publish(previous, next, generation, rotated = new Set<string>()) {
      // The generation keeps a handed-off cutover from rolling the instances
      // back to its own configuration.
      return await cutover.publish(previous, next, generation, rotated);
    },
  };
}
