import type { GenerationStatus } from '@surowan/image-service';
import type { InvocationQuota } from '../../store/long-tasks/quota.ts';

/** Shared constants of the bridge's submission and reconciliation halves. */

/**
 * Generations one invocation may have in progress at once. A settled
 * generation frees its slot, so a user revising a picture round after round
 * inside one long invocation never runs out; only a burst of parallel submits
 * is held back until a receipt arrives.
 */
export const IMAGE_INVOCATION_QUOTA: InvocationQuota = { max: 3, counts: 'waiting' };

export const RECEIPT_PROMPT_PREVIEW_LENGTH = 200;

/** Receipt payload; snake_case matches the tool surface the model already sees. */
export interface SendableOutput {
  readonly asset_id: string;
  readonly file_name: string;
  readonly mime: string;
}

export interface GenerationDelivery {
  readonly generation_id: string;
  readonly status: GenerationStatus;
  readonly model_id: string;
  readonly prompt_preview: string;
  readonly outputs: readonly SendableOutput[];
  readonly error: string | null;
}
