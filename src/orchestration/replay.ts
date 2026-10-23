import type { ImageContent, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { KeyedSemaphore } from '../platform/concurrency.ts';
import type { RawConfig } from '../platform/config.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SkillVisibilityTarget, SystemResources, SystemSkill } from '../platform/system-resources.ts';
import type { BusinessStore } from '../store/store.ts';
import { PREFLIGHT_FIDELITY, sceneMetadata } from './replay/preflight.ts';
import { prepareReplay } from './replay/prepare.ts';
import { type ReplayBusy, type ReplayRunDeps, runReplay } from './replay/run.ts';
import type { ReplayToolRegistry } from './replay-tools.ts';

export class ReplayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface ReplayOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly systemResources: SystemResources;
  readonly modelGate: KeyedSemaphore;
  readonly shutdownSignal: AbortSignal;
  readonly toolDefinitions?: (context: InvocationContext, config: RawConfig) => ReplayToolRegistry;
  readonly skillVisibility?: (skill: SystemSkill, target: SkillVisibilityTarget) => boolean;
  readonly imageLoader?: (mediaId: bigint, signal: AbortSignal) => Promise<ImageContent>;
}

/** Prompt and model overrides for one scene test; absent means the current layer or Chat settings are kept. */
export interface ReplayPromptOverrides extends ReplaySelection {
  readonly global_prompt?: string;
  readonly group_prompt?: string;
}

/** Optional model-selection fields of one replay; absent fields inherit the current Chat settings. */
export interface ReplayModelSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking_level?: ModelThinkingLevel;
}

/** The read-only selection a preflight accepts: no prompt overrides. */
export interface ReplaySelection extends ReplayModelSelection {
  readonly before_send_id?: string;
}

/**
 * What a caller can learn about a replay before running one. `fidelity` mirrors
 * the run result's own fidelity block for the checks that happen before any
 * model request; the fields that only exist after a run are not invented here.
 */
export interface ReplayPreflight {
  readonly available: boolean;
  readonly reason: string | null;
  readonly message: string | null;
  readonly prompt_overrides_available: boolean;
  readonly omitted_images: number | null;
  readonly scene?: ReturnType<typeof sceneMetadata>;
  /** The effective model when any model-selection field was given; absent inherits the current Chat settings. */
  readonly model?: {
    readonly provider: string;
    readonly id: string;
    readonly thinking_level: ModelThinkingLevel;
  };
  readonly fidelity: {
    readonly input: 'historical_public_chat';
    readonly model_selection: 'current_chat_config' | 'temporary_override';
    readonly prompt_selection: 'current_chat_config';
    readonly tool_selection: 'current_registry';
    readonly hot_injections: 'not_replayed' | 'flattened_before_send';
    readonly external_tools: 'blocked';
    readonly system_resources: 'current_read_only';
    readonly side_effects: 'synthetic';
  };
}

/** Active global/group templates; runtime-owned layers remain read-only. */
export interface ReplayPrompts {
  readonly source: 'active';
  readonly source_invocation_id: string;
  readonly global_prompt: string;
  readonly group_prompt: string;
  readonly template_values: {
    readonly agent: { readonly provider: string; readonly model: string };
    readonly vision: { readonly provider: string; readonly model: string };
    readonly timezone: string;
  };
  readonly core_read_only: true;
}

/** A fresh in-memory Pi loop. It never receives production tool executors or context writers. */
export class ReplayRunner {
  // ponytail: one replay at a time; add a separate bounded queue only if interactive demand requires it.
  readonly #busy: ReplayBusy = { running: false };
  /**
   * The store, config source, secrets and scene tools this runner was
   * constructed with, plus the injected `ReplayError`, all shared by reference.
   */
  readonly #deps: ReplayRunDeps;

  constructor(options: ReplayOptions) {
    this.#deps = { ...options, busy: this.#busy, error: ReplayError };
  }

  /**
   * The read-only preflight for one invocation: the same source and runtime
   * guards `run` applies, resolved without any model request. A missing
   * invocation still throws; every other failure is reported in the result so a
   * panel or CLI can explain it.
   */
  inspect(id: bigint, selection: ReplaySelection = {}): ReplayPreflight {
    const modelSelected =
      selection.provider !== undefined || selection.model !== undefined || selection.thinking_level !== undefined;
    try {
      const { scene, runtime } = prepareReplay(this.#deps, id, selection);
      return {
        available: true,
        reason: null,
        message: null,
        prompt_overrides_available: true,
        omitted_images: scene.omittedImages,
        fidelity: {
          ...PREFLIGHT_FIDELITY,
          model_selection: modelSelected ? 'temporary_override' : 'current_chat_config',
          hot_injections: scene.slice === undefined ? 'not_replayed' : 'flattened_before_send',
        },
        scene: sceneMetadata(scene),
        ...(modelSelected
          ? {
              model: {
                provider: runtime.model.provider,
                id: runtime.model.id,
                thinking_level: runtime.settings.thinking_level,
              },
            }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof ReplayError) || error.status === 404) {
        throw error;
      }
      return {
        available: false,
        reason: error.code,
        message: error.message,
        prompt_overrides_available: false,
        omitted_images: null,
        fidelity: {
          ...PREFLIGHT_FIDELITY,
          model_selection: modelSelected ? 'temporary_override' : 'current_chat_config',
        },
      };
    }
  }

  prompts(id: bigint): ReplayPrompts {
    const { stable } = prepareReplay(this.#deps, id);
    return {
      source: 'active',
      source_invocation_id: id.toString(),
      global_prompt: stable.promptLayers.global,
      group_prompt: stable.promptLayers.group,
      template_values: stable.templateValues,
      core_read_only: true,
    };
  }

  async run(id: bigint, override: ReplayPromptOverrides, requestSignal: AbortSignal) {
    return await runReplay(this.#deps, id, override, requestSignal);
  }
}
