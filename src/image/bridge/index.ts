import { eq } from 'drizzle-orm';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import { isHostKind } from '../../platform/im-host/identity.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import { chats, conversations, rooms } from '../../store/schema/index.ts';
import type { ImageService } from '../service.ts';
import { createLibrary } from './library.ts';
import { createReconcile } from './reconcile.ts';
import { createSubmission } from './submission.ts';

/**
 * Host-side bridge between the image core and the agent tool surface.
 *
 * The plugin declares `image_generate` and the skill; this object owns
 * everything a stateless plugin must not: media-to-asset input translation,
 * idempotent submission, long-task creation, and completion reconciliation
 * (generation settles → task completes → scheduler delivers a receipt into the
 * conversation, where the model decides whether and what to send). The halves
 * live beside this entry: `submission.ts` (the paid path), `reconcile.ts`
 * (delivery and task settlement), `library.ts` (the agent-facing assets).
 */

/** The image core pieces the bridge halves need; owned by `ImageService`. */
export interface ImageCoreHandle {
  readonly generations: ImageService['core']['generations'];
  readonly images: ImageService['core']['images'];
  readonly config: ImageService['core']['config'];
}

export interface ImageBridgeOptions {
  readonly service: ImageService;
  readonly store: BusinessStore;
  readonly tasks: LongTaskService;
  /**
   * Whether one generation may execute in this process. The composition root
   * supplies it when a host it serves may not act right now (Telegram stopped,
   * connecting or misconfigured), so work that belongs to that host stays
   * queued instead of running without a transport. Absent means every
   * generation may run.
   */
  readonly eligible?: (generation: { readonly id: string; readonly actorId: string }) => boolean;
  /** Prepares a stored media row (conversation media) as generation input. */
  readonly prepareInputImage: (
    mediaId: bigint,
    signal: AbortSignal,
  ) => Promise<{ readonly base64: string; readonly mime: string }>;
}

export function createImageBridge(options: ImageBridgeOptions) {
  const { service, store, tasks } = options;
  const core: ImageCoreHandle = service.core;

  function enabled(): boolean {
    return core.config.hasValidConfig();
  }

  /**
   * Whether this conversation may submit new generations.
   *
   * Telegram spends under the global image configuration alone. A Playground
   * room is opt-in per room: turning the switch off only blocks new
   * submissions, so an accepted generation keeps running and its receipt still
   * arrives. An unknown conversation authorizes nothing.
   */
  function enabledFor(conversationId: bigint): boolean {
    if (!enabled()) {
      return false;
    }
    const row = store.orm
      .select({ hostKind: chats.hostKind, chatId: chats.id })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(eq(conversations.id, conversationId))
      .get();
    if (row === undefined) {
      return false;
    }
    if (!isHostKind(row.hostKind)) {
      return false;
    }
    switch (hostExecutionProfile(row.hostKind).chatSource) {
      case 'config':
        return true;
      case 'room':
        return (
          store.orm.select({ imageEnabled: rooms.imageEnabled }).from(rooms).where(eq(rooms.chatId, row.chatId)).get()
            ?.imageEnabled === true
        );
    }
  }

  /** Whether this process may execute one generation at all. */
  function canExecute(generation: { readonly id: string; readonly actorId: string }): boolean {
    return options.eligible?.(generation) ?? true;
  }

  const submission = createSubmission({
    core,
    tasks,
    enabledFor,
    prepareInputImage: options.prepareInputImage,
  });
  const reconcileHalf = createReconcile({ core, store, tasks, canExecute });
  const library = createLibrary({ core });

  const unsubscribe = service.core.onFinished((generationId) => {
    try {
      reconcileHalf.reconcileOne(generationId);
    } catch {
      // Listener errors are logged inside the core; reconciliation is retried
      // by the next explicit reload/reconcile call.
    }
  });

  function stop(): void {
    unsubscribe();
  }

  return {
    enabled,
    enabledFor,
    submit: submission.submit,
    sendableOutputs: reconcileHalf.sendableOutputs,
    assetContent: reconcileHalf.assetContent,
    reconcile: reconcileHalf.reconcile,
    stop,
    /** The live model directory shared by Agent discovery and Admin views; no credentials. */
    modelList: () => core.config.publicModels(),
    agentAssets: library.agentAssets,
    agentAsset: library.agentAsset,
    agentAssetLibrary: library.agentAssetLibrary,
  };
}

export type ImageBridge = ReturnType<typeof createImageBridge>;
